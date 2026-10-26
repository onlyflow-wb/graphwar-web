// Port of Graphwar/GameData.java: the replicated game state on each client.
// Differences from Java: no threads — the UI (or a test) calls tick(now) each frame; networking goes through `send`.
import {
  ANGLE_ACCELERATION, EXPLOSION_RADIUS, FUNCTION_VELOCITY, GameState, MAX_PLAYERS, NEXT_TURN_DELAY,
  PLANE_LENGTH, SOLDIER_MAX_DEATH_TIME, TEAM1, TEAM2, TURN_TIME, NORMAL_FUNC,
} from './constants';
import { Player, Soldier } from './entities';
import { PolishNotationFunction, MalformedFunction } from './parser';
import { C2S, S2C } from './protocol';
import { Shot, computeShot } from './shot';
import { Terrain } from './terrain';

export interface ClientEvents {
  /** pre-game roster/mode/ready changed */
  onRoster?(): void;
  onChat?(player: Player | null, text: string): void;
  onScreen?(screen: 'pregame' | 'game'): void;
  /** something changed that affects the static game background (turn changed, soldier killed, ...) */
  onGameChanged?(): void;
  onAngle?(): void;
  onFunctionPreview?(text: string): void;
  onStartFiring?(): void;
  onKicked?(reason: string): void;
  onLeader?(): void;
  /** hook for computer players */
  onTurnStart?(player: Player): void;
  onGameEnd?(winners: Player[]): void;
}

export class GameData {
  players: Player[] = [];
  private nextPCs: number[] = [];
  terrain: Terrain | null = null;
  gameMode = NORMAL_FUNC;
  gameState: GameState = GameState.PRE_GAME;
  leader = false;
  currentTurn = -1;
  lastLocalHumanPlayer: Player | null = null;
  timeTurnStarted = 0;
  turnTimeUp = false;
  nextTurnSent = false;

  shot: Shot | null = null;
  drawingFunction = false;
  timeStartedDrawingFunction = 0;
  exploding = false;
  timeStartedExploding = 0;
  soldiersHit: Soldier[] = [];

  angleUp = false;
  angleDown = false;
  timeStartedAngle = 0;

  countingDown = false;
  countdownStarted = 0;
  sayFunc = true;
  showNext = false;
  connected = true;
  /** last applied function preview text from the player whose turn it is (remote players) */
  previewText = '';

  constructor(
    private sendRaw: (m: C2S) => void,
    private clock: () => number,
    public ev: ClientEvents = {},
  ) {}

  now() { return this.clock(); }
  private send(m: C2S) { if (this.connected) this.sendRaw(m); }

  // ------------------------------------------------------------------ queries
  getPlayer(id: number) { return this.players.find(p => p.id === id) ?? null; }
  get firstLocalPlayer() { return this.players.find(p => p.local) ?? null; }
  get currentPlayer(): Player { return this.players[this.currentTurn]; }

  /** whether terrain is drawn mirrored for the viewer (viewer is on team 2) */
  get terrainReversed(): boolean {
    const p = this.lastLocalHumanPlayer ?? this.firstLocalPlayer;
    return p !== null && p.team === TEAM2;
  }
  get functionReversed(): boolean { return this.currentPlayer.team === TEAM2; }

  // ------------------------------------------------------------------ local actions
  addPlayer(name: string) { if (this.players.length < MAX_PLAYERS) this.send({ t: 'ADD_PLAYER', name }); }
  addPC(name: string, level: number) {
    if (this.players.length < MAX_PLAYERS) { this.nextPCs.push(level); this.addPlayer(name); }
  }
  removePlayer(p: Player) { this.send({ t: 'REMOVE_PLAYER', playerId: p.id }); }
  addSoldier(p: Player) { this.send({ t: 'ADD_SOLDIER', playerId: p.id }); }
  removeSoldier(p: Player) { this.send({ t: 'REMOVE_SOLDIER', playerId: p.id }); }
  switchSide(p: Player) { this.send({ t: 'SET_TEAM', team: p.team === TEAM1 ? TEAM2 : TEAM1, playerId: p.id }); }
  nextMode() { this.send({ t: 'NEXT_MODE' }); }
  setReady(p: Player, ready: boolean) { this.send({ t: 'SET_READY', playerId: p.id, ready }); }

  sendChatMessage(text: string, as?: Player) {
    const p = as ?? this.firstLocalPlayer;
    if (as && !as.local) return;
    this.send({ t: 'CHAT_MSG', playerId: p ? p.id : -1, text });
    this.handleCommands(text);
  }

  private handleCommands(msg: string) {
    if (!msg.startsWith('-')) return;
    const m = msg.toLowerCase();
    if (m === '-sayfunc') this.sayFunc = true;
    else if (m === '-stopsayfunc') this.sayFunc = false;
    else if (m === '-shownext') { this.showNext = true; this.ev.onGameChanged?.(); }
    else if (m === '-stopshownext') { this.showNext = false; this.ev.onGameChanged?.(); }
  }

  sendFunctionPreview(text: string) {
    const p = this.currentPlayer;
    if (p?.local && !this.drawingFunction) this.send({ t: 'FUNCTION_PREVIEW', playerId: p.id, func: text });
  }

  /** returns false when the expression is malformed (nothing is sent, as in the original) */
  sendFunction(text: string): boolean {
    const p = this.currentPlayer;
    if (!p || !p.local || this.drawingFunction) return false;
    try { new PolishNotationFunction(text); } catch (e) {
      if (e instanceof MalformedFunction) return false;
      throw e;
    }
    this.send({ t: 'FIRE_FUNC', playerId: p.id, func: text });
    return true;
  }

  // ---- angle (second-order mode) : hold key, angle accelerates quadratically
  private canAdjustAngle() { const p = this.currentPlayer; return !!p && p.local && !p.isComputer; }
  startAngle(up: boolean) {
    if (!this.canAdjustAngle()) return;
    if (up ? this.angleUp : this.angleDown) return;
    // if switching direction mid-press, commit first
    if (this.angleUp || this.angleDown) this.stopAngle();
    this.timeStartedAngle = this.now();
    if (up) this.angleUp = true; else this.angleDown = true;
    this.ev.onAngle?.();
  }
  getAngle(): number {
    const t = this.now() - this.timeStartedAngle;
    let a = ANGLE_ACCELERATION;
    if (this.angleDown) a = -a;
    let cur = this.currentPlayer.currentSoldier.angle;
    if (this.angleUp || this.angleDown) cur += a * t * t;
    return Math.max(-Math.PI / 2, Math.min(Math.PI / 2, cur));
  }
  stopAngle() {
    if (!this.canAdjustAngle()) return;
    if (!this.angleUp && !this.angleDown) return;
    const p = this.currentPlayer;
    const angle = this.getAngle();
    p.currentSoldier.angle = angle;
    this.angleUp = false; this.angleDown = false;
    this.ev.onAngle?.();
    this.send({ t: 'SET_ANGLE', playerId: p.id, soldier: p.currentTurnSoldier, angle });
  }
  setAngle(angle: number) {
    const p = this.currentPlayer;
    if (!p?.local) return;
    p.currentSoldier.angle = angle;
    this.ev.onAngle?.();
    this.send({ t: 'SET_ANGLE', playerId: p.id, soldier: p.currentTurnSoldier, angle });
  }

  // ------------------------------------------------------------------ game end / next turn requests
  private checkGameFinished(): boolean {
    let t1 = false, t2 = false;
    for (const p of this.players) for (let j = 0; j < p.numSoldiers; j++) {
      if (p.soldiers[j].alive) { if (p.team === TEAM1) t1 = true; else t2 = true; }
    }
    return !t1 || !t2;
  }

  private requestNextTurn() {
    if (this.checkGameFinished()) this.send({ t: 'GAME_FINISHED' });
    else this.send({ t: 'READY_NEXT_TURN' });
  }

  disconnect() {
    if (!this.connected) return;
    this.sendRaw({ t: 'DISCONNECT' });
    this.connected = false;
    this.gameState = GameState.NONE;
  }

  // ------------------------------------------------------------------ incoming
  handle(m: S2C) {
    switch (m.t) {
      case 'ADD_PLAYER': return this.onAddPlayer(m);
      case 'SET_TEAM': { const p = this.getPlayer(m.playerId); if (p) { p.team = m.team; this.ev.onRoster?.(); } return; }
      case 'ADD_SOLDIER': { const p = this.getPlayer(m.playerId); if (p) { p.numSoldiers++; this.ev.onRoster?.(); } return; }
      case 'REMOVE_SOLDIER': { const p = this.getPlayer(m.playerId); if (p) { p.numSoldiers--; this.ev.onRoster?.(); } return; }
      case 'REMOVE_PLAYER': return this.onRemovePlayer(m.playerId);
      case 'CHAT_MSG': return this.ev.onChat?.(this.getPlayer(m.playerId), m.text);
      case 'SET_MODE': this.gameMode = m.mode; this.ev.onRoster?.(); return;
      case 'SET_READY': return this.onSetReady(m.playerId, m.ready);
      case 'START_GAME': return this.onStartGame(m);
      case 'NEXT_TURN': return this.onNextTurn();
      case 'FIRE_FUNC': return this.onFire(m.playerId, m.func);
      case 'FUNCTION_PREVIEW': {
        const p = this.getPlayer(m.playerId);
        if (!this.drawingFunction && p && this.players[this.currentTurn]?.id === m.playerId && !p.local) {
          this.previewText = m.func; this.ev.onFunctionPreview?.(m.func);
        }
        return;
      }
      case 'GAME_FINISHED': return this.onFinish();
      case 'SET_ANGLE': {
        const p = this.getPlayer(m.playerId);
        if (p && !p.local && m.soldier >= 0 && m.soldier < p.soldiers.length) { p.soldiers[m.soldier].angle = m.angle; this.ev.onAngle?.(); }
        return;
      }
      case 'NEW_LEADER': this.leader = true; this.ev.onLeader?.(); this.ev.onRoster?.(); return;
      case 'START_COUNTDOWN':
        if (!this.countingDown) { this.countingDown = true; this.countdownStarted = this.now(); }
        this.ev.onRoster?.();
        return;
      case 'REORDER': {
        const np: Player[] = [];
        for (const id of m.order) { const p = this.getPlayer(id); if (p) np.push(p); }
        this.players = np;
        return;
      }
      case 'GAME_FULL':
      case 'DISCONNECT':
        this.connected = false;
        this.gameState = GameState.NONE;
        this.ev.onKicked?.(m.t === 'GAME_FULL' ? 'The game is full or already started.' : 'You have been disconnected.');
        return;
    }
  }

  private onAddPlayer(m: Extract<S2C, { t: 'ADD_PLAYER' }>) {
    if (this.getPlayer(m.playerId)) return;
    const p = new Player(m.name, m.playerId, m.team, m.local, m.numSoldiers, m.ready);
    if (m.local && this.nextPCs.length > 0) { p.isComputer = true; p.aiLevel = this.nextPCs.shift()!; }
    this.players.push(p);
    this.ev.onChat?.(null, `${p.name} has joined the game.`);
    this.ev.onRoster?.();
  }

  private onRemovePlayer(id: number) {
    const p = this.getPlayer(id);
    if (!p) return;
    this.ev.onChat?.(null, `${p.name} has left the game.`);
    if (this.gameState === GameState.GAME) {
      if (this.players[this.currentTurn]?.id === id && !this.drawingFunction) this.requestNextTurn();
      for (let i = 0; i < p.numSoldiers; i++) {
        const s = p.soldiers[i];
        if (s.alive) { s.alive = false; s.setExploding(true, this.now()); }
      }
      p.disconnected = true;
      this.ev.onGameChanged?.();
    } else {
      this.players = this.players.filter(q => q !== p);
      if (!this.players.some(q => q.local) && this.leader === false && this.firstLocalPlayer === null) {
        // original kicked a client that had no local players left; web clients may be spectating the lobby, keep connection
      }
      this.ev.onRoster?.();
    }
  }

  private onSetReady(id: number, ready: boolean) {
    const p = this.getPlayer(id);
    if (!p) return;
    p.ready = ready;
    if (!ready && this.countingDown) {
      this.countingDown = false;
      this.ev.onChat?.(null, 'Game start cancelled.');
    }
    this.ev.onRoster?.();
  }

  private onStartGame(m: Extract<S2C, { t: 'START_GAME' }>) {
    this.countingDown = false;
    this.gameState = GameState.GAME;
    this.drawingFunction = false;
    this.exploding = false;
    this.shot = null;
    this.nextTurnSent = false;
    this.turnTimeUp = false;
    this.terrain = new Terrain(m.circles);
    let i = 0;
    for (const p of this.players) {
      for (let s = 0; s < p.numSoldiers; s++) { p.startSoldier(s, m.soldiers[i], m.soldiers[i + 1]); i += 2; }
      p.restartTurn();
      p.disconnected = false;
    }
    this.currentTurn = Math.abs(m.startPlayer) % this.players.length;
    this.timeTurnStarted = this.now();
    const cur = this.currentPlayer;
    if (cur.local && !cur.isComputer) this.lastLocalHumanPlayer = cur;
    this.ev.onScreen?.('game');
    this.ev.onGameChanged?.();
    if (cur.local && cur.isComputer) this.ev.onTurnStart?.(cur);
  }

  private onNextTurn() {
    if (this.checkGameFinished()) this.send({ t: 'GAME_FINISHED' });
    const n = this.players.length;
    for (let i = 0; i < n; i++) {
      this.currentTurn = (this.currentTurn + 1) % n;
      if (this.players[this.currentTurn].nextTurn()) break;
    }
    const cur = this.currentPlayer;
    if (cur.local && !cur.isComputer) this.lastLocalHumanPlayer = cur;
    this.timeTurnStarted = this.now();
    this.turnTimeUp = false;
    this.drawingFunction = false;
    this.exploding = false;
    this.nextTurnSent = false;
    this.shot = null;
    this.previewText = '';
    this.ev.onAngle?.();
    this.ev.onGameChanged?.();
    if (cur.local && cur.isComputer) this.ev.onTurnStart?.(cur);
  }

  private onFire(playerId: number, func: string) {
    if (this.drawingFunction) return;
    const p = this.getPlayer(playerId);
    if (!p || this.players[this.currentTurn].id !== playerId || !this.terrain) return;
    let shot: Shot;
    try {
      shot = computeShot(this.gameMode, func, this.terrain, this.players, this.currentTurn, p.team, p.currentSoldier.angle);
    } catch (e) {
      if (e instanceof MalformedFunction) return; // another client sent garbage; the sender validates first
      throw e;
    }
    p.currentSoldier.func = func;
    this.shot = shot;
    this.soldiersHit = [];
    for (let i = 0; i < shot.numPlayersHit; i++) {
      const s = this.players[shot.playersHit[i]].soldiers[shot.soldiersHit[i]];
      s.killPosition = shot.soldierHitPosition[i];
      this.soldiersHit.push(s);
    }
    p.currentSoldier.angle = shot.fireAngle;
    this.drawingFunction = true;
    this.timeStartedDrawingFunction = this.now();
    this.ev.onAngle?.();
    this.ev.onStartFiring?.();
    if (this.sayFunc) this.ev.onChat?.(p, func);
  }

  private onFinish() {
    this.gameState = GameState.PRE_GAME;
    this.drawingFunction = false;
    this.exploding = false;
    this.nextTurnSent = false;
    this.shot = null;
    this.countingDown = false;
    const winners: Player[] = [];
    for (const p of this.players) if (p.soldiers.slice(0, p.numSoldiers).some(s => s.alive)) winners.push(p);
    for (const p of winners) this.ev.onChat?.(null, `${p.name} won the game.`);
    this.players = this.players.filter(p => !p.disconnected);
    this.ev.onGameEnd?.(winners);
    this.ev.onScreen?.('pregame');
    this.ev.onRoster?.();
  }

  // ------------------------------------------------------------------ time driven state (replaces GameData.run + paint callbacks)
  remainingTime(): number {
    let t = TURN_TIME - (this.now() - this.timeTurnStarted);
    if (this.drawingFunction || this.exploding) t = TURN_TIME - (this.timeStartedDrawingFunction - this.timeTurnStarted);
    if (t < 0) {
      t = 0;
      if (!this.turnTimeUp) {
        this.turnTimeUp = true;
        if (this.gameState === GameState.GAME) this.send({ t: 'TIME_UP' });
      }
    }
    return t;
  }

  timeExploding(): number {
    const t = this.now() - this.timeStartedExploding;
    if (t > NEXT_TURN_DELAY && this.exploding && !this.nextTurnSent) {
      this.nextTurnSent = true;
      this.requestNextTurn();
    }
    return t;
  }

  /** number of shot samples already "flown"; also advances kills/explosion */
  currentFunctionPosition(): number {
    const shot = this.shot!;
    if (this.exploding) return shot.numSteps;
    const now = this.now();
    let n = Math.floor(((now - this.timeStartedDrawingFunction) * FUNCTION_VELOCITY) / 1000);
    if (n > shot.numSteps && this.drawingFunction) {
      n = shot.numSteps;
      this.exploding = true;
      this.timeStartedExploding = now;
      const lx = this.functionReversed ? PLANE_LENGTH - Math.trunc(shot.lastX) : Math.trunc(shot.lastX);
      this.terrain!.setExplosion(lx, Math.trunc(shot.lastY), EXPLOSION_RADIUS);
      this.terrain!.explodePoint();
      this.ev.onGameChanged?.();
    }
    for (const s of this.soldiersHit) {
      if (!s.alive) {
        if (s.exploding && now - s.timeExplodingStarted > SOLDIER_MAX_DEATH_TIME) s.exploding = false;
        continue;
      }
      if (n > s.killPosition) { s.setExploding(true, now); s.alive = false; this.ev.onGameChanged?.(); }
    }
    return n;
  }

  /** call once per frame */
  tick() {
    if (this.gameState !== GameState.GAME || this.currentTurn < 0) return;
    if (this.drawingFunction) this.currentFunctionPosition();
    if (this.exploding) this.timeExploding();
    this.remainingTime();
  }
}

