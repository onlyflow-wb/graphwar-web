// Main-thread side of the computer players. By default the genetic algorithm runs in a Web Worker; if Workers are not
// available (or fail), or a seeded RNG is injected (tests), the in-thread ComputerBrain is used instead.
import { GameState } from './constants';
import { ComputerBrain, type AiView, type Thinker } from './ai';
import { takeSnapshot, type AiIn, type AiOut } from './ai-engine';
import type { Player } from './entities';
import type { Rng } from './rng';

interface Transport { postMessage(m: AiIn): void; terminate(): void; onmessage: ((e: { data: AiOut }) => void) | null; onerror: ((e: unknown) => void) | null }

export class AiLink {
  private token = 0;
  private active = new Map<number, { game: AiView; token: number; fallback?: ComputerBrain }>();
  broken = false;
  constructor(private tr: Transport, private onBroken: (reason: string) => void = r => console.warn(r)) {
    tr.onmessage = e => this.onFire(e.data);
    tr.onerror = () => this.fail('AI worker failed; computer players now run on the main thread.');
  }

  think(player: Player, game: AiView, level: number) {
    if (this.broken) return;
    const token = ++this.token;
    this.active.set(player.id, { game, token });
    this.tr.postMessage({ t: 'think', token, playerId: player.id, level, snap: takeSnapshot(game) });
  }
  stop(playerId: number) {
    this.active.delete(playerId);
    if (!this.broken) this.tr.postMessage({ t: 'stop', playerId });
  }

  private onFire(m: AiOut) {
    const a = this.active.get(m.playerId);
    // drop results that belong to an older turn, or arrive after the game moved on
    if (!a || a.token !== m.token) return;
    const g = a.game;
    if (g.gameState !== GameState.GAME || g.players[g.currentTurn]?.id !== m.playerId) return;
    this.active.delete(m.playerId);
    g.setAngle(m.angle);
    g.sendFunction(m.func);
  }

  private fail(reason: string) {
    if (this.broken) return;
    this.broken = true;
    this.onBroken(reason);
    this.tr.terminate();
  }
}

let shared: AiLink | null | undefined;
function sharedLink(): AiLink | null {
  if (shared !== undefined) return shared;
  try {
    if (typeof Worker === 'undefined') return (shared = null);
    if (typeof location !== 'undefined' && /[?&]ai=main\b/.test(location.search)) return (shared = null); // debug/benchmark switch
    const w = new Worker(new URL('./ai-worker.ts', import.meta.url), { type: 'module' });
    shared = new AiLink(w as unknown as Transport);
  } catch { shared = null; }
  return shared;
}

export class WorkerBrain implements Thinker {
  private local: ComputerBrain | null = null;
  constructor(private player: Player, private game: AiView, private level: number, private link: AiLink) {}
  thinkFunction() {
    if (this.link.broken) {
      this.local ??= new ComputerBrain(this.player, this.game, this.level);
      this.local.thinkFunction();
    } else this.link.think(this.player, this.game, this.level);
  }
  stopThinkFunction() { this.local?.stopThinkFunction(); this.link.stop(this.player.id); }
}

/** a seeded rng means "deterministic test": always in-thread */
export function createBrain(player: Player, game: AiView, level: number, rng?: Rng): Thinker {
  const link = rng ? null : sharedLink();
  return link ? new WorkerBrain(player, game, level, link) : new ComputerBrain(player, game, level, rng);
}
