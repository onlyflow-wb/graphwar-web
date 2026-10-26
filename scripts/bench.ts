// Local, reproducible benchmarks (no network, no live services). Run: npm run bench
//  1. computer player: CPU cost of one generation (50 candidate functions) and of a whole turn at several levels
//  2. room list: database reads for N clients polling every 5 s, direct vs through the cache-aside API
//     (real redis-server + the real @upstash/redis client; the database is a mock with fixed latency, so only the
//      READ COUNT is meaningful for the database side; latencies of hits are real local-loopback numbers)
import { performance } from 'node:perf_hooks';
import { GameState } from '../src/core/constants';
import { ComputerBrain, type AiView } from '../src/core/ai';
import { seeded } from '../src/core/rng';
import { SafeCache, upstashCache } from '../api/_lib/cache';
import { DEFAULT_CONFIG, getRooms } from '../api/_lib/rooms-service';
import { scenario } from '../test/helpers';
import { startRedis } from '../test/redis-shim';

const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

async function aiBench() {
  console.log('## computer player (Node, single core, seed fixed)');
  for (const level of [10, 100, 300]) {
    const times: number[] = [];
    for (let rep = 0; rep < 5; rep++) {
      const s = scenario('blocks');
      let fired = false;
      const view: AiView = { players: s.players, terrain: s.terrain, gameMode: 0, currentTurn: 0, gameState: GameState.GAME, remainingTime: () => 60000, setAngle: () => undefined, sendFunction: () => { fired = true; return true; } };
      let busy = 0;
      const brain = new ComputerBrain(s.players[0], view, level, seeded(rep + 1), () => new Promise(r => setImmediate(r)), 1e9);
      const t0 = performance.now();
      brain.thinkFunction();
      while (!fired) { await new Promise(r => setImmediate(r)); }
      busy = performance.now() - t0;
      times.push(busy);
    }
    console.log(`level ${String(level).padStart(4)}: whole turn median ${med(times).toFixed(0)} ms  (~${(med(times) / level).toFixed(1)} ms per generation of 50 shots)`);
  }
}

async function roomsBench() {
  console.log('\n## room list: 100 clients, 5 polling rounds (5 s apart in real life)');
  const clients = 100, rounds = 5, dbLatency = 40;
  const rooms = Array.from({ length: 20 }, (_, i) => ({ code: `R${String(i).padStart(3, '0')}A`.slice(0, 5), name: `Room ${i}`, mode: i % 3, players: i % 10, state: 'waiting' as const }));

  let direct = 0;
  const dbRead = async () => { direct++; await new Promise(r => setTimeout(r, dbLatency)); return rooms; };
  const lat0: number[] = [];
  for (let r = 0; r < rounds; r++) await Promise.all(Array.from({ length: clients }, async () => { const t = performance.now(); await dbRead(); lat0.push(performance.now() - t); }));
  console.log(`direct to database : ${direct} reads, latency median ${med(lat0).toFixed(0)} ms (mock DB latency ${dbLatency} ms)`);

  const redis = await startRedis(56380);
  try {
    let dbReads = 0;
    const fetchRooms = async () => { dbReads++; await new Promise(r => setTimeout(r, dbLatency)); return rooms; };
    const inner = upstashCache(redis.url, redis.token);
    const lat: number[] = []; const seen: Record<string, number> = {};
    for (let r = 0; r < rounds; r++) {
      await Promise.all(Array.from({ length: clients }, async () => {
        const t = performance.now();
        const out = await getRooms(new SafeCache(inner, 800, () => undefined), fetchRooms, DEFAULT_CONFIG);
        lat.push(performance.now() - t); seen[out.source] = (seen[out.source] ?? 0) + 1;
      }));
      await redis.raw('DEL', 'rooms:v1'); // emulate the 5 s TTL elapsing between rounds
    }
    console.log(`through cache API  : ${dbReads} database reads (${direct / dbReads | 0}x fewer), latency median ${med(lat).toFixed(0)} ms, outcomes ${JSON.stringify(seen)}`);
  } finally { await redis.stop(); }
}

await aiBench();
await roomsBench();
