import { NORMAL_FUNC, FST_ODE, SND_ODE, TEAM1 } from '../core/constants';
import type { Player } from '../core/entities';
import type { App } from './app';
import { ChatBox, ImgButton, el, image, textField } from './dom';
import { PlaneView } from './plane';
import { Dialog, MessageDialog, Screen } from './screen';

type Sprites = Awaited<ReturnType<typeof import('./plane').loadSprites>>;

const KEYS: [string, string][] = [
  ['x', 'x'], ['y', 'y'], ["y'", "y'"], ['(', '('], [')', ')'], ['+', '+'], ['−', '-'], ['×', '*'], ['÷', '/'], ['^', '^'],
  ['√', 'sqrt('], ['abs', 'abs('], ['sin', 'sin('], ['cos', 'cos('], ['tan', 'tan('], ['ln', 'ln('], ['log', 'log('], ['exp', 'exp('],
  ['π', 'pi'], ['e', 'e'], ['.', '.'],
];

export class GameScreen extends Screen {
  private plane: PlaneView;
  private angleCanvas: HTMLCanvasElement;
  private timer: HTMLElement;
  private modeImgs: HTMLImageElement[];
  private funcField: HTMLInputElement;
  private chatField: HTMLInputElement;
  private chat: ChatBox;
  private globalBtn: ImgButton;
  private quit: Dialog;
  private msg: MessageDialog;
  private toast: HTMLElement;
  private raf = 0;
  private shown = false;
  private turnKey = '';
  private previewTimer: number | undefined;
  private k = 1;

  constructor(private app: App, sprites: Sprites) {
    super(app.stage);
    const r = this.root;
    image(r, 'backGame.png', 0, 0);
    image(r, 'shadowChatFieldGame.png', 470, 550);
    image(r, 'shadowFuncField.png', 180, 465);
    image(r, 'shadowChatGame.png', 470, 465);
    image(r, 'backAngle.png', -2, 463);
    image(r, 'timer.png', 135, 548);
    image(r, 'timer.png', 205, 548);
    this.modeImgs = ['y.png', 'dy.png', 'ddy.png'].map(f => image(r, f, 125, 468));

    this.plane = new PlaneView(r, app.session?.game ?? ({} as never), sprites);
    this.angleCanvas = el('canvas', 'angle', r);
    this.timer = el('div', 'timer', r);

    new ImgButton(r, 'fire.png', 'fireOverRed.png', 115, 500, () => this.fire(), 'Fire');
    new ImgButton(r, 'quit.png', 'quitOver.png', 290, 545, () => this.quit.show(true), 'Quit');
    this.globalBtn = new ImgButton(r, 'globalRoom.png', 'globalRoomOver.png', 290, 500, () => this.app.show('lobby'), 'Lobby');

    this.funcField = textField(r, 195, 480, 275, 400);
    this.chatField = textField(r, 485, 565, 300, 200);
    this.chat = new ChatBox(r, 485, 480, 300, 75);
    this.toast = el('div', 'toast', r);

    this.funcField.addEventListener('keydown', e => { if (e.key === 'Enter') this.fire(); });
    this.funcField.addEventListener('input', () => this.queuePreview());
    this.chatField.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const t = this.chatField.value;
      if (t) { this.app.session?.game.sendChatMessage(t); this.chatField.value = ''; }
    });

    // quit confirmation
    this.quit = new Dialog(r);
    image(this.quit.group, 'backQuitConfirm.png', 184, 184);
    Dialog.interactive(new ImgButton(this.quit.group, 'yes.png', 'yesOver.png', 200, 240, () => { this.quit.show(false); this.app.leaveRoom(); }, 'Yes').el);
    Dialog.interactive(new ImgButton(this.quit.group, 'no.png', 'noOver.png', 400, 240, () => this.quit.show(false), 'No').el);
    this.msg = new MessageDialog(r);

    document.addEventListener('keydown', e => this.key(e, true));
    document.addEventListener('keyup', e => this.key(e, false));
    this.buildTouchBar();
  }

  setScale(k: number) { this.k = k; this.plane.setScale(k); this.sizeAngle(); }
  private sizeAngle() {
    const k = Math.max(1, Math.min(3, Math.ceil(this.k * 2) / 2));
    this.angleCanvas.width = Math.round(200 * k);
    this.angleCanvas.height = Math.round(113 * k);
  }

  addChat(p: Player | null, text: string) { this.chat.add(p ? p.name : null, p ? p.color : null, text); }
  showMessage(text: string, onOk?: () => void) { this.msg.open_(text, onOk); }
  refreshBack() { /* canvas is redrawn every frame */ }
  angleChanged() { /* drawn every frame */ }

  showPreview(text: string) {
    const g = this.app.session?.game;
    const p = g?.currentPlayer;
    if (p && !(p.local && !p.isComputer)) this.funcField.value = text;
  }

  private flash(text: string) {
    this.toast.textContent = text;
    setTimeout(() => { if (this.toast.textContent === text) this.toast.textContent = ''; }, 1800);
  }

  private queuePreview() {
    clearTimeout(this.previewTimer);
    // coalesce keystrokes: one realtime message per ~120ms instead of one per key
    this.previewTimer = window.setTimeout(() => this.app.session?.game.sendFunctionPreview(this.funcField.value), 120);
  }

  private canFire() {
    const g = this.app.session?.game;
    const p = g?.currentPlayer;
    return !!g && !!p && p.local && !p.isComputer && !g.drawingFunction;
  }

  private fire() {
    const g = this.app.session?.game;
    if (!g || !this.canFire()) return;
    const text = this.funcField.value;
    if (!text.length) return;
    clearTimeout(this.previewTimer);
    if (!g.sendFunction(text)) this.flash('That function is not valid.');
  }

  private key(e: KeyboardEvent, down: boolean) {
    if (!this.shown) return;
    const g = this.app.session?.game;
    if (!g || g.gameMode !== SND_ODE) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    if (down) { if (!e.repeat) g.startAngle(e.key === 'ArrowUp'); } else g.stopAngle();
  }

  // ------------------------------------------------------------------ touch bar (on-screen keys for phones/tablets)
  private buildTouchBar() {
    const bar = this.app.touchbar;
    const mk = (text: string, cls: string, onTap: () => void, onUp?: () => void) => {
      const b = el('button', cls, bar);
      b.type = 'button';
      b.textContent = text;
      b.addEventListener('pointerdown', ev => { ev.preventDefault(); onTap(); });
      if (onUp) { b.addEventListener('pointerup', onUp); b.addEventListener('pointerleave', onUp); b.addEventListener('pointercancel', onUp); }
      return b;
    };
    mk('▲', 'ang', () => this.app.session?.game.startAngle(true), () => this.app.session?.game.stopAngle());
    mk('▼', 'ang', () => this.app.session?.game.startAngle(false), () => this.app.session?.game.stopAngle());
    el('span', 'sep', bar);
    for (const [shown, ins] of KEYS) mk(shown, '', () => this.insert(ins));
    mk('⌫', '', () => {
      const f = this.funcField;
      if (f.disabled) return;
      const s = f.selectionStart ?? f.value.length, e = f.selectionEnd ?? s;
      if (s !== e) f.setRangeText('', s, e, 'end'); else if (s > 0) f.setRangeText('', s - 1, s, 'end');
      this.queuePreview();
    });
  }

  private insert(text: string) {
    const f = this.funcField;
    if (f.disabled) return;
    const s = f.selectionStart ?? f.value.length, e = f.selectionEnd ?? s;
    f.setRangeText(text, s, e, 'end');
    this.queuePreview();
  }

  // ------------------------------------------------------------------ lifecycle
  setShown(v: boolean) {
    super.setShown(v);
    this.shown = v;
    if (!v) cancelAnimationFrame(this.raf);
  }

  onStart() {
    const g = this.app.session?.game;
    if (!g) return;
    this.plane.bind(g);
    this.plane.reset();
    this.chat.clear();
    this.turnKey = '';
    this.globalBtn.show(!!this.app.net?.joined);
    this.sizeAngle();
    cancelAnimationFrame(this.raf);
    const frame = () => {
      if (!this.shown) return;
      this.draw();
      this.raf = requestAnimationFrame(frame);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop() { cancelAnimationFrame(this.raf); }

  private refreshFunctionField() {
    const g = this.app.session!.game;
    const p = g.currentPlayer;
    const mine = !!p && p.local && !p.isComputer;
    this.funcField.disabled = !mine;
    if (mine) {
      this.funcField.value = p.currentSoldier.func;
      if (!this.app.coarse) setTimeout(() => this.funcField.focus(), 0);
    }
    this.modeImgs.forEach((im, i) => { im.style.display = g.gameMode === [NORMAL_FUNC, FST_ODE, SND_ODE][i] ? '' : 'none'; });
  }

  private draw() {
    const g = this.app.session?.game;
    if (!g || g.currentTurn < 0 || !g.currentPlayer) return;
    const now = g.now();
    const key = `${g.currentTurn}:${g.currentPlayer.currentTurnSoldier}:${g.terrain ? 1 : 0}:${g.gameMode}`;
    if (key !== this.turnKey) { this.turnKey = key; this.refreshFunctionField(); }
    this.plane.render(now);
    this.drawAngle(g);
    const t = g.remainingTime();
    const tenths = Math.floor(t / 100);
    this.timer.textContent = (tenths / 10).toFixed(1);
    this.timer.classList.toggle('low', tenths < 50);
  }

  private drawAngle(g: NonNullable<App['session']>['game']) {
    const c = this.angleCanvas.getContext('2d')!;
    const k = this.angleCanvas.width / 200;
    c.setTransform(k, 0, 0, k, 0, 0);
    c.clearRect(0, 0, 200, 113);
    const p = g.currentPlayer;
    const angle = g.angleUp || g.angleDown ? g.getAngle() : p.currentSoldier.angle;
    const f = g.functionReversed, t = g.terrainReversed;
    const reverse = (f || t) && !(f && t);
    const deg = Math.trunc((angle * 180) / Math.PI);
    c.fillStyle = p.color;
    c.beginPath();
    c.moveTo(57, 57);
    // Java fillArc: start angle + sweep in degrees counter-clockwise; canvas y points down so negate
    const start = reverse ? 180 : 0, sweep = reverse ? -deg : deg;
    c.arc(57, 57, 30, (-start * Math.PI) / 180, (-(start + sweep) * Math.PI) / 180, sweep > 0);
    c.closePath();
    c.fill();
    c.strokeStyle = '#000';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(4, 57.5); c.lineTo(111, 57.5);
    c.moveTo(57.5, 5); c.lineTo(57.5, 111);
    const dx = Math.trunc(53 * Math.cos(angle)), dy = Math.trunc(53 * Math.sin(angle));
    c.moveTo(57, 57); c.lineTo(reverse ? 57 - dx : 57 + dx, 57 - dy);
    c.stroke();
    c.fillStyle = '#000';
    c.font = '14px "DejaVu Sans", Verdana, sans-serif';
    const shownDeg = Math.trunc((angle * 180) / Math.PI * 100 + 0.5) / 100;
    c.fillText(`${shownDeg}°`, 145, 108);
  }
}

export { TEAM1 };
