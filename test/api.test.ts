// Tests for api/ (cache-aside, JWT verification, cron) against a REAL redis-server through the real @upstash/redis client.
// Supabase is mocked (a counting function / a recording fetch). NOT a test against live Upstash or Supabase.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { SafeCache, upstashCache, type Cache } from '../api/_lib/cache';
import { makeVerifier } from '../api/_lib/auth';
import { cleanupRpc, roomsQuery } from '../api/_lib/db';
import { cleanupHandler, roomsHandler, type Req } from '../api/_lib/handlers';
import { DEFAULT_CONFIG, KEY, LOCK_KEY, STALE_KEY } from '../api/_lib/rooms-service';
import { OnlineClient } from '../src/net/online';
import type { RoomInfo } from '../src/net/types';
import { FakeClock, Hub, fakeSupabase, settle } from './fakes';
import { startRedis, type RedisHarness } from './redis-shim';

const SB = 'https://proj.supabase.co';
const ISS = `${SB}/auth/v1`;
const SERVICE_KEY = 'service-role-key-SECRET-xyz';
const ROOMS: RoomInfo[] = [{ code: 'ABCDE', name: 'Alpha', mode: 0, players: 2, state: 'waiting' }, { code: 'FGHJK', name: 'Beta', mode: 2, players: 1, state: 'playing' }];

let redis: RedisHarness, pub: JWK, priv: KeyLike, other: KeyLike;
beforeAll(async () => {
  redis = await startRedis(56379);
  const a = await generateKeyPair('ES256'), b = await generateKeyPair('ES256');
  priv = a.privateKey; other = b.privateKey;
  pub = { ...(await exportJWK(a.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
}, 20000);
afterAll(async () => { await redis.stop(); });
beforeEach(async () => { redis.mode = 'ok'; await redis.raw('FLUSHALL'); redis.commands.length = 0; });

const verify = () => makeVerifier(SB, undefined, createLocalJWKSet({ keys: [pub] }));
async function token(sub = 'user-1', o: { key?: KeyLike; iss?: string; aud?: string; role?: string; exp?: string | number; alg?: string } = {}) {
  return new SignJWT({ role: o.role ?? 'authenticated' }).setProtectedHeader({ alg: o.alg ?? 'ES256', kid: 'k1' })
    .setSubject(sub).setIssuer(o.iss ?? ISS).setAudience(o.aud ?? 'authenticated').setIssuedAt().setExpirationTime(o.exp ?? '5m').sign(o.key ?? priv);
}
const get = (t?: string): Req => ({ method: 'GET', headers: t ? { authorization: `Bearer ${t}` } : {} });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function setup(cfg = DEFAULT_CONFIG, cacheOverride?: Cache, ms = 800) {
  let dbCalls = 0, dbFail = false, delay = 0;
  const fetchRooms = async () => { dbCalls++; if (delay) await sleep(delay); if (dbFail) throw new Error('db down'); return ROOMS; };
  const mkCache = () => new SafeCache(cacheOverride ?? upstashCache(redis.url, redis.token), ms, () => undefined);
  const call = (t?: string) => roomsHandler(get(t), { verify: verify(), cache: mkCache(), fetchRooms, cfg });
  return { call, calls: () => dbCalls, failDb: (v: boolean) => (dbFail = v), setDelay: (v: number) => (delay = v) };
}

describe('GET /api/rooms: cache-aside', () => {
  it('first request misses (one DB read, X-Cache miss), the next is a hit with no DB read', async () => {
    const s = setup();
    const t = await token();
    const a = await s.call(t), b = await s.call(t);
    expect([a.status, a.headers['X-Cache'], b.status, b.headers['X-Cache']]).toEqual([200, 'miss', 200, 'hit']);
    expect(b.body).toEqual({ rooms: ROOMS });
    expect(s.calls()).toBe(1);
    expect(a.headers['Cache-Control']).toBe('private, no-store');
  });

  it('entries expire: after the TTL the DB is read again; TTLs set in Redis match the config', async () => {
    const s = setup({ ...DEFAULT_CONFIG, ttlSec: 1 });
    const t = await token();
    await s.call(t);
    expect(await redis.raw('TTL', KEY)).toBe(1);
    expect(await redis.raw('TTL', STALE_KEY)).toBeGreaterThan(50);
    await sleep(1300);
    expect(await redis.raw('EXISTS', KEY)).toBe(0);
    const r = await s.call(t);
    expect([r.headers['X-Cache'], s.calls()]).toEqual(['miss', 2]);
  });

  it('50 concurrent requests on a cold cache cause exactly one DB read', async () => {
    const s = setup({ ...DEFAULT_CONFIG, waitMs: 8000 }, undefined, 4000); // generous Redis timeout: this test is about the lock, not timeouts (flaked twice under CPU load: Redis timeout 800 ms, then waiters' 1 s patience)
    s.setDelay(150);
    const t = await token();
    const rs = await Promise.all(Array.from({ length: 50 }, () => s.call(t)));
    expect(rs.every(r => r.status === 200 && JSON.stringify(r.body) === JSON.stringify({ rooms: ROOMS }))).toBe(true);
    expect(s.calls()).toBe(1);
    expect(await redis.raw('EXISTS', LOCK_KEY)).toBe(0); // lock released
  });

  it('DB down: serves the stale copy; with no stale copy answers 503 and does not cache the failure', async () => {
    const s = setup({ ...DEFAULT_CONFIG, ttlSec: 1 });
    const t = await token();
    s.failDb(true);
    const none = await s.call(t);
    expect([none.status, none.headers['Retry-After']]).toEqual([503, '2']);
    expect(await redis.raw('EXISTS', KEY, STALE_KEY)).toBe(0);
    s.failDb(false);
    await s.call(t);
    await sleep(1300); // fresh copy gone, stale copy remains
    s.failDb(true);
    const st = await s.call(t);
    expect([st.status, st.headers['X-Cache'], (st.body as { rooms: RoomInfo[] }).rooms.length]).toEqual([200, 'stale', 2]);
  });

  it('Redis outage: requests are served from the DB (X-Cache bypass)', async () => {
    const s = setup();
    redis.mode = 'down';
    const r = await s.call(await token());
    expect([r.status, r.headers['X-Cache'], s.calls()]).toEqual([200, 'bypass', 1]);
  });

  it('Redis hanging: calls time out and the request still succeeds from the DB', async () => {
    const s = setup(DEFAULT_CONFIG, undefined, 150);
    redis.mode = 'hang';
    const t0 = Date.now();
    const r = await s.call(await token());
    expect([r.status, r.headers['X-Cache']]).toEqual([200, 'bypass']);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('corrupted cache contents are ignored, not served', async () => {
    const s = setup();
    await redis.raw('SET', KEY, '{"not":"an array"}');
    const r = await s.call(await token());
    expect([r.headers['X-Cache'], s.calls()]).toEqual(['miss', 1]);
    await redis.raw('SET', KEY, JSON.stringify([{ code: '<img src=x>', name: 'x' }, { code: 'ABCDE', name: 'N'.repeat(99), mode: 9, players: -4, state: 'x', host_id: 'leak' }]));
    const r2 = await s.call(await token());
    expect(r2.headers['X-Cache']).toBe('hit');
    expect((r2.body as { rooms: unknown[] }).rooms).toEqual([{ code: 'ABCDE', name: 'N'.repeat(20), mode: 2, players: 0, state: 'waiting' }]);
  });
});

describe('GET /api/rooms: authentication and method', () => {
  it('rejects bad tokens with 401 and touches neither Redis nor the DB', async () => {
    const s = setup();
    const bad: Array<[string, string | undefined]> = [
      ['missing', undefined], ['garbage', 'not.a.jwt'],
      ['expired', await token('u', { exp: Math.floor(Date.now() / 1000) - 3600 })],
      ['wrong issuer', await token('u', { iss: 'https://evil.example/auth/v1' })],
      ['wrong audience', await token('u', { aud: 'other' })],
      ['signed by another key', await token('u', { key: other })],
      ['anon-role token', await token('u', { role: 'anon' })],
      ['alg none', 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ4Iiwicm9sZSI6ImF1dGhlbnRpY2F0ZWQifQ.'],
    ];
    for (const [name, t] of bad) { const r = await s.call(t); expect([name, r.status]).toEqual([name, 401]); }
    expect(redis.commands).toEqual([]);
    expect(s.calls()).toBe(0);
  });

  it('HS256 token signed with the public key material is rejected in JWKS mode (algorithm confusion)', async () => {
    const forged = await new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256', kid: 'k1' })
      .setSubject('x').setIssuer(ISS).setAudience('authenticated').setExpirationTime('5m').sign(new TextEncoder().encode(JSON.stringify(pub)));
    const s = setup();
    expect((await s.call(forged)).status).toBe(401);
  });

  it('HS256 mode (legacy projects) accepts only tokens signed with the secret', async () => {
    const secret = 'legacy-shared-secret-0123456789abcdef';
    const v = makeVerifier(SB, secret);
    const mk = (k: string) => new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'HS256' }).setSubject('u').setIssuer(ISS).setAudience('authenticated').setExpirationTime('5m').sign(new TextEncoder().encode(k));
    expect((await v(await mk(secret))).sub).toBe('u');
    await expect(v(await mk('wrong-secret-wrong-secret-wrong-secret'))).rejects.toThrow();
    await expect(v(await token())).rejects.toThrow(); // ES256 token refused in HS256 mode
  });

  it('only GET is allowed', async () => {
    const s = setup();
    for (const m of ['POST', 'PUT', 'DELETE', 'PATCH', undefined]) {
      const r = await roomsHandler({ method: m, headers: { authorization: `Bearer ${await token()}` } }, { verify: verify(), cache: new SafeCache(upstashCache(redis.url, redis.token)), fetchRooms: async () => ROOMS });
      expect([m, r.status, r.headers.Allow]).toEqual([m, 405, 'GET']);
    }
    expect(s.calls()).toBe(0);
  });
});

describe('no cross-user leaks', () => {
  it('different users get identical bodies; Redis holds only the public list under fixed keys', async () => {
    const s = setup();
    const a = await s.call(await token('alice-uid')), b = await s.call(await token('bob-uid'));
    expect(JSON.stringify(a.body)).toBe(JSON.stringify(b.body));
    const keys = (await redis.raw('KEYS', '*')) as string[];
    expect(keys.sort()).toEqual([KEY, STALE_KEY]);
    for (const k of keys) {
      const v = String(await redis.raw('GET', k));
      expect(v + k).not.toMatch(/alice|bob|host_id|Bearer|eyJ/);
    }
  });
});

describe('database access (service role, server only)', () => {
  it('sends the service key only to Supabase, selects only public columns, and returns sanitised rows', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify([{ code: 'ABCDE', name: 'A', mode: 1, players: 3, state: 'waiting', host_id: 'LEAK', updated_at: 'x' }, { code: 'bad code' }]), { status: 200 });
    }) as unknown as typeof fetch;
    const rooms = await roomsQuery(SB, SERVICE_KEY, fetchImpl, () => Date.parse('2026-10-24T12:00:00Z'))();
    expect(rooms).toEqual([{ code: 'ABCDE', name: 'A', mode: 1, players: 3, state: 'waiting' }]);
    expect(JSON.stringify(rooms)).not.toContain('LEAK');
    const u = new URL(seen[0].url);
    expect(u.origin).toBe(SB);
    expect(u.searchParams.get('select')).toBe('code,name,mode,players,state');
    expect(u.searchParams.get('updated_at')).toBe('gt.2026-10-24T11:58:00.000Z');
    expect(u.searchParams.get('limit')).toBe('50');
    expect(seen[0].headers.Authorization).toBe(`Bearer ${SERVICE_KEY}`);
  });

  it('turns an HTTP error into a thrown error that does not contain the key', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const err = (await roomsQuery(SB, SERVICE_KEY, fetchImpl)().catch(e => e)) as Error;
    expect(err.message).toBe('rooms query failed with HTTP 500');
  });

  it('the service key never appears in any API response', async () => {
    const s = setup();
    const r = await s.call(await token());
    expect(JSON.stringify(r)).not.toContain(SERVICE_KEY);
  });
});

describe('cron cleanup', () => {
  const cleanup = (h: string | undefined, secret: string = 'cron-secret', fn = async () => 4, method = 'GET') =>
    cleanupHandler({ method, headers: h ? { authorization: h } : {} }, { cronSecret: secret, cache: new SafeCache(upstashCache(redis.url, redis.token)), cleanup: fn });

  it('requires the exact CRON_SECRET; wrong/missing credentials do nothing', async () => {
    let ran = 0;
    const fn = async () => { ran++; return 1; };
    for (const h of [undefined, 'Bearer nope', 'cron-secret', 'Bearer cron-secret ', 'bearer cron-secret']) expect((await cleanup(h, 'cron-secret', fn)).status).toBe(401);
    expect((await cleanup('Bearer x', '', fn)).status).toBe(500); // unset secret -> refuse, even for "Bearer undefined"
    expect((await cleanup('Bearer undefined', '', fn)).status).toBe(500);
    expect((await cleanup('Bearer cron-secret', 'cron-secret', fn, 'POST')).status).toBe(405);
    expect(ran).toBe(0);
  });

  it('runs the cleanup, reports the count and purges both cache keys', async () => {
    await redis.raw('SET', KEY, '[]'); await redis.raw('SET', STALE_KEY, '[]');
    const r = await cleanup('Bearer cron-secret');
    expect([r.status, r.body]).toEqual([200, { removed: 4 }]);
    expect(await redis.raw('EXISTS', KEY, STALE_KEY)).toBe(0);
  });

  it('a failing cleanup returns 500 without leaking details', async () => {
    const r = await cleanup('Bearer cron-secret', 'cron-secret', async () => { throw new Error('secret detail ' + SERVICE_KEY); });
    expect([r.status, JSON.stringify(r.body)]).toEqual([500, '{"error":"cleanup_failed"}']);
  });

  it('cleanupRpc calls the RPC with the service key and returns the count', async () => {
    let seen: { url: string; auth: string } | null = null;
    const f = (async (url: string, init: RequestInit) => { seen = { url, auth: (init.headers as Record<string, string>).Authorization }; return new Response('7', { status: 200 }); }) as unknown as typeof fetch;
    expect(await cleanupRpc(SB, SERVICE_KEY, f)()).toBe(7);
    expect(seen).toEqual({ url: `${SB}/rest/v1/rpc/cleanup_stale_rooms`, auth: `Bearer ${SERVICE_KEY}` });
  });
});

describe('browser client: /api/rooms with fallback', () => {
  function clientWith(fetchImpl: typeof fetch, withToken = true) {
    const clock = new FakeClock(), hub = new Hub(clock);
    const sb = fakeSupabase(hub, 'u1');
    (sb.auth as unknown as { getSession: () => Promise<unknown> }).getSession = async () => ({ data: { session: withToken ? { user: { id: 'u1' }, access_token: 'tok-123' } : null } });
    const rooms: RoomInfo[][] = [], errors: string[] = [];
    const c = new OnlineClient(sb, clock, { roomsApi: '/api/rooms', fetch: fetchImpl });
    return { c, hub, rooms, errors, handlers: { onPlayers: () => undefined, onChat: () => undefined, onRooms: (r: RoomInfo[]) => rooms.push(r), onError: (m: string) => errors.push(m) } };
  }
  const json = (o: unknown, status = 200) => (async () => new Response(JSON.stringify(o), { status })) as unknown as typeof fetch;

  it('uses the API result (sanitised) and sends the access token', async () => {
    let auth = '';
    const f = (async (_u: string, init: RequestInit) => { auth = (init.headers as Record<string, string>).Authorization; return new Response(JSON.stringify({ rooms: [{ code: 'ABCDE', name: 'x', mode: 1, players: 1, state: 'waiting', host_id: 'h' }, { code: '??' }] })); }) as unknown as typeof fetch;
    const w = clientWith(f);
    await w.c.join('Me', w.handlers); await settle();
    expect(auth).toBe('Bearer tok-123');
    expect(w.rooms.at(-1)).toEqual([{ code: 'ABCDE', name: 'x', mode: 1, players: 1, state: 'waiting' }]);
  });

  it.each([['HTTP 503', json({}, 503)], ['network error', (async () => { throw new Error('offline'); }) as unknown as typeof fetch], ['malformed body', json({ nope: 1 })]])(
    'falls back to a direct Supabase read on %s', async (_n, f) => {
      const w = clientWith(f);
      w.hub.rooms.push({ code: 'QRSTU', name: 'Direct', mode: 0, players: 1, state: 'waiting', host_id: 'h', created_at: 1, updated_at: w.hub.clock.now() } as never);
      await w.c.join('Me', w.handlers); await settle();
      expect(w.errors).toEqual([]);
      expect(w.rooms.at(-1)?.map(r => r.code)).toEqual(['QRSTU']);
    });
});
