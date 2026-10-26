// Cache-aside for the public room list.
//
//   GET -> Redis "rooms:v1" (TTL 5 s) -> hit: return.
//          miss: take a short lock (SET NX) so ONE request queries Supabase; the others wait for its result
//                (stampede protection), then fall back to querying themselves if it never shows up.
//          Supabase down: serve "rooms:v1:stale" (TTL 60 s) if present, otherwise fail with 503.
//          Redis down/slow: every Redis call is time-limited; the request is served straight from Supabase.
//
// What is cached is the SAME public list for every caller (no user id in the key or value) -> no cross-user leaks.
// Invalidation: writes happen browser -> Supabase directly (RLS), so the cache cannot be purged on write; the 5 s TTL
// bounds staleness (the original client polled its list too). The cleanup cron purges both keys.
import type { RoomInfo } from '../../src/net/types.js';
import { sanitizeRooms } from '../../src/shared/rooms.js';
import { SafeCache } from './cache.js';

export const KEY = 'rooms:v1';
export const STALE_KEY = 'rooms:v1:stale';
export const LOCK_KEY = 'rooms:v1:lock';

export interface RoomsConfig { ttlSec: number; staleTtlSec: number; lockSec: number; waitMs: number; pollMs: number }
export const DEFAULT_CONFIG: RoomsConfig = { ttlSec: 5, staleTtlSec: 60, lockSec: 3, waitMs: 1000, pollMs: 50 };

export type Source = 'hit' | 'miss' | 'stale' | 'bypass';
export class UnavailableError extends Error {}

const parse = (s: string | null): RoomInfo[] | null => {
  if (!s) return null;
  try { const v = JSON.parse(s); return Array.isArray(v) ? sanitizeRooms(v) : null; } catch { return null; }
};
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function getRooms(
  cache: SafeCache, fetchRooms: () => Promise<RoomInfo[]>, cfg: RoomsConfig = DEFAULT_CONFIG,
): Promise<{ rooms: RoomInfo[]; source: Source }> {
  const done = (rooms: RoomInfo[], source: Source) => ({ rooms, source: cache.failed ? 'bypass' as const : source });

  const hit = parse(await cache.get(KEY));
  if (hit) return done(hit, 'hit');

  const iAmRefresher = await cache.setNX(LOCK_KEY, '1', cfg.lockSec);
  if (!iAmRefresher) {
    for (let waited = 0; waited < cfg.waitMs; waited += cfg.pollMs) {
      await sleep(cfg.pollMs);
      const fresh = parse(await cache.get(KEY));
      if (fresh) return done(fresh, 'hit');
    }
  }

  let rooms: RoomInfo[];
  try {
    rooms = await fetchRooms();
  } catch (e) {
    const stale = parse(await cache.get(STALE_KEY));
    if (iAmRefresher) await cache.del(LOCK_KEY);
    if (stale) return done(stale, 'stale');
    throw new UnavailableError(e instanceof Error ? e.message : String(e));
  }
  const json = JSON.stringify(rooms);
  await Promise.all([cache.set(KEY, json, cfg.ttlSec), cache.set(STALE_KEY, json, cfg.staleTtlSec)]);
  if (iAmRefresher) await cache.del(LOCK_KEY);
  return done(rooms, 'miss');
}
