// In-process wiring of a GraphServer with local GameData clients (used for "Create Game" / hot-seat / vs computer).
// The online version swaps the in-process routing for Supabase Realtime (see src/net/online.ts).
import { GameData, ClientEvents } from './client';
import type { Thinker } from './ai';
import { createBrain } from './ai-host';
import { C2S, S2C } from './protocol';
import { GraphServer, ServerEnv } from './server';
import type { Player } from './entities';

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: h => clearTimeout(h as number),
};

/** async delivery (microtask) keeps handlers from re-entering each other, like a real socket would */
export class LocalSession {
  server: GraphServer;
  game: GameData;
  brains = new Map<number, Thinker>();
  private clientId = 'local';

  constructor(clock: Clock = realClock, events: ClientEvents = {}, private rng?: import('./rng').Rng) {
    const env: ServerEnv = {
      send: (_id, msg) => queueMicrotask(() => this.game.handle(msg as S2C)),
      now: () => clock.now(),
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: h => clock.clearTimeout(h),
      rng,
    };
    this.server = new GraphServer(env);
    const userTurnStart = events.onTurnStart;
    this.game = new GameData(
      (m: C2S) => queueMicrotask(() => this.server.handle(this.clientId, m)),
      () => clock.now(),
      {
        ...events,
        onTurnStart: p => { userTurnStart?.(p); this.brainFor(p)?.thinkFunction(); },
        onGameEnd: w => { for (const b of this.brains.values()) b.stopThinkFunction(); events.onGameEnd?.(w); },
      },
    );
    this.server.addClient(this.clientId);
  }

  private brainFor(p: Player): Thinker | undefined {
    if (!p.isComputer) return undefined;
    let b = this.brains.get(p.id);
    if (!b) { b = createBrain(p, this.game, p.aiLevel, this.rng); this.brains.set(p.id, b); }
    return b;
  }

  dispose() {
    for (const b of this.brains.values()) b.stopThinkFunction();
    this.server.dispose();
  }
}
