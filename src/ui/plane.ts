// Canvas renderer for the 770x450 playing field. Port of Graphwar/GraphPlane.java.
import {
  FUNC_FADE_TIME, NAME_FADE_TIME, PLANE_GAME_LENGTH, PLANE_HEIGHT, PLANE_LENGTH, SOLDIER_ANIMATION_DELAY_STANDARD_DEVIATION,
  SOLDIER_ANIMATION_MEAN_VALUE, SOLDIER_RADIUS, TEAM2,
} from '../core/constants';
import type { GameData } from '../core/client';
import type { Player, Soldier } from '../core/entities';
import { nextGaussian, nextInt, defaultRng } from '../core/rng';
import type { Terrain } from '../core/terrain';
import { rsc } from './dom';

// durations (ms) from rsc/soldier.txt, rsc/soldierDeath.txt, rsc/explosion.txt
const ANIMS: { file: string; ms: number }[][] = [
  [['soldier1', 40], ['soldier2', 40], ['soldier3', 40], ['soldier4', 40], ['soldier5', 500], ['soldier4', 40], ['soldier3', 40], ['soldier2', 40], ['soldier1', 40]]
    .map(([f, d]) => ({ file: `soldiers/${f}.png`, ms: d as number })),
  [['soldier8', 100], ['soldier9', 800], ['soldier8', 100]].map(([f, d]) => ({ file: `soldiers/${f}.png`, ms: d as number })),
  [['soldier6', 100], ['soldier7', 800], ['soldier6', 100]].map(([f, d]) => ({ file: `soldiers/${f}.png`, ms: d as number })),
];
const DEATH = [25, 25, 25, 25, 4000].map((ms, i) => ({ file: `soldiers/soldierExplosion${i + 1}Small.png`, ms }));
const DEATH_FADE = 1000;
const EXPLOSION = [...[0, 1, 2, 3, 4, 5].map(i => ({ file: `explosions/explosion${i}.png`, ms: 15 })), { file: 'explosions/blank.png', ms: 1000 }];

function loadImage(file: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error(`cannot load ${file}`));
    i.src = rsc(file);
  });
}

interface Sprites {
  normal: HTMLImageElement; helmet: HTMLImageElement; helmetMask: HTMLImageElement;
  anim: HTMLImageElement[][]; death: HTMLImageElement[]; explosion: HTMLImageElement[];
  current: HTMLImageElement; next: HTMLImageElement;
}

export async function loadSprites(): Promise<Sprites> {
  const get = (f: string) => loadImage(f);
  const [normal, helmet, helmetMask, current, next] = await Promise.all([
    get('soldiers/soldierNormal.png'), get('soldiers/helmet.png'), get('soldiers/helmetMask.png'),
    get('soldiers/currentPlayer1.png'), get('soldiers/nextTeam.png'),
  ]);
  const anim = await Promise.all(ANIMS.map(a => Promise.all(a.map(f => get(f.file)))));
  const death = await Promise.all(DEATH.map(f => get(f.file)));
  const explosion = await Promise.all(EXPLOSION.map(f => get(f.file)));
  return { normal, helmet, helmetMask, anim, death, explosion, current, next };
}

interface AnimState { animating: boolean; num: number; started: number; next: number }

function roundRectPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

export class PlaneView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private terrainLayer: HTMLCanvasElement;
  private fnLayer: HTMLCanvasElement;
  private k = 1;
  private lastTerrain: Terrain | null = null;
  private explosionsApplied = 0;
  private lastShot: object | null = null;
  private lastStepDrawn = 0;
  private tinted = new Map<string, HTMLCanvasElement>();
  private anims = new WeakMap<Soldier, AnimState>();

  private game!: GameData;

  constructor(parent: HTMLElement, game: GameData | null, private spr: Sprites) {
    if (game) this.game = game;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'plane';
    parent.appendChild(this.canvas);
    this.terrainLayer = document.createElement('canvas');
    this.fnLayer = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.setScale(1);
  }

  /** backing-store scale (stage scale x devicePixelRatio) so the canvas stays sharp when the stage is zoomed */
  setScale(k: number) {
    k = Math.max(1, Math.min(3, Math.ceil(k * 2) / 2));
    if (k === this.k && this.canvas.width) return;
    this.k = k;
    for (const c of [this.canvas, this.terrainLayer, this.fnLayer]) { c.width = Math.round(PLANE_LENGTH * k); c.height = Math.round(PLANE_HEIGHT * k); }
    this.lastTerrain = null; // force rebuild
    this.lastShot = null;
    this.tinted.clear();
  }

  /** attach to the game of the current session */
  bind(game: GameData) { this.game = game; this.reset(); }

  /** forget per-game caches (called on game start) */
  reset() { this.tinted.clear(); this.lastTerrain = null; this.lastShot = null; }

  // ------------------------------------------------------------------ terrain bitmap cache
  private syncTerrain(t: Terrain) {
    const c = this.terrainLayer.getContext('2d')!;
    if (this.lastTerrain !== t) {
      c.setTransform(this.k, 0, 0, this.k, 0, 0);
      c.fillStyle = '#fff';
      c.fillRect(0, 0, PLANE_LENGTH, PLANE_HEIGHT);
      c.fillStyle = '#000';
      for (let i = 0; i + 2 < t.circles.length; i += 3) {
        c.beginPath(); c.arc(t.circles[i], t.circles[i + 1], t.circles[i + 2], 0, Math.PI * 2); c.fill();
      }
      this.lastTerrain = t;
      this.explosionsApplied = 0;
    }
    if (this.explosionsApplied < t.explosions.length) {
      c.setTransform(this.k, 0, 0, this.k, 0, 0);
      c.fillStyle = '#fff';
      for (let i = this.explosionsApplied; i < t.explosions.length; i += 3) {
        c.beginPath(); c.arc(t.explosions[i], t.explosions[i + 1], t.explosions[i + 2], 0, Math.PI * 2); c.fill();
      }
      this.explosionsApplied = t.explosions.length;
    }
  }

  // ------------------------------------------------------------------ sprites
  private tint(player: Player, key: string, base: HTMLImageElement): HTMLCanvasElement {
    const id = `${player.id}|${player.color}|${key}`;
    let c = this.tinted.get(id);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = 20; c.height = 20;
    const g = c.getContext('2d')!;
    g.drawImage(base, 0, 0);
    const h = document.createElement('canvas');
    h.width = 20; h.height = 20;
    const hg = h.getContext('2d')!;
    hg.drawImage(this.spr.helmetMask, 0, 0);
    hg.globalCompositeOperation = 'source-in';
    hg.fillStyle = player.color;
    hg.fillRect(0, 0, 20, 20);
    hg.globalCompositeOperation = 'source-over';
    hg.drawImage(this.spr.helmet, 0, 0);
    g.drawImage(h, 0, 0);
    this.tinted.set(id, c);
    return c;
  }

  private animState(s: Soldier, now: number): AnimState {
    let a = this.anims.get(s);
    if (!a) { a = { animating: false, num: 0, started: 0, next: now + Math.abs(nextGaussian(defaultRng) * SOLDIER_ANIMATION_DELAY_STANDARD_DEVIATION + SOLDIER_ANIMATION_MEAN_VALUE) }; this.anims.set(s, a); }
    return a;
  }

  private soldierImage(s: Soldier, p: Player, now: number): CanvasImageSource | null {
    if (s.exploding) {
      let t = now - s.timeExplodingStarted;
      for (let i = 0; i < DEATH.length; i++) {
        if (t > DEATH[i].ms) t -= DEATH[i].ms;
        else return this.spr.death[i];
      }
      if (t < DEATH_FADE) {
        // fade out the last frame
        const c = document.createElement('canvas');
        c.width = 20; c.height = 20;
        const g = c.getContext('2d')!;
        g.globalAlpha = Math.max(0, 1 - t / DEATH_FADE);
        g.drawImage(this.spr.death[DEATH.length - 1], 0, 0);
        return c;
      }
      return null;
    }
    const a = this.animState(s, now);
    if (!a.animating && now > a.next) { a.animating = true; a.started = now; a.num = nextInt(defaultRng, 1 << 30); }
    if (a.animating) {
      const n = a.num % ANIMS.length;
      let t = now - a.started;
      for (let i = 0; i < ANIMS[n].length; i++) {
        if (t > ANIMS[n][i].ms) t -= ANIMS[n][i].ms;
        else return this.tint(p, `a${n}_${i}`, this.spr.anim[n][i]);
      }
      a.animating = false;
      a.next = now + Math.abs(nextGaussian(defaultRng) * SOLDIER_ANIMATION_DELAY_STANDARD_DEVIATION + SOLDIER_ANIMATION_MEAN_VALUE);
    }
    return this.tint(p, 'n', this.spr.normal);
  }

  // ------------------------------------------------------------------ drawing
  private drawName(c: CanvasRenderingContext2D, x: number, y: number, p: Player) {
    const border = 3;
    const len = c.measureText(p.name).width;
    let bx = x - len / 2 - border;
    let by = y - 15 - 2 * SOLDIER_RADIUS;
    let tx = x - len / 2;
    let ty = y - 2 - 2 * SOLDIER_RADIUS;
    if (by < 0) { by = y - 2 + 2 * SOLDIER_RADIUS; ty = y + 11 + 2 * SOLDIER_RADIUS; }
    if (bx < 0) { tx -= bx; bx = 0; }
    if (bx + len + 2 * border > PLANE_LENGTH) { tx = tx - bx + PLANE_LENGTH - len - 2 * border; bx = PLANE_LENGTH - len - 2 * border; }
    roundRectPath(c, bx + 0.5, by + 0.5, len + 2 * border, 15, 7);
    c.fillStyle = 'rgba(255,255,255,0.667)';
    c.fill();
    c.strokeStyle = p.color;
    c.lineWidth = 1;
    c.stroke();
    c.fillStyle = '#000';
    c.fillText(p.name, tx, ty);
  }

  /** x conversion between the shooter's frame / world frame / viewer's frame */
  private flipFn(): boolean { const f = this.game.functionReversed, t = this.game.terrainReversed; return (f || t) && !(f && t); }

  render(now: number) {
    const g = this.game;
    const c = this.ctx;
    const t = g.terrain;
    c.setTransform(this.k, 0, 0, this.k, 0, 0);
    c.clearRect(0, 0, PLANE_LENGTH, PLANE_HEIGHT);
    if (!t || g.currentTurn < 0 || !g.currentPlayer) return;
    this.syncTerrain(t);
    const rev = g.terrainReversed;

    // terrain (mirrored when the viewer plays on team 2)
    c.save();
    if (rev) { c.translate(PLANE_LENGTH, 0); c.scale(-1, 1); }
    c.drawImage(this.terrainLayer, 0, 0, PLANE_LENGTH, PLANE_HEIGHT);
    c.restore();
    c.strokeStyle = '#000';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(0, PLANE_HEIGHT / 2 + 0.5); c.lineTo(PLANE_LENGTH, PLANE_HEIGHT / 2 + 0.5);
    c.moveTo(PLANE_LENGTH / 2 + 0.5, 0); c.lineTo(PLANE_LENGTH / 2 + 0.5, PLANE_HEIGHT);
    c.stroke();

    c.font = '14px "DejaVu Sans", Verdana, sans-serif';
    c.textBaseline = 'alphabetic';
    const X = (x: number) => (rev ? PLANE_LENGTH - x : x);

    // names
    for (const p of g.players) {
      for (let j = 0; j < p.numSoldiers; j++) {
        const s = p.soldiers[j];
        if (s.alive) this.drawName(c, X(s.x), s.y, p);
        else if (s.exploding) {
          c.globalAlpha = Math.max(0, 1 - (now - s.timeExplodingStarted) / NAME_FADE_TIME);
          if (c.globalAlpha > 0) this.drawName(c, X(s.x), s.y, p);
          c.globalAlpha = 1;
        }
      }
    }

    // current soldier marker (+ optional next-soldier markers)
    const cur = g.currentPlayer;
    const cs = cur.currentSoldier;
    c.drawImage(this.spr.current, X(cs.x) - this.spr.current.width / 2, cs.y - this.spr.current.height / 2);
    if (g.showNext) {
      for (const p of g.players) {
        if (p === cur) continue;
        const s = p.nextTurnSoldier();
        if (s) c.drawImage(this.spr.next, X(s.x) - this.spr.next.width / 2, s.y - this.spr.next.height / 2);
      }
    }

    // soldiers
    for (const p of g.players) {
      for (let j = 0; j < p.numSoldiers; j++) {
        const s = p.soldiers[j];
        if (!(s.alive || s.exploding)) continue;
        const img = this.soldierImage(s, p, now);
        if (!img) continue;
        const w = (img as HTMLImageElement | HTMLCanvasElement).width, h = (img as HTMLImageElement | HTMLCanvasElement).height;
        const x = X(s.x);
        const flip = (p.team === TEAM2 || rev) && !(p.team === TEAM2 && rev);
        if (flip) { c.save(); c.translate(x, 0); c.scale(-1, 1); c.drawImage(img, -w / 2, s.y - h / 2); c.restore(); }
        else c.drawImage(img, x - w / 2, s.y - h / 2);
      }
    }

    // function trace + explosion
    if (g.drawingFunction && g.shot) {
      const shot = g.shot;
      const f = this.fnLayer.getContext('2d')!;
      if (this.lastShot !== shot) {
        f.setTransform(1, 0, 0, 1, 0, 0);
        f.clearRect(0, 0, this.fnLayer.width, this.fnLayer.height);
        this.lastShot = shot;
        this.lastStepDrawn = 0;
      }
      f.setTransform(this.k, 0, 0, this.k, 0, 0);
      const n = Math.min(g.currentFunctionPosition(), shot.numSteps);
      const flip = this.flipFn();
      const conv = (i: number): [number, number] => {
        let x = (PLANE_LENGTH * shot.valuesX[i]) / PLANE_GAME_LENGTH + PLANE_LENGTH / 2;
        const y = (-PLANE_LENGTH * shot.valuesY[i]) / PLANE_GAME_LENGTH + PLANE_HEIGHT / 2;
        if (flip) x = PLANE_LENGTH - x;
        return [x, y];
      };
      if (n > this.lastStepDrawn) {
        f.strokeStyle = cur.color;
        f.lineWidth = 1;
        f.beginPath();
        let [x, y] = conv(this.lastStepDrawn);
        f.moveTo(x, y);
        for (let i = this.lastStepDrawn; i < n; i++) { [x, y] = conv(i); f.lineTo(x, y); }
        f.stroke();
        this.lastStepDrawn = Math.max(0, n - 1);
      }
      if (g.exploding) c.globalAlpha = Math.max(0, 1 - g.timeExploding() / FUNC_FADE_TIME);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.drawImage(this.fnLayer, 0, 0);
      c.setTransform(this.k, 0, 0, this.k, 0, 0);
      c.globalAlpha = 1;

      if (g.exploding) {
        let tt = g.timeExploding();
        const e0 = this.spr.explosion[0];
        let dx = Math.trunc(shot.lastX);
        const dy = Math.trunc(shot.lastY - e0.height / 2);
        if (flip) dx = PLANE_LENGTH - dx;
        dx -= e0.width / 2;
        for (let i = 0; i < EXPLOSION.length; i++) {
          if (tt > EXPLOSION[i].ms) tt -= EXPLOSION[i].ms;
          else { c.drawImage(this.spr.explosion[i], dx, dy); break; }
        }
      }
    }
  }
}
