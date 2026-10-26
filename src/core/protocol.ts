// Typed replacement for GraphServer/NetworkProtocol.java (which used "id&field&field" strings over TCP).
// Same message set and semantics, JSON-serialisable so it can travel over Supabase Realtime broadcast.

export type C2S =
  | { t: 'ADD_PLAYER'; name: string }
  | { t: 'SET_TEAM'; team: number; playerId: number }
  | { t: 'REMOVE_PLAYER'; playerId: number }
  | { t: 'ADD_SOLDIER'; playerId: number }
  | { t: 'REMOVE_SOLDIER'; playerId: number }
  | { t: 'CHAT_MSG'; playerId: number; text: string }
  | { t: 'NEXT_MODE' }
  | { t: 'SET_READY'; playerId: number; ready: boolean }
  | { t: 'READY_NEXT_TURN' }
  | { t: 'FIRE_FUNC'; playerId: number; func: string }
  | { t: 'FUNCTION_PREVIEW'; playerId: number; func: string }
  | { t: 'TIME_UP' }
  | { t: 'GAME_FINISHED' }
  | { t: 'SET_ANGLE'; playerId: number; soldier: number; angle: number }
  | { t: 'DISCONNECT' };

export type S2C =
  | { t: 'ADD_PLAYER'; playerId: number; name: string; team: number; local: boolean; numSoldiers: number; ready: boolean }
  | { t: 'SET_TEAM'; team: number; playerId: number }
  | { t: 'REMOVE_PLAYER'; playerId: number }
  | { t: 'ADD_SOLDIER'; playerId: number }
  | { t: 'REMOVE_SOLDIER'; playerId: number }
  | { t: 'CHAT_MSG'; playerId: number; text: string }
  | { t: 'SET_MODE'; mode: number }
  | { t: 'SET_READY'; playerId: number; ready: boolean }
  | { t: 'START_GAME'; circles: number[]; soldiers: number[]; startPlayer: number }
  | { t: 'NEXT_TURN' }
  | { t: 'FIRE_FUNC'; playerId: number; func: string }
  | { t: 'FUNCTION_PREVIEW'; playerId: number; func: string }
  | { t: 'GAME_FINISHED' }
  | { t: 'SET_ANGLE'; playerId: number; soldier: number; angle: number }
  | { t: 'NEW_LEADER' }
  | { t: 'START_COUNTDOWN' }
  | { t: 'REORDER'; order: number[] }
  | { t: 'GAME_FULL' }
  | { t: 'DISCONNECT' };

/** Hard limits added in the web port (the Java server trusted clients blindly). */
export const LIMITS = { NAME: 24, CHAT: 200, FUNC: 400 } as const;
