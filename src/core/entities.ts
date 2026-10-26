// Ports of Graphwar/Player.java and Soldier.java (game-state part only; animation lives in the UI layer).
import { MAX_SOLDIERS_PER_PLAYER, MAXIMUM_COLOR_MODULE_SQUARED } from './constants';
import { Rng, defaultRng, nextInt } from './rng';

export class Soldier {
  x = 0;
  y = 0;
  angle = 0;
  alive = false;
  exploding = false;
  timeExplodingStarted = 0;
  killPosition = 0;
  func = '';

  constructor(x?: number, y?: number) {
    if (x !== undefined && y !== undefined) {
      this.x = x;
      this.y = y;
      this.alive = true;
    }
  }

  setExploding(v: boolean, now: number) {
    this.exploding = v;
    if (v) this.timeExplodingStarted = now;
  }
}

export function randomColor(r: Rng = defaultRng): string {
  let R: number, G: number, B: number;
  do {
    R = nextInt(r, 256); G = nextInt(r, 256); B = nextInt(r, 256);
  } while (R * R + G * G + B * B > MAXIMUM_COLOR_MODULE_SQUARED);
  return `rgb(${R},${G},${B})`;
}

export class Player {
  soldiers: Soldier[] = Array.from({ length: MAX_SOLDIERS_PER_PLAYER }, () => new Soldier());
  currentTurnSoldier = 0;
  color: string;
  disconnected = false;
  /** computer-controlled (only set on the client that owns it) */
  isComputer = false;
  aiLevel = 0;

  constructor(
    public name: string,
    public id: number,
    public team: number,
    public local: boolean,
    public numSoldiers: number,
    public ready: boolean,
  ) {
    this.color = randomColor();
  }

  startSoldier(i: number, x: number, y: number) { this.soldiers[i] = new Soldier(x, y); }
  get currentSoldier(): Soldier { return this.soldiers[this.currentTurnSoldier]; }
  restartTurn() { this.currentTurnSoldier = 0; }

  /** advance to next living soldier; returns false if none alive */
  nextTurn(): boolean {
    for (let i = 0; i < this.numSoldiers; i++) {
      this.currentTurnSoldier = (this.currentTurnSoldier + 1) % this.numSoldiers;
      if (this.soldiers[this.currentTurnSoldier].alive) return true;
    }
    return false;
  }

  nextTurnSoldier(): Soldier | null {
    let n = this.currentTurnSoldier;
    for (let i = 0; i < this.numSoldiers; i++) {
      n = (n + 1) % this.numSoldiers;
      if (this.soldiers[n].alive) return this.soldiers[n];
    }
    return null;
  }

  hasAliveSoldier(): boolean {
    for (let i = 0; i < this.numSoldiers; i++) if (this.soldiers[i].alive) return true;
    return false;
  }
}
