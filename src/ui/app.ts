// Application shell: owns the stage, the screens and the current game session.
import type { ClientEvents } from '../core/client';
import { LocalSession } from '../core/session';
import type { LobbyClient, Session } from '../net/types';
import { el, fitStage } from './dom';
import { GameScreen } from './game-screen';
import { LobbyScreen } from './lobby-screen';
import { MenuScreen } from './menu-screen';
import { PregameScreen } from './pregame-screen';
import { loadSprites } from './plane';
import { preloadUi } from './preload';

export type ScreenName = 'menu' | 'pregame' | 'lobby' | 'game';

export class App {
  readonly stage: HTMLElement;
  readonly touchbar: HTMLElement;
  menu!: MenuScreen;
  pregame!: PregameScreen;
  game!: GameScreen;
  lobby!: LobbyScreen;
  session: Session | null = null;
  current: ScreenName = 'menu';
  private tickTimer: number | undefined;
  readonly coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  constructor(readonly net: LobbyClient | null) {
    this.stage = document.getElementById('stage')!;
    this.touchbar = document.getElementById('touchbar')!;
  }

  /** forwards client events to whichever screens exist */
  readonly events: ClientEvents = {
    onRoster: () => this.pregame?.refresh(),
    onChat: (p, t) => {
      if (this.current === 'game') this.game.addChat(p, t);
      else this.pregame.addChat(p, t);
    },
    onScreen: s => this.show(s),
    onGameChanged: () => this.game?.refreshBack(),
    onAngle: () => this.game?.angleChanged(),
    onFunctionPreview: t => this.game?.showPreview(t),
    onKicked: msg => this.kicked(msg),
    onLeader: () => this.pregame?.refresh(),
    onGameEnd: () => this.net && this.session && this.net.publishStatus(this.session),
  };

  async start() {
    const loading = el('div', 'label', this.stage);
    loading.textContent = 'Loading…';
    loading.style.cssText += ';left:0;top:260px;width:800px;height:60px;';
    this.fit();
    window.addEventListener('resize', () => this.fit());
    window.visualViewport?.addEventListener('resize', () => this.fit());
    const [sprites] = await Promise.all([loadSprites(), preloadUi()]);
    loading.remove();
    this.menu = new MenuScreen(this);
    this.pregame = new PregameScreen(this);
    this.lobby = new LobbyScreen(this);
    this.game = new GameScreen(this, sprites);
    this.show('menu');
    this.fit();
    // game clock: independent of rendering so hidden tabs keep the match moving
    this.tickTimer = window.setInterval(() => this.session?.game.tick(), 50);
  }

  fit() {
    const bar = this.coarse && this.current === 'game' ? 44 : 0;
    this.touchbar.hidden = bar === 0;
    fitStage(this.stage, bar);
    const s = Math.min(window.innerWidth / 800, (window.innerHeight - bar) / 600);
    this.game?.setScale(s * (window.devicePixelRatio || 1));
  }

  show(name: ScreenName) {
    this.current = name;
    const all = { menu: this.menu, pregame: this.pregame, lobby: this.lobby, game: this.game };
    for (const [k, s] of Object.entries(all)) s.setShown(k === name);
    if (name === 'pregame') this.pregame.refresh();
    if (name === 'game') this.game.onStart();
    this.fit();
  }

  // ------------------------------------------------------------------ sessions
  startLocal(name: string) {
    this.endSession();
    const s = new LocalSession(undefined, this.events);
    this.session = s;
    this.pregame.reset(false);
    s.game.leader = true; // server tells us too, but the board is rendered before the message arrives
    s.game.addPlayer(name);
    this.show('pregame');
  }

  async createOnline(roomName: string, playerName: string): Promise<void> {
    if (!this.net) throw new Error('Online play is not configured.');
    this.endSession();
    this.pregame.reset(true);
    this.session = await this.net.createRoom(roomName, playerName, this.events);
    this.session.game.addPlayer(playerName);
    this.show('pregame');
  }

  async joinOnline(code: string, playerName: string): Promise<void> {
    if (!this.net) throw new Error('Online play is not configured.');
    this.endSession();
    this.pregame.reset(true);
    this.session = await this.net.joinRoom(code, playerName, this.events);
    this.session.game.addPlayer(playerName);
    this.show('pregame');
  }

  /** leave the current room (and tell the others) */
  endSession() {
    const s = this.session;
    if (!s) return;
    this.session = null;
    try { s.game.disconnect(); } catch { /* already gone */ }
    // let the DISCONNECT message leave before tearing the transport down
    setTimeout(() => s.dispose(), 50);
    this.game?.stop();
  }

  leaveRoom() {
    this.endSession();
    this.show(this.net?.joined ? 'lobby' : 'menu');
  }

  private kicked(msg: string) {
    const where: ScreenName = this.current === 'game' ? 'game' : 'pregame';
    (where === 'game' ? this.game : this.pregame).showMessage(msg, () => this.leaveRoom());
  }

  dispose() { clearInterval(this.tickTimer); }
}
