// Tests for src/net/online.ts against an in-memory Supabase stand-in (test/fakes.ts). The stand-in enforces the same
// channel/table access rules as the SQL migration. NOT a test against a live Supabase project.
import { describe, expect, it } from 'vitest';
import { GameState, START_GAME_DELAY } from '../src/core/constants';
import type { ClientEvents } from '../src/core/client';
import { HostSession, OnlineClient, DROP_MS, addressOf } from '../src/net/online';
import type { LobbyHandlers, RoomInfo } from '../src/net/types';
import { FakeClock, Hub, fakeSupabase, settle } from './fakes';

function world() {
  const clock = new FakeClock();
  const hub = new Hub(clock);
  const client = (uid: string) => new OnlineClient(fakeSupabase(hub, uid), clock);
  return { clock, hub, client };
}
const quiet = (): ClientEvents => ({});

async function hostAndGuest(opts: { strictJoin?: boolean } = {}) {
  const w = world();
  w.hub.strictJoin = !!opts.strictJoin;
  const kicked: string[] = [];
  const hostNet = w.client('host-user'), guestNet = w.client('guest-user');
  const host = await hostNet.createRoom('Test room', 'Hosty', quiet());
  await settle();
  const guest = await guestNet.joinRoom(host.roomCode!, 'Guesty', { onKicked: m => kicked.push(m) });
  host.game.addPlayer('Hosty'); guest.game.addPlayer('Guesty');
  await settle(); await w.clock.advance(100);
  return { ...w, hostNet, guestNet, host: host as HostSession, guest, kicked };
}

describe('lobby (presence, chat, room list)', () => {
  it('shows online players, delivers chat to everyone, lists fresh rooms with sanitised fields', async () => {
    const { client, clock, hub } = world();
    const a = client('ua'), b = client('ub');
    const seen: { players: string[]; rooms: RoomInfo[]; chat: string[] } = { players: [], rooms: [], chat: [] };
    const h = (): LobbyHandlers => ({ onPlayers: n => (seen.players = n), onRooms: r => (seen.rooms = r), onChat: (w, t) => seen.chat.push(`${w}: ${t}`), onError: m => { throw new Error(m); } });
    await a.join('Ada', h());
    await b.join('Bob', h());
    await settle();
    expect(seen.players).toEqual(['Ada', 'Bob']);
    b.say('hello <b>all</b>');
    await settle();
    expect(seen.chat.filter(x => x === 'Bob: hello <b>all</b>').length).toBe(2); // both clients got it (text kept raw; UI uses textContent)

    hub.rooms.push({ code: 'ZZZZ9', host_id: 'x', name: 'Zed', mode: 7 as number, players: 99, state: 'weird', created_at: clock.t, updated_at: clock.t });
    hub.rooms.push({ code: 'bad code!', host_id: 'y', name: 'Bad', mode: 0, players: 0, state: 'waiting', created_at: clock.t, updated_at: clock.t });
    await a.refreshRooms();
    expect(seen.rooms).toEqual([{ code: 'ZZZZ9', name: 'Zed', mode: 2, players: 10, state: 'waiting' }]);
    a.leave(); b.leave();
  });

  it('room list refreshes by itself and hides rooms whose host stopped heartbeating', async () => {
    const { client, clock, hub } = world();
    const a = client('ua');
    let rooms: RoomInfo[] = [];
    await a.join('Ada', { onPlayers() {}, onRooms: r => (rooms = r), onChat() {}, onError() {} });
    expect(rooms).toEqual([]);
    hub.rooms.push({ code: 'LIVE1', host_id: 'x', name: 'Live', mode: 0, players: 1, state: 'waiting', created_at: clock.t, updated_at: clock.t });
    await clock.advance(5100);
    expect(rooms.map(r => r.code)).toEqual(['LIVE1']);
    await clock.advance(121_000);               // heartbeat older than 2 min -> invisible (mirrors the RLS policy)
    expect(rooms).toEqual([]);
    a.leave();
  });
});

describe('creating and joining a room', () => {
  it('host inserts a row, guest joins by code and both see the same roster', async () => {
    const { hub, host, guest } = await hostAndGuest();
    expect(hub.rooms).toHaveLength(1);
    expect(hub.rooms[0].host_id).toBe('host-user');
    expect(host.game.players.map(p => p.name).sort()).toEqual(['Guesty', 'Hosty']);
    expect(guest.game.players.map(p => p.name).sort()).toEqual(['Guesty', 'Hosty']);
    expect(host.game.leader).toBe(true);
    expect(guest.game.leader).toBe(false);
    expect(host.game.players.find(p => p.name === 'Hosty')!.local).toBe(true);
    expect(guest.game.players.find(p => p.name === 'Hosty')!.local).toBe(false);
    host.dispose(); guest.dispose();
  });

  it('works when Realtime refuses to join the write-only in:<CODE> channel (HTTP-fallback path)', async () => {
    const { hub, host, guest } = await hostAndGuest({ strictJoin: true });
    expect(hub.rejected).toEqual([]);
    expect(guest.game.players).toHaveLength(2);
    host.dispose(); guest.dispose();
  });

  it('the public room row follows players / mode / state (debounced)', async () => {
    const { hub, clock, host, guest } = await hostAndGuest();
    host.game.nextMode();
    await settle(); await clock.advance(1000);
    expect(hub.rooms[0]).toMatchObject({ players: 2, mode: 1, state: 'waiting' });
    host.dispose(); guest.dispose();
  });

  it('rejects bad codes, unknown rooms, and a second room from the same host replaces the first', async () => {
    const { client, hub } = world();
    const g = client('g');
    await expect(g.joinRoom('x', 'n', quiet())).rejects.toThrow('Invalid room code');
    await expect(g.joinRoom('NOPE1', 'n', quiet())).rejects.toThrow('Room not found');
    const h = client('h');
    await h.createRoom('One', 'n', quiet());
    await h.createRoom('Two', 'n', quiet());
    expect(hub.rooms.map(r => r.name)).toEqual(['Two']);
  });

  it('refuses to join a room whose game has started, and a full room', async () => {
    const { hub, clock, client, host, guest } = await hostAndGuest();
    host.game.setReady(host.game.players.find(p => p.local)!, true);
    guest.game.setReady(guest.game.players.find(p => p.local)!, true);
    await settle(); await clock.advance(START_GAME_DELAY + 300);
    await clock.advance(1000);
    expect(host.server.gameState).toBe(GameState.GAME);
    expect(hub.rooms[0].state).toBe('playing');
    await expect(client('late').joinRoom(host.roomCode!, 'Late', quiet())).rejects.toThrow('already started');
    host.dispose(); guest.dispose();
  });
});

describe('three browsers in one room', () => {
  it('each guest only treats its OWN players as local (messages are addressed per guest)', async () => {
    const w = await hostAndGuest();
    const kicked2: string[] = [];
    const guest2 = await w.client('guest2-user').joinRoom(w.host.roomCode!, 'Third', { onKicked: m => kicked2.push(m) });
    guest2.game.addPlayer('Third');
    await settle(); await w.clock.advance(1200);   // > 800 ms status debounce
    for (const [who, g] of [['host', w.host.game], ['guest1', w.guest.game], ['guest2', guest2.game]] as const) {
      expect(g.players.map(p => p.name).sort(), who).toEqual(['Guesty', 'Hosty', 'Third']);
      expect(g.players.filter(p => p.local).map(p => p.name), who).toEqual([{ host: 'Hosty', guest1: 'Guesty', guest2: 'Third' }[who]]);
    }
    expect(w.hub.rooms[0].players).toBe(3);
    w.host.dispose(); w.guest.dispose(); guest2.dispose();
  });
});

describe('playing a round over the wire', () => {
  it('both clients start with identical maps and see the same shot', async () => {
    const { clock, host, guest } = await hostAndGuest();
    const hp = host.game.players.find(p => p.local)!, gp = guest.game.players.find(p => p.local)!;
    host.game.setReady(hp, true); guest.game.setReady(gp, true);
    await settle(); await clock.advance(START_GAME_DELAY + 300);

    expect(host.game.gameState).toBe(GameState.GAME);
    expect(guest.game.gameState).toBe(GameState.GAME);
    const pos = (g: typeof host.game) => g.players.map(p => p.soldiers.slice(0, p.numSoldiers).map(s => [s.x, s.y]));
    expect(pos(guest.game)).toEqual(pos(host.game));
    expect(guest.game.terrain!.circles ?? guest.game.terrain).toEqual(host.game.terrain!.circles ?? host.game.terrain);
    expect(guest.game.currentTurn).toBe(host.game.currentTurn);

    const shooterIsHost = host.game.currentPlayer.local;
    const [shooter, watcher] = shooterIsHost ? [host, guest] : [guest, host];
    expect(shooter.game.sendFunction('x/10')).toBe(true);
    await settle(); await clock.advance(200);
    expect(watcher.game.shot).not.toBeNull();
    expect(watcher.game.shot!.numSteps).toBe(shooter.game.shot!.numSteps);
    expect(watcher.game.drawingFunction).toBe(true);
    host.dispose(); guest.dispose();
  });

  it('a spectator-side client cannot fire for someone else (server rejects)', async () => {
    const { clock, host, guest } = await hostAndGuest();
    host.game.setReady(host.game.players.find(p => p.local)!, true);
    guest.game.setReady(guest.game.players.find(p => p.local)!, true);
    await settle(); await clock.advance(START_GAME_DELAY + 300);
    const notMine = host.game.currentPlayer.local ? guest : host;
    // forge a FIRE_FUNC for the current player through the legit channel of the wrong client
    const cur = (notMine === host ? guest : host).game.currentPlayer;
    (notMine.game as unknown as { sendRaw: (m: unknown) => void }).sendRaw({ t: 'FIRE_FUNC', playerId: cur.id, func: 'x' });
    await settle(); await clock.advance(200);
    expect(host.game.drawingFunction).toBe(false);
    expect(guest.game.drawingFunction).toBe(false);
    host.dispose(); guest.dispose();
  });
});

describe('security of the transport', () => {
  it('a guest cannot write the host->all channel (cannot forge host messages)', async () => {
    const { hub, host, guest } = await hostAndGuest();
    const forged = (guest as unknown as { out: { send(m: unknown): Promise<string> } }).out;
    const r = await forged.send({ type: 'broadcast', event: 'S2C', payload: { to: '*', msgs: [{ t: 'START_GAME', circles: [], soldiers: [], startPlayer: 0 }] } });
    expect(r).toBe('error');
    expect(hub.rejected.some(x => x.startsWith('guest-user -> room:'))).toBe(true);
    await settle();
    expect(host.game.gameState).toBe(GameState.PRE_GAME);
    expect(guest.game.gameState).toBe(GameState.PRE_GAME);
    host.dispose(); guest.dispose();
  });

  it('other users cannot read in:<CODE> (guest keys stay secret) and cannot act with a guessed key', async () => {
    const w = await hostAndGuest();
    const eve = w.client('eve');
    const sb = (eve as unknown as { sb: ReturnType<typeof fakeSupabase> }).sb;
    const heard: unknown[] = [];
    const ch = sb.channel(`in:${w.host.roomCode}`, { config: { private: true } });
    ch.on('broadcast', { event: 'C2S' }, (m: unknown) => heard.push(m));
    await expect(new Promise((res, rej) => ch.subscribe(s => (s === 'SUBSCRIBED' ? res(0) : rej(new Error(s)))))).resolves.toBe(0); // permissive join...
    w.guest.game.sendChatMessage('secret?');
    await settle();
    expect(heard).toEqual([]);                                       // ...but nothing is delivered to a non-host

    // Eve can WRITE to in:CODE but has no joined key -> ignored
    const before = w.host.game.players.length;
    await ch.send({ type: 'broadcast', event: 'C2S', payload: { key: 'f'.repeat(32), kind: 'msg', msg: { t: 'REMOVE_PLAYER', playerId: w.guest.game.players.find(p => p.local)!.id } } });
    await settle();
    expect(w.host.game.players.length).toBe(before);
    w.host.dispose(); w.guest.dispose();
  });

  it('malformed payloads are ignored and do not crash the host', async () => {
    const w = await hostAndGuest();
    const inn = (w.guest as unknown as { inn: { send(m: unknown): Promise<string> } }).inn;
    for (const payload of [null, 5, 'x', [], {}, { key: 5 }, { key: 'short' }, { key: 'k'.repeat(99) }, { key: 'a'.repeat(32), kind: 'msg' }, { key: 'a'.repeat(32), kind: 'join', msg: 3 }]) {
      await inn.send({ type: 'broadcast', event: 'C2S', payload });
    }
    await settle();
    expect(w.host.game.players).toHaveLength(2);
    w.host.dispose(); w.guest.dispose();
  });

  it('a flooding guest is rate limited', async () => {
    const w = await hostAndGuest();
    let chats = 0;
    (w.host.game.ev as ClientEvents).onChat = () => { chats++; };
    const me = w.guest.game.players.find(p => p.local)!;
    for (let i = 0; i < 300; i++) w.guest.game.sendChatMessage(`spam ${i}`, me);
    await settle(8);
    expect(chats).toBeGreaterThan(10);
    expect(chats).toBeLessThanOrEqual(61);
    w.host.dispose(); w.guest.dispose();
  });

  it('addresses are hashes, never the secret key', async () => {
    const a = await addressOf('0123456789abcdef0123456789abcdef');
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toContain('0123456789abcdef');
  });
});

describe('keepalive and closing (original TIMEOUT_KEEPALIVE / TIMEOUT_DROP)', () => {
  it('a guest that goes silent is dropped by the host; its players disappear', async () => {
    const w = await hostAndGuest();
    (w.guest as unknown as { stops: (() => void)[] }).stops.forEach(s => s());   // guest stops pinging (tab frozen / offline)
    await w.clock.advance(DROP_MS + 6000);
    expect(w.host.game.players.map(p => p.name)).toEqual(['Hosty']);
    w.host.dispose(); w.guest.dispose();
  });

  it('a healthy guest is NOT dropped over a long time (pings keep it alive)', async () => {
    const w = await hostAndGuest();
    await w.clock.advance(120_000);
    expect(w.host.game.players).toHaveLength(2);
    expect(w.guest.game.players).toHaveLength(2);
    expect(w.kicked).toEqual([]);
    w.host.dispose(); w.guest.dispose();
  });

  it('a guest notices when the host disappears', async () => {
    const w = await hostAndGuest();
    (w.host as unknown as { stops: (() => void)[] }).stops.forEach(s => s());     // host stops its PINGs
    await w.clock.advance(DROP_MS + 6000);
    expect(w.kicked).toEqual(['Lost connection to the host.']);
  });

  it('closing the room deletes the row and kicks the guests', async () => {
    const w = await hostAndGuest();
    w.host.dispose();
    await settle(8);
    expect(w.hub.rooms).toHaveLength(0);
    expect(w.kicked).toEqual(['You have been disconnected.']);
  });

  it('a guest leaving removes only its own players', async () => {
    const w = await hostAndGuest();
    w.guest.game.disconnect();
    await settle(); await w.clock.advance(200);
    expect(w.host.game.players.map(p => p.name)).toEqual(['Hosty']);
    w.host.dispose(); w.guest.dispose();
  });
});
