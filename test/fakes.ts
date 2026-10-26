// Test doubles: a manual clock and an in-memory stand-in for the parts of supabase-js that src/net/online.ts uses.
// The fake enforces the SAME access rules as supabase/migrations/*_rooms.sql (those rules are tested separately in Postgres):
//   lobby: everyone | room:CODE: read = anyone, write = host only | in:CODE: write = anyone, read = host only
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Clock } from '../src/core/session';

export class FakeClock implements Clock {
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
      await settle();
    }
  }
}

/** lets queued microtasks, crypto.subtle work and fake network deliveries finish */
export async function settle(rounds = 4) { for (let i = 0; i < rounds; i++) await new Promise<void>(r => setImmediate(r)); }

interface Row { code: string; host_id: string; name: string; mode: number; players: number; state: string; created_at: number; updated_at: number }
type Cb = (status: string, err?: { message: string }) => void;

export class Hub {
  rooms: Row[] = [];
  channels = new Set<FakeChannel>();
  presence = new Map<string, Map<string, unknown>>();
  rejected: string[] = [];          // writes refused by the access rules
  sentByTopic: Record<string, number> = {};
  /** if true, joining a channel requires READ permission (strict reading of Realtime private channels) */
  strictJoin = false;
  private seq = 0;
  constructor(public clock: Clock) {}

  nextCode() { return `R${String(++this.seq).padStart(4, '0')}`; }
  room(code: string) { return this.rooms.find(r => r.code === code); }

  canRead(topic: string, uid: string): boolean {
    if (topic === 'lobby') return true;
    const [kind, code] = [topic.slice(0, topic.indexOf(':')), topic.slice(topic.indexOf(':') + 1)];
    const r = this.room(code);
    if (!r) return false;
    return kind === 'room' || (kind === 'in' && r.host_id === uid);
  }
  canWrite(topic: string, uid: string): boolean {
    if (topic === 'lobby') return true;
    const kind = topic.slice(0, topic.indexOf(':')), code = topic.slice(topic.indexOf(':') + 1);
    const r = this.room(code);
    if (!r) return false;
    return kind === 'in' || (kind === 'room' && r.host_id === uid);
  }

  deliver(from: FakeChannel, event: string, payload: unknown) {
    this.sentByTopic[from.topic] = (this.sentByTopic[from.topic] ?? 0) + 1;
    for (const ch of this.channels) {
      if (ch.topic !== from.topic || !ch.joined || !this.canRead(ch.topic, ch.uid)) continue;
      if (ch === from && !from.cfg.config?.broadcast?.self) continue;
      const data = JSON.parse(JSON.stringify(payload)); // like the wire: no shared references
      setImmediate(() => { for (const l of ch.listeners) if (l.type === 'broadcast' && l.filter.event === event) l.cb({ type: 'broadcast', event, payload: data }); });
    }
  }
  syncPresence(topic: string) {
    for (const ch of this.channels) if (ch.topic === topic && ch.joined) setImmediate(() => { for (const l of ch.listeners) if (l.type === 'presence' && l.filter.event === 'sync') l.cb({}); });
  }
}

class FakeChannel {
  listeners: { type: string; filter: { event: string }; cb: (m: any) => void }[] = [];  // eslint-disable-line @typescript-eslint/no-explicit-any
  joined = false;
  constructor(private hub: Hub, readonly uid: string, readonly topic: string, readonly cfg: { config?: { private?: boolean; presence?: { key: string }; broadcast?: { self?: boolean } } }) {}
  on(type: string, filter: { event: string }, cb: (m: any) => void)  // eslint-disable-line @typescript-eslint/no-explicit-any
   { this.listeners.push({ type, filter, cb }); return this; }
  subscribe(cb: Cb) {
    setImmediate(() => {
      const r = this.hub.canRead(this.topic, this.uid);
      const w = this.hub.canWrite(this.topic, this.uid);
      if (!(this.hub.strictJoin ? r : (r || w))) { cb('CHANNEL_ERROR', { message: 'You do not have permissions to join this topic' }); return; }
      this.joined = true;
      this.hub.channels.add(this);
      cb('SUBSCRIBED');
    });
    return this;
  }
  async send(m: { type: string; event: string; payload: unknown }) {
    if (!this.hub.canWrite(this.topic, this.uid)) { this.hub.rejected.push(`${this.uid} -> ${this.topic}/${m.event}`); return 'error'; }
    this.hub.deliver(this, m.event, m.payload);
    return 'ok';
  }
  async track(meta: unknown) {
    const key = this.cfg.config?.presence?.key ?? this.uid;
    const t = this.hub.presence.get(this.topic) ?? new Map();
    t.set(key, meta); this.hub.presence.set(this.topic, t);
    this.hub.syncPresence(this.topic);
    return 'ok';
  }
  presenceState() {
    const out: Record<string, unknown[]> = {};
    for (const [k, v] of this.hub.presence.get(this.topic) ?? []) out[k] = [v];
    return out;
  }
}

class Query {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private filters: [string, unknown][] = [];
  private payload: Record<string, unknown> = {};
  private wantRows = false;
  private ord: { col: string; asc: boolean } | null = null;
  private lim = Infinity;
  private mode: 'many' | 'single' | 'maybe' = 'many';
  constructor(private hub: Hub, private uid: string) {}
  select(_cols?: string) { if (this.op !== 'select') this.wantRows = true; return this; }
  insert(p: Record<string, unknown>) { this.op = 'insert'; this.payload = p; return this; }
  update(p: Record<string, unknown>) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c: string, v: unknown) { this.filters.push([c, v]); return this; }
  order(col: string, o: { ascending: boolean }) { this.ord = { col, asc: o.ascending }; return this; }
  limit(n: number) { this.lim = n; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  then<T>(res: (v: unknown) => T, rej?: (e: unknown) => T) { return Promise.resolve(this.run()).then(res, rej); }

  private matches(r: Row) { return this.filters.every(([c, v]) => (r as unknown as Record<string, unknown>)[c] === v); }
  private fail(message: string, code = '23514') { return { data: null, error: { message, code } }; }

  private run() {
    const h = this.hub, now = h.clock.now();
    if (this.op === 'insert') {
      const p = this.payload as { name?: string; mode?: number };
      const name = p.name ?? '';
      if (name.length < 1 || name.length > 20 || name !== name.trim()) return this.fail('rooms_name_length');
      if (p.mode !== undefined && (p.mode < 0 || p.mode > 2)) return this.fail('rooms_mode_range');
      if (h.rooms.some(r => r.host_id === this.uid)) return this.fail('rooms_one_per_host', '23505');
      const row: Row = { code: h.nextCode(), host_id: this.uid, name, mode: p.mode ?? 0, players: 0, state: 'waiting', created_at: now, updated_at: now };
      h.rooms.push(row);
      return { data: this.wantRows ? { code: row.code } : null, error: null };
    }
    if (this.op === 'update') {
      const rows = h.rooms.filter(r => r.host_id === this.uid && this.matches(r));
      for (const r of rows) {
        for (const [k, v] of Object.entries(this.payload)) {
          if (!['name', 'mode', 'players', 'state'].includes(k)) return this.fail(`permission denied for column ${k}`, '42501');
          (r as unknown as Record<string, unknown>)[k] = v;
        }
        if (r.players < 0 || r.players > 10) return this.fail('rooms_players_rng');
        r.updated_at = now;
      }
      return { data: null, error: null };
    }
    if (this.op === 'delete') {
      h.rooms = h.rooms.filter(r => !(r.host_id === this.uid && this.matches(r)));
      // a deleted room invalidates its channels (policies reference the row)
      return { data: null, error: null };
    }
    let rows = h.rooms.filter(r => r.updated_at > now - 120_000 && this.matches(r)).map(r => ({ ...r }));
    if (this.ord) { const { col, asc } = this.ord; rows.sort((a, b) => ((a as never)[col] - (b as never)[col]) * (asc ? 1 : -1)); }
    rows = rows.slice(0, this.lim);
    if (this.mode === 'many') return { data: rows, error: null };
    if (this.mode === 'maybe') return { data: rows[0] ?? null, error: null };
    return rows.length === 1 ? { data: rows[0], error: null } : this.fail('JSON object requested, multiple (or no) rows returned', 'PGRST116');
  }
}

/** one fake browser/user. Cast to SupabaseClient: only the subset used by online.ts is implemented. */
export function fakeSupabase(hub: Hub, uid: string): SupabaseClient {
  const sb = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: uid } } } }),
      signInAnonymously: async () => ({ data: { session: { user: { id: uid } } }, error: null }),
    },
    channel: (topic: string, cfg: FakeChannel['cfg']) => new FakeChannel(hub, uid, topic, cfg),
    removeChannel: async (ch: FakeChannel) => { ch.joined = false; hub.channels.delete(ch); return 'ok'; },
    from: (_t: string) => new Query(hub, uid),
  };
  return sb as unknown as SupabaseClient;
}
