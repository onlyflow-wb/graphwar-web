// Port of Graphwar/Function.java: trajectory computation for the three game modes.
import {
  ANGLE_ERROR, FUNC_MAX_STEPS, FUNC_MAX_STEP_DISTANCE_SQUARED, FUNC_MIN_X_STEP_DISTANCE,
  MAX_ANGLE_LOOPS, MAX_SOLDIERS_PER_PLAYER, PLANE_GAME_LENGTH, PLANE_HEIGHT, PLANE_LENGTH,
  SOLDIER_RADIUS, STEP_SIZE, NORMAL_FUNC, FST_ODE, SND_ODE,
} from './constants';
import { PolishNotationFunction } from './parser';
import type { Player } from './entities';
import type { Terrain } from './terrain';

export class Shot {
  fireAngle = 0;
  valuesX = new Float64Array(FUNC_MAX_STEPS);
  valuesY = new Float64Array(FUNC_MAX_STEPS);
  numSteps = 0;
  playersHit: number[] = [];
  soldiersHit: number[] = [];
  soldierHitPosition: number[] = [];
  lastX = 0;
  lastY = 0;
  constructor(public readonly fn: PolishNotationFunction, public readonly source = '') {}

  get numPlayersHit() { return this.playersHit.length; }

  alreadyHit(p: number, s: number) {
    for (let i = 0; i < this.playersHit.length; i++) if (this.playersHit[i] === p && this.soldiersHit[i] === s) return true;
    return false;
  }
}

const toPlaneX = (gx: number) => (PLANE_LENGTH * gx) / PLANE_GAME_LENGTH + PLANE_LENGTH / 2;
const toPlaneY = (gy: number) => (-PLANE_LENGTH * gy) / PLANE_GAME_LENGTH + PLANE_HEIGHT / 2;

/** start position of the shot in game coordinates */
function startPoint(players: Player[], currentTurn: number, inverted: boolean): [number, number] {
  const s = players[currentTurn].currentSoldier;
  let x = s.x;
  const y = s.y;
  if (inverted) x = PLANE_LENGTH - x;
  return [
    (PLANE_GAME_LENGTH * (x - PLANE_LENGTH / 2)) / PLANE_LENGTH,
    (PLANE_GAME_LENGTH * (-y + PLANE_HEIGHT / 2)) / PLANE_LENGTH,
  ];
}

/**
 * Returns true when the point terminates the shot (terrain/NaN). Records soldier hits.
 * Mirrors the shared tail of each Java processXRange loop.
 */
function stepCollisions(
  shot: Shot, i: number, terrain: Terrain, players: Player[], numPlayers: number,
  currentTurn: number, inverted: boolean,
): boolean {
  const gx = shot.valuesX[i], gy = shot.valuesY[i];
  let x = toPlaneX(gx);
  const y = toPlaneY(gy);
  if (inverted) x = PLANE_LENGTH - x;

  for (let j = 0; j < numPlayers; j++) {
    const p = players[j];
    for (let k = 0; k < p.numSoldiers; k++) {
      if (j === currentTurn && k === p.currentTurnSoldier) continue;
      const s = p.soldiers[k];
      if (!s.alive) continue;
      const dx = s.x - x, dy = s.y - y;
      if (dx * dx + dy * dy < SOLDIER_RADIUS * SOLDIER_RADIUS) {
        if (!shot.alreadyHit(j, k)) {
          shot.playersHit.push(j); shot.soldiersHit.push(k); shot.soldierHitPosition.push(i);
        }
      }
    }
  }
  // Java casts with (int) -> truncation toward zero
  if (terrain.collidePoint(Math.trunc(x), Math.trunc(y))) { shot.numSteps = i; return true; }
  if (Number.isNaN(y) || !Number.isFinite(y)) { shot.numSteps = i; return true; }
  return false;
}

function finish(shot: Shot) {
  shot.lastX = toPlaneX(shot.valuesX[shot.numSteps - 1]);
  shot.lastY = toPlaneY(shot.valuesY[shot.numSteps - 1]);
}

// ---------------------------------------------------------------- NORMAL (y = f(x) + c)
function getStartAngle(f: PolishNotationFunction, x: number, radius: number): number {
  let tangent = (f.evaluateFunction(x + STEP_SIZE, 0, 0) - f.evaluateFunction(x, 0, 0)) / STEP_SIZE;
  let angle = Math.atan(tangent);
  let error = 10000;
  for (let i = 0; error > ANGLE_ERROR && i < MAX_ANGLE_LOOPS; i++) {
    const finalX = x + radius * Math.cos(angle);
    tangent = (f.evaluateFunction(finalX + STEP_SIZE, 0, 0) - f.evaluateFunction(finalX, 0, 0)) / STEP_SIZE;
    const na = Math.atan(tangent);
    error = Math.abs(na - angle);
    angle = na;
  }
  return angle;
}

export function processFunctionRange(
  shot: Shot, terrain: Terrain, players: Player[], currentTurn: number, inverted: boolean,
) {
  const f = shot.fn;
  const numPlayers = players.length;
  const X = shot.valuesX, Y = shot.valuesY;
  [X[0], Y[0]] = startPoint(players, currentTurn, inverted);
  const gameRadius = (PLANE_GAME_LENGTH * SOLDIER_RADIUS) / PLANE_LENGTH;

  shot.fireAngle = getStartAngle(f, X[0], gameRadius);
  if (!Number.isNaN(shot.fireAngle) && Number.isFinite(shot.fireAngle)) {
    X[0] += gameRadius * Math.cos(shot.fireAngle);
    Y[0] += gameRadius * Math.sin(shot.fireAngle);
  }
  const offSet = -f.evaluateFunction(X[0], 0, 0) + Y[0];

  shot.numSteps = FUNC_MAX_STEPS;
  for (let i = 1; i < FUNC_MAX_STEPS; i++) {
    let step = STEP_SIZE;
    X[i] = X[i - 1] + step;
    Y[i] = f.evaluateFunction(X[i], 0, 0) + offSet;
    let endFunc = false;
    while ((X[i] - X[i - 1]) ** 2 + (Y[i] - Y[i - 1]) ** 2 > 0.001 /* FUNC_MAX_STEP_DISTANCE_SQUARED */) {
      if (X[i] - X[i - 1] > FUNC_MIN_X_STEP_DISTANCE) {
        step /= 2;
        X[i] = X[i - 1] + step;
        Y[i] = f.evaluateFunction(X[i], 0, 0) + offSet;
      } else { endFunc = true; break; }
    }
    if (endFunc) { shot.numSteps = i; break; }
    if (stepCollisions(shot, i, terrain, players, numPlayers, currentTurn, inverted)) break;
  }
  finish(shot);
}

// ---------------------------------------------------------------- FIRST ORDER ODE (RK4)
function getRK4StartAngle(f: PolishNotationFunction, x: number, y: number, radius: number): number {
  let angle = 0;
  let error = 10000;
  for (let i = 0; error > ANGLE_ERROR && i < MAX_ANGLE_LOOPS; i++) {
    const fx = x + radius * Math.cos(angle);
    const fy = y + radius * Math.sin(angle);
    const h = STEP_SIZE;
    const k1 = f.evaluateFunction(fx, fy, 0);
    const k2 = f.evaluateFunction(fx + 0.5 * h, fy + 0.5 * h * k1, 0);
    const k3 = f.evaluateFunction(fx + 0.5 * h, fy + 0.5 * h * k2, 0);
    const k4 = f.evaluateFunction(fx + h, fy + h * k3, 0);
    const nextY = fy + (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
    const nextX = fx + h;
    const na = Math.atan((nextY - fy) / (nextX - fx));
    error = Math.abs(na - angle);
    angle = na;
  }
  return angle;
}

export function processRK4Range(
  shot: Shot, terrain: Terrain, players: Player[], currentTurn: number, inverted: boolean,
) {
  const f = shot.fn;
  const numPlayers = players.length;
  const X = shot.valuesX, Y = shot.valuesY;
  [X[0], Y[0]] = startPoint(players, currentTurn, inverted);
  const gameRadius = (PLANE_GAME_LENGTH * SOLDIER_RADIUS) / PLANE_LENGTH;
  shot.fireAngle = getRK4StartAngle(f, X[0], Y[0], gameRadius);
  X[0] += gameRadius * Math.cos(shot.fireAngle);
  Y[0] += gameRadius * Math.sin(shot.fireAngle);

  const rk = (xp: number, yp: number, h: number) => {
    const k1 = f.evaluateFunction(xp, yp, 0);
    const k2 = f.evaluateFunction(xp + 0.5 * h, yp + 0.5 * h * k1, 0);
    const k3 = f.evaluateFunction(xp + 0.5 * h, yp + 0.5 * h * k2, 0);
    const k4 = f.evaluateFunction(xp + h, yp + h * k3, 0);
    return yp + (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
  };

  shot.numSteps = FUNC_MAX_STEPS;
  for (let i = 1; i < FUNC_MAX_STEPS; i++) {
    let h = STEP_SIZE;
    Y[i] = rk(X[i - 1], Y[i - 1], h);
    X[i] = X[i - 1] + h;
    while ((X[i] - X[i - 1]) ** 2 + (Y[i] - Y[i - 1]) ** 2 > FUNC_MAX_STEP_DISTANCE_SQUARED &&
           X[i] - X[i - 1] > FUNC_MIN_X_STEP_DISTANCE) {
      h /= 2;
      Y[i] = rk(X[i - 1], Y[i - 1], h);
      X[i] = X[i - 1] + h;
    }
    // (the Java "else endFunc" branch inside this loop is unreachable because of the loop guard)
    if (stepCollisions(shot, i, terrain, players, numPlayers, currentTurn, inverted)) break;
  }
  finish(shot);
}

// ---------------------------------------------------------------- SECOND ORDER ODE (RK4 on system)
export function processRK42Range(
  shot: Shot, terrain: Terrain, players: Player[], currentTurn: number, angle: number, inverted: boolean,
) {
  const f = shot.fn;
  const numPlayers = players.length;
  const X = shot.valuesX, Y = shot.valuesY;
  const DY = new Float64Array(FUNC_MAX_STEPS);

  const s = players[currentTurn].currentSoldier;
  let sx = s.x;
  if (inverted) sx = PLANE_LENGTH - sx;
  sx += SOLDIER_RADIUS * Math.cos(angle);
  const sy = s.y - SOLDIER_RADIUS * Math.sin(angle);
  X[0] = (PLANE_GAME_LENGTH * (sx - PLANE_LENGTH / 2)) / PLANE_LENGTH;
  Y[0] = (PLANE_GAME_LENGTH * (-sy + PLANE_HEIGHT / 2)) / PLANE_LENGTH;
  DY[0] = Math.tan(angle);
  shot.fireAngle = angle;

  const out: [number, number] = [0, 0];
  const rk = (x0: number, y0: number, d0: number, h: number) => {
    const k11 = d0;
    const k12 = f.evaluateFunction(x0, y0, d0);
    let x1 = x0 + h / 2, y1 = y0 + (h / 2) * k11, y2 = d0 + (h / 2) * k12;
    const k21 = y2;
    const k22 = f.evaluateFunction(x1, y1, y2);
    y1 = y0 + (h / 2) * k21; y2 = d0 + (h / 2) * k22;
    const k31 = y2;
    const k32 = f.evaluateFunction(x1, y1, y2);
    x1 = x0 + h; y1 = y0 + h * k31; y2 = d0 + h * k32;
    const k41 = y2;
    const k42 = f.evaluateFunction(x1, y1, y2);
    out[0] = y0 + (h / 6) * (k11 + 2 * k21 + 2 * k31 + k41);
    out[1] = d0 + (h / 6) * (k12 + 2 * k22 + 2 * k32 + k42);
  };

  shot.numSteps = FUNC_MAX_STEPS;
  for (let i = 1; i < FUNC_MAX_STEPS; i++) {
    let h = STEP_SIZE;
    rk(X[i - 1], Y[i - 1], DY[i - 1], h);
    X[i] = X[i - 1] + h; Y[i] = out[0]; DY[i] = out[1];
    while ((X[i] - X[i - 1]) ** 2 + (Y[i] - Y[i - 1]) ** 2 > FUNC_MAX_STEP_DISTANCE_SQUARED &&
           X[i] - X[i - 1] > FUNC_MIN_X_STEP_DISTANCE) {
      h /= 2;
      rk(X[i - 1], Y[i - 1], DY[i - 1], h);
      X[i] = X[i - 1] + h; Y[i] = out[0]; DY[i] = out[1];
    }
    if (stepCollisions(shot, i, terrain, players, numPlayers, currentTurn, inverted)) break;
  }
  finish(shot);
}

/** dispatch by game mode (mirrors GameData.processFunction) */
export function computeShot(
  mode: number, source: string | PolishNotationFunction, terrain: Terrain, players: Player[],
  currentTurn: number, team: number, angle: number,
): Shot {
  const fn = typeof source === 'string' ? new PolishNotationFunction(source) : source;
  const shot = new Shot(fn, typeof source === 'string' ? source : '');
  const inverted = team !== 1;
  switch (mode) {
    case NORMAL_FUNC: processFunctionRange(shot, terrain, players, currentTurn, inverted); break;
    case FST_ODE: processRK4Range(shot, terrain, players, currentTurn, inverted); break;
    case SND_ODE: processRK42Range(shot, terrain, players, currentTurn, angle, inverted); break;
  }
  return shot;
}

export { MAX_SOLDIERS_PER_PLAYER };
