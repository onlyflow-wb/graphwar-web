import { ImgButton, el, image, label, px, textField } from './dom';

export class Screen {
  readonly root: HTMLElement;
  constructor(stage: HTMLElement) {
    this.root = el('div', 'screen', stage);
    this.root.hidden = true;
  }
  setShown(v: boolean) { this.root.hidden = !v; }
}

/** A group of elements shown on top of the screen; while open, a transparent catcher blocks the controls below. */
export class Dialog {
  readonly group: HTMLElement;
  private catcher: HTMLElement;
  constructor(parent: HTMLElement) {
    this.catcher = el('div', 'catcher', parent);
    this.catcher.style.display = 'none';
    this.group = el('div', 'abs', parent);
    this.group.style.cssText += ';left:0;top:0;width:800px;height:600px;pointer-events:none;';
    this.group.style.display = 'none';
  }
  get open() { return this.group.style.display !== 'none'; }
  show(v: boolean) {
    this.catcher.style.display = v ? '' : 'none';
    this.group.style.display = v ? '' : 'none';
  }
  /** children inside the group need pointer events back (the group itself ignores them) */
  static interactive<T extends HTMLElement>(e: T): T { e.style.pointerEvents = 'auto'; return e; }
}

/** "name" (+ optional second field) popup used by menu / pregame / lobby, with join/back buttons at the original positions. */
export class FieldDialog extends Dialog {
  readonly name: HTMLInputElement;
  readonly second: HTMLInputElement | null;
  readonly yes: ImgButton;
  readonly no: ImgButton;

  constructor(parent: HTMLElement, opts: {
    bg: string; second?: boolean; yesImg: [string, string]; onYes: () => void; onNo?: () => void; nameMax?: number; secondMax?: number;
  }) {
    super(parent);
    image(this.group, opts.bg, 184, 184);
    image(this.group, 'shadowFields.png', 314, 200);
    this.name = Dialog.interactive(textField(this.group, 329, 215, 200, opts.nameMax ?? 20));
    if (opts.second) {
      image(this.group, 'shadowFields.png', 291, 238);
      this.second = Dialog.interactive(textField(this.group, 306, 253, 200, opts.secondMax ?? 20));
    } else this.second = null;
    const y = opts.second ? 275 : 245;
    this.yes = new ImgButton(this.group, opts.yesImg[0], opts.yesImg[1], 200, y, () => opts.onYes());
    this.no = new ImgButton(this.group, 'back.png', 'backOver.png', 400, y, () => { this.show(false); opts.onNo?.(); });
    Dialog.interactive(this.yes.el); Dialog.interactive(this.no.el);
    const enter = (e: KeyboardEvent) => { if (e.key === 'Enter') opts.onYes(); else if (e.key === 'Escape') { this.show(false); opts.onNo?.(); } };
    this.name.addEventListener('keydown', enter);
    this.second?.addEventListener('keydown', enter);
  }

  open_(focus = true) { this.show(true); if (focus) setTimeout(() => this.name.focus(), 0); }
}

export class MessageDialog extends Dialog {
  private text: HTMLElement;
  private onOk: (() => void) | null = null;
  constructor(parent: HTMLElement) {
    super(parent);
    image(this.group, 'backMessage.png', 184, 184);
    this.text = label(this.group, 210, 220, 385, 50);
    const ok = new ImgButton(this.group, 'ok.png', 'okOver.png', 300, 275, () => { this.show(false); const f = this.onOk; this.onOk = null; f?.(); });
    Dialog.interactive(ok.el);
  }
  open_(message: string, onOk?: () => void) { this.text.textContent = message; this.onOk = onOk ?? null; this.show(true); }
}

export function px2<T extends HTMLElement>(e: T, x: number, y: number, w?: number, h?: number) { return px(e, x, y, w, h); }
