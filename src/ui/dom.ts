// Tiny DOM helpers: the original UI is a fixed 800x600 layout of absolutely positioned images, fields and buttons.
// We keep that layout (coordinates come straight from rsc/*.txt in the Java project) and scale the whole stage with CSS.

export const rsc = (name: string) => `/rsc/${name}`;

export function px<T extends HTMLElement>(e: T, x: number, y: number, w?: number, h?: number): T {
  e.style.left = `${x}px`;
  e.style.top = `${y}px`;
  if (w !== undefined) e.style.width = `${w}px`;
  if (h !== undefined) e.style.height = `${h}px`;
  return e;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

export function image(parent: HTMLElement, file: string, x: number, y: number): HTMLImageElement {
  const i = el('img', 'img', parent);
  i.src = rsc(file);
  i.draggable = false;
  i.alt = '';
  return px(i, x, y);
}

export function setVisible(e: HTMLElement | HTMLElement[], v: boolean) {
  for (const x of Array.isArray(e) ? e : [e]) x.style.display = v ? '' : 'none';
}

/** Image button with hover image, like GraphButton.java (without the pixel mask: the whole rectangle is clickable). */
export class ImgButton {
  readonly el: HTMLImageElement;
  private normal: string;
  private over: string;
  private hover = false;
  enabled = true;

  constructor(parent: HTMLElement, normal: string, over: string, x: number, y: number, onClick?: (ev: PointerEvent | MouseEvent) => void, label = '') {
    this.normal = normal;
    this.over = over;
    this.el = el('img', 'btn', parent);
    this.el.draggable = false;
    this.el.alt = label;
    if (label) this.el.title = label;
    this.el.setAttribute('role', 'button');
    px(this.el, x, y);
    this.paint();
    this.el.addEventListener('pointerenter', () => { this.hover = true; this.paint(); });
    this.el.addEventListener('pointerleave', () => { this.hover = false; this.paint(); });
    if (onClick) this.el.addEventListener('click', ev => { if (this.enabled) onClick(ev); });
  }

  private paint() { this.el.src = rsc(this.hover ? this.over : this.normal); }

  setImages(normal: string, over: string) { this.normal = normal; this.over = over; this.paint(); }
  setMirror(m: boolean) { this.el.classList.toggle('mirror', m); }
  show(v: boolean) { this.el.style.display = v ? '' : 'none'; }
}

export function textField(parent: HTMLElement, x: number, y: number, w: number, maxLength = 200): HTMLInputElement {
  const f = el('input', 'field', parent);
  f.type = 'text';
  f.maxLength = maxLength;
  f.autocomplete = 'off';
  f.spellcheck = false;
  f.setAttribute('autocapitalize', 'off');
  f.setAttribute('autocorrect', 'off');
  px(f, x, y, w, 25);
  return f;
}

export function label(parent: HTMLElement, x: number, y: number, w: number, h: number): HTMLDivElement {
  const l = el('div', 'label', parent);
  return px(l, x, y, w, h);
}

/** Scrolling text area, like GraphTextBox: system lines grey/italic, chat lines "name: text" with coloured bold name. */
export class ChatBox {
  readonly el: HTMLDivElement;
  constructor(parent: HTMLElement, x: number, y: number, w: number, h: number) {
    this.el = px(el('div', 'chatbox', parent), x, y, w, h);
  }
  add(name: string | null, color: string | null, text: string) {
    const e = this.el;
    const stick = e.scrollHeight - (e.scrollTop + e.clientHeight) < 20;
    const line = el('div', '', e);
    if (name === null) {
      const s = el('span', 'sys', line);
      s.textContent = text;
    } else {
      const w = el('span', 'who', line);
      w.textContent = `${name}: `;
      if (color) w.style.color = color;
      const t = el('span', '', line);
      t.textContent = text;
    }
    // keep memory bounded on long sessions
    while (e.childElementCount > 300) e.firstElementChild?.remove();
    if (stick) e.scrollTop = e.scrollHeight;
  }
  clear() { this.el.textContent = ''; }
}

/** Fit an 800x600 stage into the viewport (optionally leaving room at the bottom for the touch bar). */
export function fitStage(stage: HTMLElement, reservedBottom: number) {
  const w = window.innerWidth;
  const h = window.innerHeight - reservedBottom;
  const s = Math.min(w / 800, h / 600);
  stage.style.transform = `scale(${s})`;
  stage.style.left = `${Math.max(0, (w - 800 * s) / 2)}px`;
  stage.style.top = `${Math.max(0, (h - 600 * s) / 2)}px`;
}
