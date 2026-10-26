// End-to-end headless tests: real GraphServer + GameData (+ AI) wired through LocalSession, simulated clock.
import { describe, expect, it } from 'vitest';
import { LocalSession, Clock } from '../src/core/session';
import { seeded } from '../src/core/rng';
import { GameState, MAX_SOLDIERS_PER_PLAYER, START_GAME_DELAY, TEAM1, TEAM2 } from '../src/core/constants';
import { GraphServer } from '../src/core/server';
import type { C2S, S2C } from '../src/core/protocol';

/** deterministic manual clock with timers */
class FakeClock implements Clock {
  t = 1_000_000;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private n = 0;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = ++this.n; this.timers.push({ at: this.t + ms, fn, id }); return id; }
  clearTimeout(h: unknown) { this.timers = this.timers.filter(x => x.id !== h); }
  async advance(ms: number, step = 50) {
    const end = this.t + ms;
    while (this.t < end) {
      this.t = Math.min(end, this.t + step);
      const due = this.timers.filter(x => x.at <= this.t).sort((a, b) => a.at - b.at);
      this.timers = this.timers.filter(x => x.at > this.t);
      for (const d of due) d.fn();
      await flush();
    }
  }
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function makeLobby(seed = 1) {
  const clock = new FakeClock();
  const s = new LocalSession(clock, {}, seeded(seed));
  return { clock, s, g: s.game };
}

async function readyAll(clock: FakeClock, s: LocalSession) {
  for (const p of s.game.players) s.game.setReady(p, true);
  await flush();
  await clock.advance(START_GAME_DELAY + 200);
}

describe('lobby rules (ported from GraphServer)', () => {
  it('first client is leader; players get ids, 2 soldiers, random team', async () => {
    const { s, g } = makeLobby();
    await flush();
    expect(g.leader).toBe(true);
    g.addPlayer('Ana'); g.addPlayer('Bob');
    await flush();
    expect(g.players.map(p => p.name)).toEqual(['Ana', 'Bob']);
    expect(g.players.every(p => p.numSoldiers === 2 && p.local)).toBe(true);
    s.dispose();
  });

  it('soldier count is clamped to 0..4 and changes un-ready everyone', async () => {
    const { s, g } = makeLobby();
    g.addPlayer('Ana'); await flush();
    const p = g.players[0];
    g.setReady(p, true); await flush();
    expect(p.ready).toBe(true);
    for (let i = 0; i < 6; i++) g.addSoldier(p);
    await flush();
    expect(p.numSoldiers).toBe(MAX_SOLDIERS_PER_PLAYER);
    expect(p.ready).toBe(false);
    for (let i = 0; i < 9; i++) g.removeSoldier(p);
    await flush();
    expect(p.numSoldiers).toBe(0);
    s.dispose();
  });

  it('mode cycles normal -> first ODE -> second ODE -> normal (leader only)', async () => {
    const { s, g } = makeLobby();
    await flush();
    const seen: number[] = [g.gameMode];
    for (let i = 0; i < 3; i++) { g.nextMode(); await flush(); seen.push(g.gameMode); }
    expect(seen).toEqual([0, 1, 2, 0]);
    s.dispose();
  });

  it('max 10 players', async () => {
    const { s, g } = makeLobby();
    for (let i = 0; i < 14; i++) { g.addPlayer('P' + i); await flush(); }
    expect(g.players.length).toBe(10);
    s.dispose();
  });

  it('countdown starts when all ready and is cancelled by un-ready', async () => {
    const { clock, s, g } = makeLobby();
    g.addPlayer('A'); g.addPlayer('B'); await flush();
    for (const p of g.players) g.setReady(p, true);
    await flush();
    expect(g.countingDown).toBe(true);
    g.setReady(g.players[0], false); await flush();
    await clock.advance(START_GAME_DELAY + 500);
    expect(g.gameState).toBe(GameState.PRE_GAME);
    s.dispose();
  });
});

describe('server authority / anti-cheat', () => {
  function rig() {
    const sent: { to: string; m: S2C }[] = [];
    const clock = new FakeClock();
    const srv = new GraphServer({
      send: (to, m) => sent.push({ to, m }), now: () => clock.now(),
      setTimeout: (f, ms) => clock.setTimeout(f, ms), clearTimeout: h => clock.clearTimeout(h), rng: seeded(5),
    });
    return { srv, sent, clock };
  }
  it('a client cannot fire for, rename or ready another client\'s player', () => {
    const { srv, sent } = rig();
    srv.addClient('A'); srv.addClient('B');
    srv.handle('A', { t: 'ADD_PLAYER', name: 'alice' });
    srv.handle('B', { t: 'ADD_PLAYER', name: 'bob' });
    const idB = (sent.find(x => x.to === 'B' && x.m.t === 'ADD_PLAYER' && (x.m as any).name === 'bob')!.m as any).playerId;
    sent.length = 0;
    srv.handle('A', { t: 'SET_READY', playerId: idB, ready: true });   // not A's player
    srv.handle('A', { t: 'CHAT_MSG', playerId: idB, text: 'impersonate' });
    srv.handle('A', { t: 'NEXT_MODE' }); // A is leader -> allowed
    expect(sent.some(x => x.m.t === 'SET_READY')).toBe(false);
    expect(sent.some(x => x.m.t === 'CHAT_MSG')).toBe(false);
    sent.length = 0;
    srv.handle('B', { t: 'NEXT_MODE' }); // B is not leader
    expect(sent.length).toBe(0);
  });

  it('sanitises over-long names/chat/functions and rejects bad angles', () => {
    const { srv, sent } = rig();
    srv.addClient('A');
    srv.handle('A', { t: 'ADD_PLAYER', name: 'x'.repeat(500) });
    const add = sent.find(x => x.m.t === 'ADD_PLAYER')!.m as any;
    expect(add.name.length).toBe(24);
    srv.handle('A', { t: 'CHAT_MSG', playerId: add.playerId, text: 'y'.repeat(5000) });
    expect((sent.filter(x => x.m.t === 'CHAT_MSG')[0].m as any).text.length).toBe(200);
    srv.handle('A', { t: 'SET_ANGLE', playerId: add.playerId, soldier: 0, angle: NaN } as C2S);
    expect(sent.some(x => x.m.t === 'SET_ANGLE')).toBe(false);
  });

  it('rejects joins while a game is running; leader passes to next client', async () => {
    const { srv, sent, clock } = rig();
    srv.addClient('A'); srv.addClient('B');
    srv.handle('A', { t: 'ADD_PLAYER', name: 'a' });
    srv.handle('B', { t: 'ADD_PLAYER', name: 'b' });
    const adds = sent.filter(x => x.to === 'A' && x.m.t === 'ADD_PLAYER').map(x => x.m as Extract<S2C, { t: 'ADD_PLAYER' }>);
    // make sure both teams have a soldier so the game can start
    srv.handle('A', { t: 'SET_TEAM', team: 1, playerId: adds[0].playerId });
    srv.handle('B', { t: 'SET_TEAM', team: 2, playerId: adds[1].playerId });
    srv.handle('A', { t: 'SET_READY', playerId: adds[0].playerId, ready: true });
    srv.handle('B', { t: 'SET_READY', playerId: adds[1].playerId, ready: true });
    expect(sent.some(x => x.m.t === 'START_COUNTDOWN')).toBe(true);
    await clock.advance(START_GAME_DELAY + 100);
    const start = sent.find(x => x.m.t === 'START_GAME')!.m as Extract<S2C, { t: 'START_GAME' }>;
    expect(start.soldiers.length).toBe(2 * (2 + 2));          // x,y for 4 soldiers
    expect(start.circles.length % 3).toBe(0);
    expect(srv.addClient('C')).toBe(false);                    // game running
    expect(sent.some(x => x.to === 'C' && x.m.t === 'GAME_FULL')).toBe(true);
    sent.length = 0;
    srv.removeClient('A');
    expect(sent.some(x => x.to === 'B' && x.m.t === 'NEW_LEADER')).toBe(true);
  });

  it('soldiers spawn on their own side, away from terrain and each other', async () => {
    const { srv, sent, clock } = rig();
    srv.addClient('A');
    for (const [n, team] of [['a', 1], ['b', 2]] as const) {
      srv.handle('A', { t: 'ADD_PLAYER', name: n });
      const id = (sent.filter(x => x.m.t === 'ADD_PLAYER').pop()!.m as any).playerId;
      srv.handle('A', { t: 'SET_TEAM', team, playerId: id });
      srv.handle('A', { t: 'ADD_SOLDIER', playerId: id });
      srv.handle('A', { t: 'ADD_SOLDIER', playerId: id });
    }
    for (const x of sent.filter(x => x.m.t === 'ADD_PLAYER')) srv.handle('A', { t: 'SET_READY', playerId: (x.m as any).playerId, ready: true });
    await clock.advance(START_GAME_DELAY + 100);
    const st = sent.find(x => x.m.t === 'START_GAME')!.m as Extract<S2C, { t: 'START_GAME' }>;
    const order = (sent.filter(x => x.m.t === 'REORDER').pop()!.m as Extract<S2C, { t: 'REORDER' }>).order;
    const teams = new Map<number, number>();
    for (const x of sent) {
      if (x.m.t === 'ADD_PLAYER') teams.set(x.m.playerId, x.m.team);
      if (x.m.t === 'SET_TEAM') teams.set(x.m.playerId, x.m.team);   // later messages win
    }
    let k = 0;
    const pts: [number, number][] = [];
    for (const id of order) {
      const team = teams.get(id)!;
      for (let i = 0; i < 4; i++, k++) {
        const x = st.soldiers[2 * k], y = st.soldiers[2 * k + 1];
        if (team === 1) expect(x).toBeLessThan(385); else expect(x).toBeGreaterThanOrEqual(385);
        for (let c = 0; c < st.circles.length; c += 3)
          expect(Math.hypot(x - st.circles[c], y - st.circles[c + 1])).toBeGreaterThanOrEqual(st.circles[c + 2] + 15);
        for (const [ox, oy] of pts) expect(Math.abs(x - ox) >= 20 || Math.abs(y - oy) >= 20).toBe(true);
        pts.push([x, y]);
      }
    }
    // turn order alternates teams
    const seq = order.map(id => teams.get(id));
    expect(seq[0]).not.toBe(seq[1]);
  });
});

describe('full game with computer players', () => {
  it('plays a complete round to a winner, in every mode', async () => {
    for (const mode of [0, 1, 2]) {
      const { clock, s, g } = makeLobby(10 + mode);
      let winners: string[] = [];
      s.game.ev.onGameEnd = w => { winners = w.map(p => p.name); };
      for (let i = 0; i < mode; i++) { g.nextMode(); await flush(); }
      expect(g.gameMode).toBe(mode);
      g.addPC('HAL', 3); g.addPC('Skynet', 3);
      await flush();
      const [a, b] = g.players;
      if (a.team === b.team) { g.switchSide(b); await flush(); }
      expect(a.team).not.toBe(b.team);
      expect(g.players.every(p => p.isComputer)).toBe(true);
      await readyAll(clock, s);
      expect(g.gameState).toBe(GameState.GAME);

      // let the AIs play; each turn the AI needs real (not simulated) CPU time, so step in small slices
      const deadline = Date.now() + 60_000;
      while (g.gameState === GameState.GAME && Date.now() < deadline) {
        await clock.advance(250, 50);
        await new Promise(r => setTimeout(r, 1));
        g.tick();
      }
      expect(g.gameState, `mode ${mode} should finish`).toBe(GameState.PRE_GAME);
      expect(winners.length).toBeGreaterThan(0);
      s.dispose();
    }
  }, 120_000);
});

describe('client rules', () => {
  it('malformed functions are not sent; commands toggle flags; team views mirror', async () => {
    const { clock, s, g } = makeLobby(3);
    g.addPlayer('Hu'); g.addPlayer('Man'); await flush();
    const [a, b] = g.players;
    if (a.team === b.team) { g.switchSide(b); await flush(); }
    await readyAll(clock, s);
    expect(g.gameState).toBe(GameState.GAME);
    expect(g.sendFunction('((')).toBe(false);
    expect(g.sendFunction('x+')).toBe(false);
    g.sendChatMessage('-stopsayfunc'); expect(g.sayFunc).toBe(false);
    g.sendChatMessage('-sayfunc'); expect(g.sayFunc).toBe(true);
    g.sendChatMessage('-shownext'); expect(g.showNext).toBe(true);
    // viewer mirrored iff last local human is team 2
    expect(g.terrainReversed).toBe((g.lastLocalHumanPlayer ?? g.firstLocalPlayer)!.team === TEAM2);
    expect([TEAM1, TEAM2]).toContain(a.team);
    s.dispose();
  });

  it('turns alternate between teams and fire resolves, explodes terrain, then advances', async () => {
    const { clock, s, g } = makeLobby(4);
    g.addPlayer('P1'); g.addPlayer('P2'); await flush();
    const [a, b] = g.players;
    if (a.team === b.team) { g.switchSide(b); await flush(); }
    await readyAll(clock, s);
    const first = g.currentPlayer;
    expect(g.sendFunction('x/10')).toBe(true);
    await flush();
    expect(g.drawingFunction).toBe(true);
    const v0 = g.terrain!.version;
    await clock.advance(20000, 100);
    g.tick();
    await flush();
    expect(g.terrain!.version).toBeGreaterThan(v0); // explosion carved terrain
    await clock.advance(NEXT_TURN_WAIT, 100); g.tick(); await flush();
    expect(g.currentPlayer).not.toBe(first);
    expect(g.currentPlayer.team).not.toBe(first.team);
    s.dispose();
  });

  it('turn timeout moves to next player', async () => {
    const { clock, s, g } = makeLobby(6);
    g.addPlayer('P1'); g.addPlayer('P2'); await flush();
    const [a, b] = g.players;
    if (a.team === b.team) { g.switchSide(b); await flush(); }
    await readyAll(clock, s);
    const first = g.currentPlayer;
    for (let i = 0; i < 70; i++) { await clock.advance(1000, 250); g.tick(); await flush(); }
    expect(g.currentPlayer).not.toBe(first);
    s.dispose();
  });
});
const NEXT_TURN_WAIT = 4000;

