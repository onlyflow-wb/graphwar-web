// Framework-free request handlers (easy to test); api/*.ts adapt them to Vercel's (req, res).
import { createHash, timingSafeEqual } from 'node:crypto';
import { bearer, type Verifier } from './auth.js';
import type { SafeCache } from './cache.js';
import { KEY, STALE_KEY, UnavailableError, getRooms, type RoomsConfig, DEFAULT_CONFIG } from './rooms-service.js';
import type { RoomInfo } from '../../src/net/types.js';

export interface Req { method?: string; headers: Record<string, string | string[] | undefined> }
export interface Res { status: number; headers: Record<string, string>; body: unknown }

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Res => ({
  status, body, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', ...headers },
});

export interface RoomsDeps {
  verify: Verifier;
  cache: SafeCache;
  fetchRooms: () => Promise<RoomInfo[]>;
  cfg?: RoomsConfig;
}

export async function roomsHandler(req: Req, d: RoomsDeps): Promise<Res> {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  const token = bearer(req.headers.authorization);
  if (!token) return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  try { await d.verify(token); } catch { return json(401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' }); }
  try {
    const { rooms, source } = await getRooms(d.cache, d.fetchRooms, d.cfg ?? DEFAULT_CONFIG);
    return json(200, { rooms }, { 'X-Cache': source });
  } catch (e) {
    if (!(e instanceof UnavailableError)) console.error('rooms handler error:', e);
    return json(503, { error: 'rooms_unavailable' }, { 'Retry-After': '2' });
  }
}

export interface CleanupDeps { cronSecret: string | undefined; cache: SafeCache; cleanup: () => Promise<number> }

/** constant-time comparison that does not leak the secret's length */
function safeEqual(a: string, b: string) {
  const ha = createHash('sha256').update(a).digest(), hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function cleanupHandler(req: Req, d: CleanupDeps): Promise<Res> {
  if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  if (!d.cronSecret) { console.error('CRON_SECRET is not set; refusing to run cleanup'); return json(500, { error: 'not_configured' }); }
  const h = req.headers.authorization;
  const given = Array.isArray(h) ? h[0] : h;
  if (!given || !safeEqual(given, `Bearer ${d.cronSecret}`)) return json(401, { error: 'unauthorized' });
  try {
    const removed = await d.cleanup();
    await d.cache.del(KEY, STALE_KEY);
    return json(200, { removed });
  } catch (e) {
    console.error('cleanup failed:', e);
    return json(500, { error: 'cleanup_failed' });
  }
}
