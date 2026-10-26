// Online play over Supabase (Auth + Postgres + Realtime). Implements the LobbyClient contract of ./types.
//
// The original had three Java servers over raw TCP. Here:
//   Global lobby server  -> Realtime channel 'lobby' (presence = online players, broadcast = chat)
//                           + public.rooms table (room list)           [supabase/migrations/*_rooms.sql]
//   Room/Graph server    -> runs INSIDE THE HOST'S BROWSER (as it ran on the room creator's PC originally):
//                           a GraphServer instance fed by Realtime broadcast.
//
// Room transport (two private channels, access enforced by RLS on realtime.messages):
//   room:<CODE>  host -> everyone   events 'S2C' {to, msgs[]} and 'PING'.  Only the host may write.
//   in:<CODE>    guest -> host      events 'C2S' {key, kind, msg?}.         Only the host may read.
// A guest authenticates to the host with a random secret `key` that only travels on in:<CODE> (unreadable by
// other guests); its public address on room:<CODE> is a hash of that key.
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import type { Thinker } from '../core/ai';
import { createBrain } from '../core/ai-host';
import { GameData, type ClientEvents } from '../core/client';
import { GameState, MAX_PLAYERS } from '../core/constants';
import type { Player } from '../core/entities';
import type { C2S, S2C } from '../core/protocol';
import { GraphServer, type ServerEnv } from '../core/server';
import { realClock, type Clock } from '../core/session';
import type { Rng } from '../core/rng';
import { CODE_RE, sanitizeRooms } from '../shared/rooms';
import type { LobbyClient, LobbyHandlers, RoomInfo, Session } from './types';

/** same values as GraphServer/Constants.java TIMEOUT_KEEPALIVE / TIMEOUT_DROP */
export const KEEPALIVE_MS = 5000;
export const DROP_MS = 30000;
const STATUS_HEARTBEAT_MS = 15000;     // keeps rooms.updated_at fresh (rows older than 2 min are hidden by RLS)
const ROOM_POLL_MS = 5000;
const JOIN_TIMEOUT_MS = 8000;
const HOST_CLIENT = 'host';

// ------------------------------------------------------------------ small helpers
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function randomKey(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

/** public routing address for a secret key (the key itself never appears on a channel others can read) */
export async function addressOf(key: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return Array.from(new Uint8Array(d).slice(0, 8), x => x.toString(16).padStart(2, '0')).join('');
}

function subscribe(ch: RealtimeChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    ch.subscribe((status, err) => {
      if (status === 'SUBSCRIBED') resolve();
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        reject(new Error(err?.message ? `Realtime: ${err.message}` : `Realtime channel ${status.toLowerCase()}`));
      }
    });
  });
}

/** recurring timer on the injectable clock (so tests can run it with a fake clock); returns a stop function */
function repeat(clock: Clock, ms: number, fn: () => void): () => void {
  let h: unknown;
  let stopped = false;
  const tick = () => { if (stopped) return; fn(); h = clock.setTimeout(tick, ms); };
  h = clock.setTimeout(tick, ms);
  return () => { stopped = true; clock.clearTimeout(h); };
}

/** computer players run on the browser that added them (same as the original, where PCs were local) */
class Brains {
  private map = new Map<number, Thinker>();
  game!: GameData;
  constructor(private rng?: Rng) {}
  wrap(events: ClientEvents): ClientEvents {
    return {
      ...events,
      onTurnStart: p => { events.onTurnStart?.(p); this.forPlayer(p)?.thinkFunction(); },
      onGameEnd: w => { this.stop(); events.onGameEnd?.(w); },
    };
  }
  private forPlayer(p: Player): Thinker | undefined {
    if (!p.isComputer) return undefined;
    let b = this.map.get(p.id);
    if (!b) { b = createBrain(p, this.game, p.aiLevel, this.rng); this.map.set(p.id, b); }
    return b;
  }
  stop() { for (const b of this.map.values()) b.stopThinkFunction(); }
}

// ------------------------------------------------------------------ host (= the room's server)
interface GuestInfo { addr: string; lastSeen: number; tokens: number; tokenAt: number }

export class HostSession implements Session {
  readonly game: GameData;
  readonly server: GraphServer;
  private guests = new Map<string, GuestInfo>();       // key -> info
  private outbox = new Map<string, S2C[]>();
  private flushQueued = false;
  private statusTimer: unknown = null;
  private stops: (() => void)[] = [];
  private brains: Brains;
  private closed = false;

  constructor(
    private sb: SupabaseClient, readonly roomCode: string,
    private out: RealtimeChannel, private inn: RealtimeChannel,
    events: ClientEvents, private clock: Clock = realClock, rng?: Rng,
  ) {
    this.brains = new Brains(rng);
    const env: ServerEnv = {
      send: (id, msg) => this.sendTo(id, msg),
      now: () => clock.now(),
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: h => clock.clearTimeout(h),
      rng,
    };
    this.server = new GraphServer(env);
    this.game = new GameData(
      (m: C2S) => queueMicrotask(() => { if (!this.closed) this.server.handle(HOST_CLIENT, m); }),
      () => clock.now(),
      this.brains.wrap(events),
    );
    this.brains.game = this.game;
    this.server.addClient(HOST_CLIENT);

    inn.on('broadcast', { event: 'C2S' }, ({ payload }) => { void this.onIncoming(payload); });
    this.stops.push(repeat(clock, KEEPALIVE_MS, () => this.sweep()));
    this.stops.push(repeat(clock, STATUS_HEARTBEAT_MS, () => void this.pushStatus()));
  }

  // ---- server -> clients (batched per recipient per tick)
  private sendTo(id: string, msg: S2C) {
    if (this.closed) return;
    if (id === HOST_CLIENT) { queueMicrotask(() => this.game.handle(msg)); }
    else {
      const q = this.outbox.get(id) ?? [];
      q.push(msg);
      this.outbox.set(id, q);
      if (!this.flushQueued) { this.flushQueued = true; queueMicrotask(() => this.flush()); }
    }
    if (msg.t === 'ADD_PLAYER' || msg.t === 'REMOVE_PLAYER' || msg.t === 'SET_MODE' || msg.t === 'START_GAME' || msg.t === 'GAME_FINISHED') this.scheduleStatus();
  }

  private flush() {
    this.flushQueued = false;
    const box = this.outbox;
    this.outbox = new Map();
    for (const [to, msgs] of box) void this.out.send({ type: 'broadcast', event: 'S2C', payload: { to, msgs } });
  }

  // ---- guests -> server
  private async onIncoming(payload: unknown) {
    if (this.closed || !isObj(payload) || typeof payload.key !== 'string' || payload.key.length < 16 || payload.key.length > 64) return;
    const key = payload.key;
    const now = this.clock.now();
    let g = this.guests.get(key);

    if (payload.kind === 'join') {
      if (g) return;                                        // already joined
      if (this.guests.size >= 64) return;                   // bound memory against join spam
      const addr = await addressOf(key);
      if (this.closed || this.guests.has(key)) return;
      if (this.server.addClient(addr)) this.guests.set(key, { addr, lastSeen: now, tokens: 60, tokenAt: now });
      return;
    }
    if (!g) return;                                         // unknown key: ignore
    g.lastSeen = now;
    if (payload.kind !== 'msg' || !isObj(payload.msg) || typeof payload.msg.t !== 'string') return;

    // token bucket: 40 msgs/s sustained, burst 60 (function previews fire on every keystroke)
    g.tokens = Math.min(60, g.tokens + ((now - g.tokenAt) / 1000) * 40);
    g.tokenAt = now;
    if (g.tokens < 1) return;
    g.tokens -= 1;

    const msg = payload.msg as unknown as C2S;
    this.server.handle(g.addr, msg);
    if (msg.t === 'DISCONNECT') this.guests.delete(key);
  }

  /** every KEEPALIVE: tell guests we are alive, drop guests silent for DROP_MS (original: TIMEOUT_DROP) */
  private sweep() {
    if (this.closed) return;
    void this.out.send({ type: 'broadcast', event: 'PING', payload: {} });
    const now = this.clock.now();
    for (const [key, g] of this.guests) {
      if (now - g.lastSeen > DROP_MS) { this.guests.delete(key); this.server.removeClient(g.addr); }
    }
  }

  // ---- public room listing
  private scheduleStatus() {
    if (this.statusTimer || this.closed) return;
    this.statusTimer = this.clock.setTimeout(() => { this.statusTimer = null; void this.pushStatus(); }, 800);
  }

  async pushStatus(): Promise<void> {
    if (this.closed) return;
    const { error } = await this.sb.from('rooms').update({
      players: Math.min(MAX_PLAYERS, this.server.playerCount),
      mode: this.server.gameMode,
      state: this.server.gameState === GameState.GAME ? 'playing' : 'waiting',
    }).eq('code', this.roomCode);
    if (error) console.warn('room status update failed:', error.message);
  }

  dispose() { void this.shutdown(); }

  private async shutdown() {
    if (this.closed) return;
    // tell guests the room is gone (original: closing the server dropped every socket)
    if (this.guests.size > 0) await this.out.send({ type: 'broadcast', event: 'S2C', payload: { to: '*', msgs: [{ t: 'DISCONNECT' }] } });
    this.closed = true;
    for (const stop of this.stops) stop();
    if (this.statusTimer) this.clock.clearTimeout(this.statusTimer);
    this.brains.stop();
    this.server.dispose();
    await this.sb.from('rooms').delete().eq('code', this.roomCode);
    await this.sb.removeChannel(this.out);
    await this.sb.removeChannel(this.inn);
  }
}

// ------------------------------------------------------------------ guest
export class GuestSession implements Session {
  game!: GameData;
  private key = randomKey();
  private addr = '';
  private lastHostSeen = 0;
  private stops: (() => void)[] = [];
  private brains: Brains;
  private closed = false;
  private joined: { ok: () => void; fail: (e: Error) => void } | null = null;

  constructor(
    private sb: SupabaseClient, readonly roomCode: string,
    private out: RealtimeChannel, private inn: RealtimeChannel,
    private events: ClientEvents, private clock: Clock = realClock, rng?: Rng,
  ) {
    this.brains = new Brains(rng);
  }

  /** subscribes and joins the host's server; resolves once the host answered, rejects when full / no answer */
  async connect(): Promise<void> {
    this.addr = await addressOf(this.key);
    this.game = new GameData(
      (m: C2S) => this.sendMsg(m),
      () => this.clock.now(),
      this.brains.wrap({ ...this.events, onKicked: msg => { this.events.onKicked?.(msg); this.dispose(); } }),
    );
    this.brains.game = this.game;

    this.out.on('broadcast', { event: 'S2C' }, ({ payload }) => this.onS2C(payload));
    this.out.on('broadcast', { event: 'PING' }, () => { this.lastHostSeen = this.clock.now(); });
    await subscribe(this.out);
    // in:<CODE> is write-only for guests (only the host may read it). Depending on how Realtime treats a
    // write-only private channel, joining it may be refused; sending then still works over supabase-js's HTTP
    // broadcast fallback, so a failed join here is not fatal. (UNVERIFIED against a live project: see PROGRESS.md.)
    await subscribe(this.inn).catch(() => undefined);

    this.lastHostSeen = this.clock.now();
    let timeout: unknown;
    const answered = new Promise<void>((ok, fail) => {
      this.joined = { ok, fail };
      timeout = this.clock.setTimeout(() => fail(new Error('The host did not answer. The room may be closed.')), JOIN_TIMEOUT_MS);
    });
    await this.inn.send({ type: 'broadcast', event: 'C2S', payload: { key: this.key, kind: 'join' } });
    try { await answered; } finally { this.clock.clearTimeout(timeout); this.joined = null; }

    this.stops.push(repeat(this.clock, KEEPALIVE_MS, () => {
      void this.inn.send({ type: 'broadcast', event: 'C2S', payload: { key: this.key, kind: 'ping' } });
      if (this.clock.now() - this.lastHostSeen > DROP_MS && !this.closed) {
        this.events.onKicked?.('Lost connection to the host.');
        this.dispose();
      }
    }));
  }

  private sendMsg(m: C2S) {
    if (this.closed) return;
    void this.inn.send({ type: 'broadcast', event: 'C2S', payload: { key: this.key, kind: 'msg', msg: m } });
  }

  private onS2C(payload: unknown) {
    if (this.closed || !isObj(payload) || (payload.to !== this.addr && payload.to !== '*') || !Array.isArray(payload.msgs)) return;
    this.lastHostSeen = this.clock.now();
    for (const m of payload.msgs) {
      if (!isObj(m) || typeof m.t !== 'string') continue;
      const msg = m as unknown as S2C;
      if (this.joined) {
        if (msg.t === 'GAME_FULL') { this.joined.fail(new Error('The game is full or already started.')); this.joined = null; return; }
        if (msg.t === 'SET_MODE') { this.joined.ok(); this.joined = null; }
      }
      this.game.handle(msg);
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops) stop();
    this.brains.stop();
    void this.sb.removeChannel(this.out);
    void this.sb.removeChannel(this.inn);
  }
}

// ------------------------------------------------------------------ lobby client
export interface OnlineOptions { roomsApi?: string; fetch?: typeof fetch }

export class OnlineClient implements LobbyClient {
  private lobby: RealtimeChannel | null = null;
  private stopPoll: (() => void) | null = null;
  private handlers: LobbyHandlers | null = null;
  private name = '';
  joined = false;

  constructor(private sb: SupabaseClient, private clock: Clock = realClock, private opts: OnlineOptions = {}) {}

  private async userId(): Promise<string> {
    const { data } = await this.sb.auth.getSession();
    if (data.session) return data.session.user.id;
    const res = await this.sb.auth.signInAnonymously();
    if (res.error || !res.data.session) throw new Error(res.error?.message ?? 'Could not sign in.');
    return res.data.session.user.id;
  }

  async join(name: string, h: LobbyHandlers): Promise<void> {
    this.leave();
    const uid = await this.userId();
    this.name = name.slice(0, 24);
    this.handlers = h;
    const ch = this.sb.channel('lobby', { config: { private: true, presence: { key: uid }, broadcast: { self: true } } });
    ch.on('presence', { event: 'sync' }, () => {
      const names: string[] = [];
      for (const metas of Object.values(ch.presenceState<{ name?: string }>())) for (const m of metas) names.push(str(m.name, 24) || '?');
      h.onPlayers(names.sort((a, b) => a.localeCompare(b)));
    });
    ch.on('broadcast', { event: 'chat' }, ({ payload }) => {
      if (isObj(payload)) h.onChat(str(payload.name, 24) || '?', str(payload.text, 200));
    });
    await subscribe(ch);
    await ch.track({ name: this.name });
    this.lobby = ch;
    this.joined = true;
    await this.refreshRooms();
    this.stopPoll = repeat(this.clock, ROOM_POLL_MS, () => void this.refreshRooms());
  }

  leave() {
    this.stopPoll?.();
    this.stopPoll = null;
    if (this.lobby) void this.sb.removeChannel(this.lobby);
    this.lobby = null;
    this.joined = false;
  }

  say(text: string) {
    const t = text.trim().slice(0, 200);
    if (t && this.lobby) void this.lobby.send({ type: 'broadcast', event: 'chat', payload: { name: this.name, text: t } });
  }

  /** Room list: the cached /api/rooms first; if that is unavailable, straight from Supabase (RLS still applies). */
  async refreshRooms(): Promise<void> {
    const h = this.handlers;
    if (!h) return;
    const viaApi = await this.roomsFromApi();
    if (viaApi) { h.onRooms(viaApi); return; }
    const { data, error } = await this.sb.from('rooms')
      .select('code,name,mode,players,state').order('created_at', { ascending: false }).limit(50);
    if (error) { h.onError(`Could not load rooms: ${error.message}`); return; }
    h.onRooms(sanitizeRooms(data));
  }

  private async roomsFromApi(): Promise<RoomInfo[] | null> {
    const url = this.opts.roomsApi;
    if (!url) return null;
    try {
      const { data } = await this.sb.auth.getSession();
      const token = data.session?.access_token;
      if (!token) return null;
      const res = await (this.opts.fetch ?? fetch)(url, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (!res.ok) return null;
      const body: unknown = await res.json();
      return isObj(body) && Array.isArray(body.rooms) ? sanitizeRooms(body.rooms) : null;
    } catch { return null; }
  }

  private channels(code: string) {
    const cfg = { config: { private: true, broadcast: { self: false } } };
    return { out: this.sb.channel(`room:${code}`, cfg), inn: this.sb.channel(`in:${code}`, cfg) };
  }

  async createRoom(roomName: string, _playerName: string, events: ClientEvents): Promise<Session> {
    const uid = await this.userId();
    // a crashed earlier session may have left a row behind; one room per host is enforced by the database
    await this.sb.from('rooms').delete().eq('host_id', uid);
    const { data, error } = await this.sb.from('rooms').insert({ name: roomName.trim().slice(0, 20), mode: 0 }).select('code').single();
    if (error || !data) throw new Error(error?.message ?? 'Could not create the room.');
    const code = data.code as string;
    const { out, inn } = this.channels(code);
    try {
      await Promise.all([subscribe(out), subscribe(inn)]);
    } catch (e) {
      await this.sb.from('rooms').delete().eq('code', code);
      throw e;
    }
    return new HostSession(this.sb, code, out, inn, events, this.clock);
  }

  async joinRoom(code: string, _playerName: string, events: ClientEvents): Promise<Session> {
    code = code.trim().toUpperCase();
    if (!CODE_RE.test(code)) throw new Error('Invalid room code.');
    await this.userId();
    const { data, error } = await this.sb.from('rooms').select('code,state,players').eq('code', code).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('Room not found.');
    if (data.state === 'playing') throw new Error('That game has already started.');
    if (data.players >= MAX_PLAYERS) throw new Error('That room is full.');
    const { out, inn } = this.channels(code);
    const s = new GuestSession(this.sb, code, out, inn, events, this.clock);
    try { await s.connect(); } catch (e) { s.dispose(); throw e; }
    return s;
  }

  publishStatus(session: Session) {
    if (session instanceof HostSession) void session.pushStatus();
  }
}

export function createOnline(sb: SupabaseClient, opts: OnlineOptions = {}): LobbyClient {
  return new OnlineClient(sb, realClock, opts);
}
