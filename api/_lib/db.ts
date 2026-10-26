// Supabase access with the SERVICE ROLE key (bypasses RLS). Server-only: this module must never be imported by src/.
// Plain PostgREST over fetch keeps cold starts small. The function re-applies what RLS would hide (stale rooms)
// and selects only public columns: host_id and timestamps are never read, so they cannot leak.
import { ROOM_COLUMNS, ROOM_FRESH_MS, ROOM_LIST_LIMIT, sanitizeRooms } from '../../src/shared/rooms.js';
import type { RoomInfo } from '../../src/net/types.js';

type FetchLike = typeof fetch;
const DB_TIMEOUT_MS = 3000;

export function roomsQuery(baseUrl: string, serviceKey: string, fetchImpl: FetchLike = fetch, now: () => number = Date.now) {
  return async (): Promise<RoomInfo[]> => {
    const since = new Date(now() - ROOM_FRESH_MS).toISOString();
    const q = new URLSearchParams({ select: ROOM_COLUMNS, updated_at: `gt.${since}`, order: 'created_at.desc', limit: String(ROOM_LIST_LIMIT) });
    const res = await fetchImpl(`${baseUrl}/rest/v1/rooms?${q}`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(DB_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`rooms query failed with HTTP ${res.status}`);
    return sanitizeRooms(await res.json());
  };
}

export function cleanupRpc(baseUrl: string, serviceKey: string, fetchImpl: FetchLike = fetch) {
  return async (): Promise<number> => {
    const res = await fetchImpl(`${baseUrl}/rest/v1/rpc/cleanup_stale_rooms`, {
      method: 'POST',
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(DB_TIMEOUT_MS * 2),
    });
    if (!res.ok) throw new Error(`cleanup failed with HTTP ${res.status}`);
    const n = await res.json();
    return typeof n === 'number' ? n : 0;
  };
}
