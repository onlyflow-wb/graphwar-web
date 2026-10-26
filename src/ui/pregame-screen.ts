import { COMPUTER_LEVEL_MEAN_VALUE, COMPUTER_LEVEL_MIN_VALUE, COMPUTER_LEVEL_STANDARD_DEVIATION, COMPUTER_NAMES,
  FST_ODE, MAX_SOLDIERS_PER_PLAYER, NORMAL_FUNC, SND_ODE, START_GAME_DELAY, TEAM1, TEAM2 } from '../core/constants';
import type { Player } from '../core/entities';
import { defaultRng, nextGaussian, nextInt } from '../core/rng';
import type { App } from './app';
import { ChatBox, ImgButton, el, image, px, textField } from './dom';
import { Dialog, FieldDialog, MessageDialog, Screen } from './screen';

const BOARD = { x: 25, y: 75, w: 200, h: 15, team2: 225 };

export class PregameScreen extends Screen {
  private board: HTMLElement;
  private chat: ChatBox;
  private chatField: HTMLInputElement;
  private modeBtns: ImgButton[];
  private readyOff: ImgButton;
  private readyOn: ImgButton;
  private globalBtn: ImgButton;
  private addLocal: FieldDialog;
  private addPc: FieldDialog;
  private msg: MessageDialog;
  private codeLabel: HTMLElement;
  private countdown: number | undefined;
  private online = false;

  constructor(private app: App) {
    super(app.stage);
    const r = this.root;
    image(r, 'team1.png', 58, 7);
    image(r, 'team2.png', 283, 7);
    image(r, 'shadowChatPreGame.png', 460, 35);
    image(r, 'shadowChatFieldGame.png', 460, 435);

    this.board = px(el('div', 'abs', r), BOARD.x, BOARD.y, BOARD.team2 + BOARD.w, 10 * BOARD.h);
    this.chat = new ChatBox(r, 475, 50, 300, 375);
    this.chatField = textField(r, 475, 450, 300, 200);
    this.chatField.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const t = this.chatField.value;
      if (t) { this.app.session?.game.sendChatMessage(t); this.chatField.value = ''; }
    });

    this.modeBtns = [
      new ImgButton(r, 'funcNormal.png', 'funcNormalOver.png', 15, 395, () => this.nextMode(), 'Game mode: y = f(x)'),
      new ImgButton(r, 'funcFst.png', 'funcFstOver.png', 15, 395, () => this.nextMode(), "Game mode: y' = f(x, y)"),
      new ImgButton(r, 'funcSnd.png', 'funcSndOver.png', 15, 395, () => this.nextMode(), "Game mode: y'' = f(x, y, y')"),
    ];
    new ImgButton(r, 'back.png', 'backOver.png', 15, 530, () => this.app.leaveRoom(), 'Leave this game');
    new ImgButton(r, 'addLocalPlayer.png', 'addLocalPlayerOver.png', 165, 410, () => this.openAddLocal(), 'Add a local player');
    new ImgButton(r, 'addComputerPlayer.png', 'addComputerPlayerOver.png', 165, 470, () => this.openAddPc(), 'Add a computer player');
    // "ready" art: unchecked tick is `readyNormal`, ticked is `readyOver` (hover swaps them, like the original)
    this.readyOff = new ImgButton(r, 'readyNormal.png', 'readyOver.png', 600, 470, () => this.setAllReady(true), 'Ready');
    this.readyOn = new ImgButton(r, 'readyOver.png', 'readyNormal.png', 600, 470, () => this.setAllReady(false), 'Not ready');
    this.globalBtn = new ImgButton(r, 'globalRoom.png', 'globalRoomOver.png', 215, 530, () => this.app.show('lobby'), 'Back to the lobby');

    this.codeLabel = el('div', 'label', r);
    px(this.codeLabel, 460, 5, 330, 28);
    this.codeLabel.style.fontSize = '16px';

    this.addLocal = new FieldDialog(r, {
      bg: 'backAddPlayer.png', yesImg: ['add.png', 'addOver.png'], onYes: () => {
        const n = this.addLocal.name.value.trim();
        if (!n) return;
        this.app.session?.game.addPlayer(n);
        this.addLocal.show(false);
      },
    });
    this.addPc = new FieldDialog(r, {
      bg: 'backAddCompPlayer.png', second: true, yesImg: ['add.png', 'addOver.png'], secondMax: 9, onYes: () => this.doAddPc(),
    });
    this.msg = new MessageDialog(r);
  }

  reset(online: boolean) {
    this.online = online;
    this.chat.clear();
    this.board.textContent = '';
    this.chatField.value = '';
    clearInterval(this.countdown);
  }

  addChat(p: Player | null, text: string) { this.chat.add(p ? p.name : null, p ? p.color : null, text); }
  showMessage(text: string, onOk?: () => void) { this.msg.open_(text, onOk); }

  private nextMode() { this.app.session?.game.nextMode(); }

  private setAllReady(ready: boolean) {
    const g = this.app.session?.game;
    if (!g) return;
    for (const p of g.players) if (p.local) g.setReady(p, ready);
  }

  private openAddLocal() { this.addLocal.name.value = ''; this.addLocal.open_(); }

  private openAddPc() {
    this.addPc.name.value = COMPUTER_NAMES[nextInt(defaultRng, COMPUTER_NAMES.length)];
    let level = Math.trunc(COMPUTER_LEVEL_MEAN_VALUE + COMPUTER_LEVEL_STANDARD_DEVIATION * nextGaussian(defaultRng));
    if (level < COMPUTER_LEVEL_MIN_VALUE) level = COMPUTER_LEVEL_MIN_VALUE;
    this.addPc.second!.value = String(level);
    this.addPc.open_(false);
  }

  private doAddPc() {
    const name = this.addPc.name.value.trim();
    if (!name) return;
    const txt = this.addPc.second!.value.trim();
    let level: number;
    if (/^over 9000$/i.test(txt)) level = 9001;
    else if (/^\d+$/.test(txt)) {
      level = Number(txt);
      if (!Number.isSafeInteger(level) || level > 9000) { this.addPc.second!.value = 'Over 9000'; return; }
    } else return;
    this.app.session?.game.addPC(name, level);
    this.addPc.show(false);
  }

  /** rebuild everything that depends on the roster */
  refresh() {
    const s = this.app.session;
    if (!s || this.root.hidden === undefined) return;
    const g = s.game;
    this.modeBtns.forEach((b, i) => b.show(g.gameMode === [NORMAL_FUNC, FST_ODE, SND_ODE][i]));
    const mine = g.players.filter(p => p.local);
    const allReady = mine.length > 0 && mine.every(p => p.ready);
    this.readyOn.show(allReady);
    this.readyOff.show(!allReady);
    this.globalBtn.show(!!this.app.net?.joined);
    this.codeLabel.textContent = s.roomCode ? `Room code: ${s.roomCode}` : '';
    this.renderBoard();
    if (g.countingDown) this.runCountdown(g.countdownStarted);
    else { clearInterval(this.countdown); this.countdown = undefined; }
    if (this.online) this.app.net?.publishStatus(s);
  }

  private runCountdown(started: number) {
    if (this.countdown !== undefined) return;
    let left = Math.round(START_GAME_DELAY / 1000);
    const g = this.app.session?.game;
    const step = () => {
      if (!g || !g.countingDown || left <= 0) { clearInterval(this.countdown); this.countdown = undefined; return; }
      this.chat.add(null, null, `Game starting in ${left}...`);
      left--;
    };
    void started;
    step();
    this.countdown = window.setInterval(step, 1000);
  }

  private renderBoard() {
    const g = this.app.session!.game;
    this.board.textContent = '';
    let y1 = 0, y2 = 0;
    for (const p of g.players) {
      const team2 = p.team === TEAM2;
      const row = el('div', 'row', this.board);
      px(row, team2 ? BOARD.team2 : 0, team2 ? y2 : y1, BOARD.w, BOARD.h);
      row.style.background = p.ready ? '#0f0' : '#fff';
      if (team2) y2 += BOARD.h; else y1 += BOARD.h;
      const nm = el('span', 'nm', row);
      nm.textContent = p.name;
      nm.style.maxWidth = '90px';
      nm.style.color = '#000';

      const can = p.local || g.leader;
      const inner = (x: number) => x - 1; // row has a 1px border
      const sw = new ImgButton(row, 'arrowLeftBlack.png', can ? 'arrowLeftRed.png' : 'arrowLeftGray.png', inner(95), -1, () => g.switchSide(p), 'Switch team');
      const soldiers: ImgButton[] = [];
      for (let i = 0; i < MAX_SOLDIERS_PER_PLAYER; i++) {
        const filled = i < p.numSoldiers;
        const b = new ImgButton(row, filled ? 'soldierMenu.png' : 'soldierGhost.png', 'soldierMenuOver.png', inner(185 - 15 * (i + 1)), -1,
          () => g.addSoldier(p), 'Click: add soldier · right-click or long-press: remove');
        b.el.addEventListener('contextmenu', ev => { ev.preventDefault(); g.removeSoldier(p); });
        this.longPress(b.el, () => g.removeSoldier(p));
        soldiers.push(b);
      }
      const rm = new ImgButton(row, 'blackX.png', can ? 'redX.png' : 'grayX.png', inner(185), -1, () => g.removePlayer(p), 'Remove player');
      if (team2) for (const b of [sw, rm, ...soldiers]) b.setMirror(true);
    }
  }

  private longPress(e: HTMLElement, fn: () => void) {
    let t: number | undefined;
    e.addEventListener('pointerdown', ev => {
      if (ev.pointerType === 'mouse') return;
      t = window.setTimeout(() => { t = undefined; fn(); suppress = true; }, 550);
    });
    let suppress = false;
    const cancel = () => { if (t !== undefined) { clearTimeout(t); t = undefined; } };
    e.addEventListener('pointerup', cancel);
    e.addEventListener('pointerleave', cancel);
    e.addEventListener('click', ev => { if (suppress) { suppress = false; ev.stopImmediatePropagation(); } }, true);
  }
}

export { Dialog, TEAM1 };
