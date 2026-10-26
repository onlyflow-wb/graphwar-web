// Contract between the UI and the online layer (implemented in src/net/online.ts, Supabase Realtime + Vercel API).
import type { GameData } from '../core/client';

export interface RoomInfo {
  code: string;
  name: string;
  mode: number;
  players: number;
  state: 'waiting' | 'playing';
}

/** one running game room as seen by this browser (local in-page room, or an online room) */
export interface Session {
  game: GameData;
  /** share this to let others join (online rooms only) */
  roomCode?: string;
  dispose(): void;
}

export interface LobbyHandlers {
  onPlayers(names: string[]): void;
  onRooms(rooms: RoomInfo[]): void;
  onChat(name: string, text: string): void;
  onError(message: string): void;
}

export interface LobbyClient {
  /** signs in anonymously and joins the lobby presence + chat channel */
  join(name: string, h: LobbyHandlers): Promise<void>;
  leave(): void;
  readonly joined: boolean;
  say(text: string): void;
  refreshRooms(): Promise<void>;
  /** creates a public room; this browser becomes the host */
  createRoom(roomName: string, playerName: string, events: import('../core/client').ClientEvents): Promise<Session>;
  joinRoom(code: string, playerName: string, events: import('../core/client').ClientEvents): Promise<Session>;
  /** update the public listing (mode / player count / state) — host only */
  publishStatus(session: Session): void;
}
