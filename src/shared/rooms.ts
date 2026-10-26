// Shared by the browser (src/net/online.ts) and the Vercel function (api/): one definition of what a public room looks like.
// Everything from the database is treated as untrusted and normalised here (names are shown to other players).
import type { RoomInfo } from '../net/types.js';

export const ROOM_COLUMNS = 'code,name,mode,players,state';
export const ROOM_LIST_LIMIT = 50;
/** rooms whose host has not heartbeated for this long are hidden (same value as the RLS policy `rooms_select_fresh`) */
export const ROOM_FRESH_MS = 120_000;
export const CODE_RE = /^[A-Z0-9]{4,8}$/;

export function sanitizeRoom(r: unknown): RoomInfo | null {
  if (typeof r !== 'object' || r === null) return null;
  const o = r as Record<string, unknown>;
  if (typeof o.code !== 'string' || !CODE_RE.test(o.code)) return null;
  const clamp = (v: unknown, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number(v) | 0));
  return {
    code: o.code,
    name: typeof o.name === 'string' ? o.name.slice(0, 20) : '',
    mode: clamp(o.mode, 0, 2),
    players: clamp(o.players, 0, 10),
    state: o.state === 'playing' ? 'playing' : 'waiting',
  };
}

export function sanitizeRooms(rows: unknown): RoomInfo[] {
  if (!Array.isArray(rows)) return [];
  const out: RoomInfo[] = [];
  for (const r of rows) { const s = sanitizeRoom(r); if (s) out.push(s); }
  return out.slice(0, ROOM_LIST_LIMIT);
}
