// Tests for the Web Worker AI path (src/core/ai-engine.ts + ai-host.ts). The Worker itself is replaced by an in-process
// transport; real-browser behaviour is covered by scripts/bench-ai-browser.mjs.
import { describe, expect, it } from 'vitest';
import { GameState } from '../src/core/constants';
import { ComputerBrain, type AiView } from '../src/core/ai';
import { AiEngine, buildTerrain, takeSnapshot, type AiIn, type AiOut } from '../src/core/ai-engine';
import { AiLink, WorkerBrain } from '../src/core/ai-host';
import { seeded } from '../src/core/rng';
import { scenario } from './helpers';

class StubGame implements AiView {
  players; terrain; gameMode = 0; currentTurn = 0; gameState = GameState.GAME;
  fired: { angle: number; func: string }[] = [];
  private angle = 0;
  constructor(kind: 'empty' | 'blocks' | 'blasted' = 'blocks') {
    const s = scenario(kind === 'empty' ? 'empty' : 'blocks'); this.players = s.players; this.terrain = s.terrain;
    if (kind === 'blasted') for (const [x, y] of [[385, 100], [330, 330], [200, 150]]) { this.terrain.setExplosion(x, y, 30); this.terrain.explodePoint(); }
  }
  remainingTime() { return 60000; }
  setAngle(a: number) { this.angle = a; }
  sendFunction(f: string) { this.fired.push({ angle: this.angle, func: f }); return true; }
}
const until = async (cond: () => boolean, ms = 5000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 2)); } };

function loop(engineRng?: ReturnType<typeof seeded>) {
  const toMain: AiOut[] = [];
  let main: ((e: { data: AiOut }) => void) | null = null;
  const engine = new AiEngine(m => { toMain.push(m); queueMicrotask(() => main?.({ data: m })); }, () => performance.now(), engineRng);
  const tr = {
    sent: [] as AiIn[],
    postMessage(m: AiIn) { this.sent.push(m); queueMicrotask(() => engine.handle(structuredClone(m))); }, // structuredClone = what a real Worker does
    terminate() { /* noop */ }, onerror: null as ((e: unknown) => void) | null,
    set onmessage(f: ((e: { data: AiOut }) => void) | null) { main = f; }, get onmessage() { return main; },
  };
  return { tr, toMain, engine };
}

describe('snapshot', () => {
  it('is plain cloneable data and rebuilds an identical terrain, including past explosions', () => {
    const g = new StubGame();
    g.terrain!.setExplosion(385, 100, 12); g.terrain!.explodePoint();
    const snap = takeSnapshot(g);
    const copy = structuredClone(snap);
    expect(copy).toEqual(snap);
    expect(snap.explosions).toEqual([385, 100, 12]);
    const rebuilt = buildTerrain(copy.circles, copy.explosions);
    expect(Buffer.from(rebuilt.mask).equals(Buffer.from(g.terrain!.mask))).toBe(true);
    expect(rebuilt.mask.some(v => v === 0)).toBe(true);
    const without = buildTerrain(copy.circles, []);
    expect(Buffer.from(without.mask).equals(Buffer.from(g.terrain!.mask))).toBe(false); // the explosion mattered
  });
});

describe('worker engine = in-thread brain', () => {
  for (const kind of ['blocks', 'empty', 'blasted'] as const) {
    it(`finds exactly the same shot for the same seed (${kind} terrain)`, async () => {
      const g1 = new StubGame(kind);
      const direct = new ComputerBrain(g1.players[0], g1, 4, seeded(7));
      direct.thinkFunction();
      await until(() => g1.fired.length === 1);

      const out: AiOut[] = [];
      const e = new AiEngine(m => out.push(m), () => performance.now(), seeded(7));
      const g2 = new StubGame(kind);
      e.handle({ t: 'think', token: 1, playerId: 0, level: 4, snap: structuredClone(takeSnapshot(g2)) });
      await until(() => out.length === 1);
      expect({ angle: out[0].angle, func: out[0].func }).toEqual(g1.fired[0]);
    });
  }
});

describe('AiLink / WorkerBrain', () => {
  it('delivers the computed shot to the game exactly once, via a structured-clone transport', async () => {
    const { tr } = loop(seeded(3));
    const link = new AiLink(tr);
    const g = new StubGame();
    link.think(g.players[0], g, 3);
    await until(() => g.fired.length > 0);
    await new Promise(r => setTimeout(r, 30));
    expect(g.fired).toHaveLength(1);
    expect(g.fired[0].func.length).toBeGreaterThan(0);
  });

  it('ignores a result that arrives after the turn moved on, or after stop()', async () => {
    const a = loop(seeded(3)), g = new StubGame();
    const link = new AiLink(a.tr);
    link.think(g.players[0], g, 3);
    g.currentTurn = 1;                       // turn passed to someone else before the answer came back
    await until(() => a.toMain.length === 1);
    await new Promise(r => setTimeout(r, 10));
    expect(g.fired).toEqual([]);

    const b = loop(seeded(3)), g2 = new StubGame();
    const link2 = new AiLink(b.tr);
    link2.think(g2.players[0], g2, 3);
    link2.stop(0);
    await until(() => b.toMain.length === 1 || true, 50);
    await new Promise(r => setTimeout(r, 200));
    expect(g2.fired).toEqual([]);

    const c = loop(seeded(3)), g3 = new StubGame();
    const link3 = new AiLink(c.tr);
    link3.think(g3.players[0], g3, 3);
    g3.gameState = GameState.PRE_GAME;       // game ended meanwhile
    await until(() => c.toMain.length === 1);
    await new Promise(r => setTimeout(r, 10));
    expect(g3.fired).toEqual([]);
  });

  it('a stale answer (older token) never fires a newer turn', async () => {
    const { tr } = loop(seeded(3));
    const link = new AiLink(tr);
    const g = new StubGame();
    link.think(g.players[0], g, 1);
    link.think(g.players[0], g, 1);          // second think -> token 2
    // hand-deliver a forged answer carrying token 1
    tr.onmessage!({ data: { t: 'fire', token: 1, playerId: 0, angle: 0, func: 'x' } });
    expect(g.fired).toEqual([]);
  });

  it('an answer already in flight when stop() is called is dropped', () => {
    const { tr } = loop();
    const link = new AiLink(tr);
    const g = new StubGame();
    link.think(g.players[0], g, 1);
    link.stop(0);
    tr.onmessage!({ data: { t: 'fire', token: 1, playerId: 0, angle: 0, func: 'x' } });
    expect(g.fired).toEqual([]);
  });

  it('falls back to the in-thread brain when the worker fails', async () => {
    const { tr } = loop();
    const link = new AiLink(tr, () => undefined);
    tr.onerror!(new Error('boom'));
    expect(link.broken).toBe(true);
    const g = new StubGame();
    new WorkerBrain(g.players[0], g, 2, link).thinkFunction();
    await until(() => g.fired.length === 1);
    expect(tr.sent).toEqual([]);             // nothing was sent to the dead worker
  });
});
