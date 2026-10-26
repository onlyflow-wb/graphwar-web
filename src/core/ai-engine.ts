// Runs computer players away from the UI thread's code path: this file has no DOM/Worker globals so it can be unit-tested
// in-process; src/core/ai-worker.ts wires it to a real Worker. State needed by the AI is passed as a plain snapshot
// (it does not change while the computer is thinking: the world is frozen during its turn).
import { GameState } from './constants';
import { ComputerBrain, type AiView } from './ai';
import { Player } from './entities';
import type { Rng } from './rng';
import { Terrain } from './terrain';

export interface SnapPlayer {
  id: number; team: number; numSoldiers: number; currentTurnSoldier: number;
  soldiers: { x: number; y: number; angle: number; alive: boolean }[];
}
export interface AiSnapshot {
  gameMode: number; circles: number[]; explosions: number[]; currentTurn: number; players: SnapPlayer[]; remainingMs: number;
}
export type AiIn =
  | { t: 'think'; token: number; playerId: number; level: number; snap: AiSnapshot }
  | { t: 'stop'; playerId: number };
export type AiOut = { t: 'fire'; token: number; playerId: number; angle: number; func: string };

/** plain-data copy of everything the AI looks at */
export function takeSnapshot(g: AiView): AiSnapshot {
  const t = g.terrain;
  return {
    gameMode: g.gameMode, circles: t ? [...t.circles] : [], explosions: t ? [...t.explosions] : [], currentTurn: g.currentTurn,
    remainingMs: g.remainingTime(),
    players: g.players.map(p => ({
      id: p.id, team: p.team, numSoldiers: p.numSoldiers, currentTurnSoldier: p.currentTurnSoldier,
      soldiers: p.soldiers.map(s => ({ x: s.x, y: s.y, angle: s.angle, alive: s.alive })),
    })),
  };
}

/** circles + every explosion so far -> the same solid-mask the game has */
export function buildTerrain(circles: number[], explosions: number[]): Terrain {
  const t = new Terrain(circles);
  for (let i = 0; i + 2 < explosions.length; i += 3) { t.setExplosion(explosions[i], explosions[i + 1], explosions[i + 2]); t.explodePoint(); }
  return t;
}

class SnapshotView implements AiView {
  players: Player[] = [];
  terrain: Terrain | null = null;
  gameMode = 0;
  currentTurn = -1;
  gameState = GameState.GAME;
  token = 0;
  private deadline = 0;
  private angle = 0;
  constructor(private playerId: number, private now: () => number, private post: (m: AiOut) => void) {}

  load(s: AiSnapshot, token: number) {
    this.token = token;
    this.gameMode = s.gameMode; this.currentTurn = s.currentTurn;
    this.deadline = this.now() + s.remainingMs;
    this.terrain = buildTerrain(s.circles, s.explosions);
    this.players = s.players.map(sp => {
      const p = new Player('', sp.id, sp.team, false, sp.numSoldiers, true);
      p.currentTurnSoldier = sp.currentTurnSoldier;
      sp.soldiers.forEach((so, i) => { const d = p.soldiers[i]; if (d) { d.x = so.x; d.y = so.y; d.angle = so.angle; d.alive = so.alive; } });
      return p;
    });
  }
  remainingTime() { return Math.max(0, this.deadline - this.now()); }
  setAngle(a: number) { this.angle = a; }
  sendFunction(text: string) { this.post({ t: 'fire', token: this.token, playerId: this.playerId, angle: this.angle, func: text }); return true; }
}

export class AiEngine {
  private brains = new Map<number, { brain: ComputerBrain; view: SnapshotView }>();
  constructor(private post: (m: AiOut) => void, private now: () => number = () => performance.now(), private rng?: Rng) {}

  handle(m: AiIn) {
    if (m.t === 'stop') { this.brains.get(m.playerId)?.brain.stopThinkFunction(); return; }
    let e = this.brains.get(m.playerId);
    if (!e) {
      const view = new SnapshotView(m.playerId, this.now, this.post);
      view.load(m.snap, m.token);
      const me = view.players.find(p => p.id === m.playerId);
      if (!me) return;
      e = { view, brain: new ComputerBrain(me, view, m.level, this.rng) };
      this.brains.set(m.playerId, e);
    } else {
      // the population evolved so far is kept (as in the original); only the world and the player's own record are replaced
      e.view.load(m.snap, m.token);
      const me = e.view.players.find(p => p.id === m.playerId);
      if (!me) return;
      e.brain.setPlayer(me);
    }
    e.brain.thinkFunction();
  }
}
