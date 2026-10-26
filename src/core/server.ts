// Port of GraphServer/GraphServer.java (+ ClientConnection/Player). Authoritative game-room logic:
// teams, ready/countdown, level generation, turn order, turn timer, skip votes, leader hand-over.
// Transport-agnostic: it only talks through `send`. In the original this ran on the room creator's PC;
// here it runs in the room host's browser (local games: in the same page).
import {
  INITIAL_NUM_SOLDIERS, MAX_CLIENTS, MAX_PLAYERS, MAX_SOLDIERS_PER_PLAYER, NORMAL_FUNC,
  PLANE_HEIGHT, PLANE_LENGTH, SOLDIER_RADIUS, SOLDIER_SELECTION_RADIUS, START_GAME_DELAY,
  TEAM1, TEAM2, TURN_TIME, GameState,
} from './constants';
import { C2S, LIMITS, S2C } from './protocol';
import { Rng, defaultRng, nextBoolean, nextInt } from './rng';
import { Terrain } from './terrain';

interface SPlayer { id: number; name: string; numSoldiers: number; team: number; ready: boolean }
interface SClient { id: string; leader: boolean; players: SPlayer[]; readyNextTurn: boolean; finished: boolean; skipLevel: boolean }

export interface ServerEnv {
  send(clientId: string, msg: S2C): void;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  rng?: Rng;
}

export class GraphServer {
  private clients: SClient[] = [];
  private players: SPlayer[] = [];
  gameMode = NORMAL_FUNC;
  gameState: GameState = GameState.PRE_GAME;
  private countdown: unknown = null;
  private countingDown = false;
  private timeTurnStarted = 0;
  private lastId = 0;
  private rng: Rng;

  constructor(private env: ServerEnv) { this.rng = env.rng ?? defaultRng; }

  get clientCount() { return this.clients.length; }
  get isFull() { return this.clients.length >= MAX_CLIENTS; }
  get playerCount() { return this.players.length; }

  // ------------------------------------------------------------------ plumbing
  private sendAll(msg: S2C) { for (const c of this.clients) this.env.send(c.id, msg); }

  private addPlayerMsg(p: SPlayer, recipient: SClient, owner: SClient): S2C {
    return { t: 'ADD_PLAYER', playerId: p.id, name: p.name, team: p.team, local: recipient === owner, numSoldiers: p.numSoldiers, ready: p.ready };
  }

  private find(id: number): { p: SPlayer; owner: SClient } | null {
    for (const c of this.clients) for (const p of c.players) if (p.id === id) return { p, owner: c };
    return null;
  }

  /** player may be controlled by the owning client, or by the room leader (mirrors original rules) */
  private findControllable(id: number, client: SClient) {
    const f = this.find(id);
    if (!f) return null;
    if (f.owner === client || client.leader) return f;
    return null;
  }

  private ownsPlayer(id: number, client: SClient) { return client.players.some(p => p.id === id); }

  // ------------------------------------------------------------------ connections
  addClient(id: string): boolean {
    if (this.gameState === GameState.GAME || this.clients.length >= MAX_CLIENTS) {
      this.env.send(id, { t: 'GAME_FULL' });
      return false;
    }
    if (this.clients.some(c => c.id === id)) return true;
    const client: SClient = { id, leader: this.clients.length === 0, players: [], readyNextTurn: false, finished: false, skipLevel: false };
    this.clients.push(client);
    for (const c of this.clients) for (const p of c.players) this.env.send(id, this.addPlayerMsg(p, client, c));
    this.env.send(id, { t: 'SET_MODE', mode: this.gameMode });
    if (client.leader) this.env.send(id, { t: 'NEW_LEADER' });
    return true;
  }

  removeClient(id: string) {
    const client = this.clients.find(c => c.id === id);
    if (!client) return;
    this.clients = this.clients.filter(c => c !== client);
    for (const p of client.players) {
      this.sendAll({ t: 'REMOVE_PLAYER', playerId: p.id });
      this.players = this.players.filter(q => q !== p);
    }
    if (this.clients.length > 0 && client.leader) {
      this.clients[0].leader = true;
      this.env.send(this.clients[0].id, { t: 'NEW_LEADER' });
    }
    this.checkNextTurn();
    if (this.clients.length > 0 && this.gameState === GameState.GAME) this.checkAllFinished();
  }

  // ------------------------------------------------------------------ ready / start
  private stopCountdown() {
    if (this.countdown !== null) { this.env.clearTimeout(this.countdown); this.countdown = null; }
    this.countingDown = false;
  }

  private setEveryoneNotReady() {
    this.stopCountdown();
    for (const c of this.clients) for (const p of c.players) {
      if (p.ready) { p.ready = false; this.sendAll({ t: 'SET_READY', playerId: p.id, ready: false }); }
    }
  }

  private checkAllReady(): boolean {
    for (const c of this.clients) for (const p of c.players) if (!p.ready) return false;
    return true;
  }

  private sendStartCountDown() {
    if (this.countingDown) return;
    this.countingDown = true;
    this.countdown = this.env.setTimeout(() => {
      this.countdown = null;
      if (this.checkAllReady()) this.startGame();
      this.countingDown = false;
    }, START_GAME_DELAY);
    this.sendAll({ t: 'START_COUNTDOWN' });
  }

  // ------------------------------------------------------------------ level generation
  private generateCircles(): number[] {
    return Terrain.randomCircles(this.rng);
  }

  private testSoldier(s: { x: number; y: number }, others: { x: number; y: number }[], circles: number[]): boolean {
    for (const o of others) if (Math.abs(s.x - o.x) < 20 && Math.abs(s.y - o.y) < 20) return false;
    for (let i = 0; i < circles.length; i += 3) {
      if (Math.hypot(s.x - circles[i], s.y - circles[i + 1]) < circles[i + 2] + SOLDIER_SELECTION_RADIUS) return false;
    }
    return true;
  }

  private generateSoldier(others: { x: number; y: number }[], circles: number[], team: number) {
    let s: { x: number; y: number };
    do {
      let x = nextInt(this.rng, PLANE_LENGTH / 2 - 2 * SOLDIER_RADIUS) + SOLDIER_RADIUS;
      const y = nextInt(this.rng, PLANE_HEIGHT - 2 * SOLDIER_RADIUS) + SOLDIER_RADIUS;
      if (team === TEAM2) x += PLANE_LENGTH / 2;
      s = { x: Math.trunc(x), y };
    } while (!this.testSoldier(s, others, circles));
    return s;
  }

  private generateSoldiers(circles: number[]): number[] {
    const soldiers: { x: number; y: number }[] = [];
    for (const p of this.players) for (let i = 0; i < p.numSoldiers; i++) soldiers.push(this.generateSoldier(soldiers, circles, p.team));
    return soldiers.flatMap(s => [s.x, s.y]);
  }

  /** alternate teams in turn order, starting from a random team */
  private reorderPlayers() {
    const out: SPlayer[] = [];
    let team = nextBoolean(this.rng) ? TEAM2 : TEAM1;
    const rest = this.players.slice();
    while (rest.length > 0) {
      let found = false;
      for (let i = 0; i < rest.length;) {
        if (rest[i].team === team) {
          out.push(rest[i]); rest.splice(i, 1);
          team = team === TEAM1 ? TEAM2 : TEAM1;
          found = true;
        } else i++;
      }
      if (!found) team = team === TEAM1 ? TEAM2 : TEAM1;
    }
    this.players = out;
    this.sendAll({ t: 'REORDER', order: out.map(p => p.id) });
  }

  private startGame() {
    this.reorderPlayers();
    const circles = this.generateCircles();
    const soldiers = this.generateSoldiers(circles);
    if (soldiers.length === 0) return; // can't start with no soldiers
    let startPlayer = Math.abs(Math.trunc(this.rng.next() * 2147483647)) % this.players.length;
    for (let guard = 0; this.players[startPlayer].numSoldiers === 0 && guard < 1000; guard++) {
      startPlayer = Math.abs(Math.trunc(this.rng.next() * 2147483647)) % this.players.length;
    }
    this.gameState = GameState.GAME;
    this.sendAll({ t: 'START_GAME', circles, soldiers, startPlayer });
    this.timeTurnStarted = this.env.now();
    for (const c of this.clients) { c.readyNextTurn = false; c.finished = false; c.skipLevel = false; }
    this.setEveryoneNotReady();
  }

  // ------------------------------------------------------------------ turns
  private checkNextTurn() {
    if (this.gameState !== GameState.GAME) return;
    for (const c of this.clients) if (!c.readyNextTurn) return;
    if (this.clients.length === 0) return;
    this.nextTurn();
  }

  private nextTurn() {
    for (const c of this.clients) c.readyNextTurn = false;
    this.sendAll({ t: 'NEXT_TURN' });
    this.timeTurnStarted = this.env.now();
  }

  private checkAllFinished() {
    for (const c of this.clients) if (!c.finished) return;
    for (const c of this.clients) { c.finished = false; c.skipLevel = false; }
    this.setEveryoneNotReady();
    this.sendAll({ t: 'GAME_FINISHED' });
    this.gameState = GameState.PRE_GAME;
  }

  private checkSkipLevel() {
    for (const c of this.clients) if (!c.skipLevel) return;
    for (const c of this.clients) c.skipLevel = false;
    this.startGame();
  }

  // ------------------------------------------------------------------ message handling
  handle(clientId: string, msg: C2S): void {
    const client = this.clients.find(c => c.id === clientId);
    if (!client || typeof msg !== 'object' || msg === null) return;
    try { this.dispatch(client, msg); } catch (e) { console.warn('invalid message', msg, e); }
  }

  private dispatch(client: SClient, msg: C2S) {
    switch (msg.t) {
      case 'ADD_PLAYER': {
        if (this.gameState === GameState.GAME) return;
        if (this.players.length >= MAX_PLAYERS) return;
        const name = String(msg.name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, LIMITS.NAME) || 'Player';
        const p: SPlayer = {
          id: this.lastId++, name, numSoldiers: INITIAL_NUM_SOLDIERS,
          team: nextBoolean(this.rng) ? TEAM1 : TEAM2, ready: false,
        };
        client.players.push(p);
        this.players.push(p);
        this.setEveryoneNotReady();
        for (const c of this.clients) this.env.send(c.id, this.addPlayerMsg(p, c, client));
        break;
      }
      case 'SET_TEAM': {
        if (this.gameState === GameState.GAME) return;
        if (msg.team !== TEAM1 && msg.team !== TEAM2) return;
        const f = this.findControllable(msg.playerId, client);
        if (!f) return;
        f.p.team = msg.team;
        this.setEveryoneNotReady();
        this.sendAll({ t: 'SET_TEAM', team: msg.team, playerId: msg.playerId });
        break;
      }
      case 'REMOVE_PLAYER': {
        const f = this.findControllable(msg.playerId, client);
        if (!f) return;
        f.owner.players = f.owner.players.filter(p => p !== f.p);
        this.players = this.players.filter(p => p !== f.p);
        this.setEveryoneNotReady();
        this.sendAll({ t: 'REMOVE_PLAYER', playerId: msg.playerId });
        break;
      }
      case 'ADD_SOLDIER': {
        if (this.gameState === GameState.GAME) return;
        const f = this.findControllable(msg.playerId, client);
        if (!f || f.p.numSoldiers + 1 > MAX_SOLDIERS_PER_PLAYER) return;
        f.p.numSoldiers++;
        this.setEveryoneNotReady();
        this.sendAll({ t: 'ADD_SOLDIER', playerId: msg.playerId });
        break;
      }
      case 'REMOVE_SOLDIER': {
        if (this.gameState === GameState.GAME) return;
        const f = this.findControllable(msg.playerId, client);
        if (!f || f.p.numSoldiers - 1 < 0) return;
        f.p.numSoldiers--;
        this.setEveryoneNotReady();
        this.sendAll({ t: 'REMOVE_SOLDIER', playerId: msg.playerId });
        break;
      }
      case 'CHAT_MSG': {
        if (!this.ownsPlayer(msg.playerId, client) && msg.playerId !== -1) return;
        const text = String(msg.text ?? '').slice(0, LIMITS.CHAT);
        if (text.toLowerCase() === '-skip' && this.gameState === GameState.GAME) {
          client.skipLevel = true;
          this.checkSkipLevel();
        }
        this.sendAll({ t: 'CHAT_MSG', playerId: msg.playerId, text });
        break;
      }
      case 'NEXT_MODE': {
        if (!client.leader || this.gameState === GameState.GAME) return;
        this.gameMode = (this.gameMode + 1) % 3;
        this.setEveryoneNotReady();
        this.sendAll({ t: 'SET_MODE', mode: this.gameMode });
        break;
      }
      case 'SET_READY': {
        if (this.gameState === GameState.GAME) return;
        const f = this.find(msg.playerId);
        if (!f || f.owner !== client) return;
        f.p.ready = !!msg.ready;
        if (!f.p.ready) this.stopCountdown();
        this.sendAll({ t: 'SET_READY', playerId: msg.playerId, ready: f.p.ready });
        if (this.checkAllReady()) this.sendStartCountDown();
        break;
      }
      case 'READY_NEXT_TURN': {
        if (this.gameState !== GameState.GAME) return;
        client.readyNextTurn = true;
        this.checkNextTurn();
        break;
      }
      case 'FIRE_FUNC': {
        if (!this.ownsPlayer(msg.playerId, client) || this.gameState !== GameState.GAME) return;
        this.sendAll({ t: 'FIRE_FUNC', playerId: msg.playerId, func: String(msg.func ?? '').slice(0, LIMITS.FUNC) });
        break;
      }
      case 'FUNCTION_PREVIEW': {
        if (!this.ownsPlayer(msg.playerId, client) || this.gameState !== GameState.GAME) return;
        this.sendAll({ t: 'FUNCTION_PREVIEW', playerId: msg.playerId, func: String(msg.func ?? '').slice(0, LIMITS.FUNC) });
        break;
      }
      case 'TIME_UP': {
        if (this.gameState !== GameState.GAME) return;
        if (this.env.now() - this.timeTurnStarted > TURN_TIME) this.nextTurn();
        break;
      }
      case 'GAME_FINISHED': {
        if (this.gameState !== GameState.GAME) return;
        client.finished = true;
        this.checkAllFinished();
        break;
      }
      case 'SET_ANGLE': {
        if (!this.ownsPlayer(msg.playerId, client) || this.gameState !== GameState.GAME) return;
        if (typeof msg.angle !== 'number' || !Number.isFinite(msg.angle)) return;
        this.sendAll({ t: 'SET_ANGLE', playerId: msg.playerId, soldier: msg.soldier | 0, angle: msg.angle });
        break;
      }
      case 'DISCONNECT':
        this.removeClient(client.id);
        break;
    }
  }

  /** pending timers must be cleaned up when a room is closed */
  dispose() { this.stopCountdown(); }
}

