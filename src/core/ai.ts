// Port of Graphwar/ComputerPlayer.java — genetic-algorithm opponent.
// The Java version ran in its own thread; here the loop yields to the event loop every few ms so the UI stays smooth.
// Original quirks (e.g. angle mutation writing to the previous generation's array) are kept on purpose.
import {
  MAX_SOLDIERS_PER_PLAYER, NUM_FUNCTIONS_AI, NUM_FUNCTIONS_UNCHANGED_TURN_AI, NUM_FUNCTION_MUTATED_AI,
  PLANE_GAME_LENGTH, PLANE_HEIGHT, PLANE_LENGTH, NORMAL_FUNC, SND_ODE, TEAM2, GameState,
} from './constants';
import type { Player } from './entities';
import type { Terrain } from './terrain';
import { PolishNotationFunction } from './parser';
import { Rng, defaultRng, nextBoolean } from './rng';
import { computeShot } from './shot';

/** the part of the game the AI reads/acts on; GameData implements it, and so does the Web Worker's snapshot view */
export interface AiView {
  players: Player[];
  terrain: Terrain | null;
  gameMode: number;
  currentTurn: number;
  gameState: GameState;
  remainingTime(): number;
  setAngle(angle: number): void;
  sendFunction(text: string): boolean;
}

/** what the UI/session layers need from a computer player (in-thread ComputerBrain or WorkerBrain) */
export interface Thinker { thinkFunction(): void; stopThinkFunction(): void }

interface Evolvable { fn: PolishNotationFunction; angle: number; points: number }

const newEvolvable = (): Evolvable => ({ fn: new PolishNotationFunction(), angle: 0, points: 0 });

export class ComputerBrain {
  private numGenerations: number;
  private over9000: boolean;
  private best: Evolvable[];
  private pop: Evolvable[][];
  private processing = false;
  private myTurn = false;
  private runId = 0;
  lastFunction = '0';
  bestAngle = 0;

  constructor(
    private player: Player, public game: AiView, level: number,
    private rng: Rng = defaultRng,
    private sleep: () => Promise<void> = () => new Promise(r => setTimeout(r, 0)),
    private workBudgetMs = 10,
  ) {
    this.numGenerations = level;
    this.over9000 = level > 9000;
    this.best = Array.from({ length: MAX_SOLDIERS_PER_PLAYER }, () => {
      const e = newEvolvable();
      e.fn.makeRandomFunction(NORMAL_FUNC, rng);
      e.angle = Math.PI * rng.next() - Math.PI / 2;
      return e;
    });
    this.pop = Array.from({ length: MAX_SOLDIERS_PER_PLAYER }, () =>
      Array.from({ length: NUM_FUNCTIONS_AI }, () => {
        const e = newEvolvable();
        e.fn.makeRandomFunction(NORMAL_FUNC, rng);
        e.angle = Math.PI * rng.next() - Math.PI / 2;
        return e;
      }));
  }

  thinkFunction() {
    if (this.over9000) this.myTurn = true;
    if (!this.processing) {
      this.processing = true;
      const id = ++this.runId;
      void this.run(id);
    }
  }

  /** the worker rebuilds Player objects each turn; keep the evolved population but point at the fresh record */
  setPlayer(p: Player) { this.player = p; }

  stopThinkFunction() { this.myTurn = false; this.processing = false; this.runId++; }

  private score(fn: PolishNotationFunction, angle: number): number {
    const g = this.game;
    const players = g.players;
    const team = this.player.team;
    const shot = computeShot(g.gameMode, fn, g.terrain!, players, g.currentTurn, team, angle);
    let minDistSquared = 1000000;
    let total = 0;
    for (let i = 0; i < players.length; i++) {
      soldiers:
      for (let j = 0; j < players[i].numSoldiers; j++) {
        const s = players[i].soldiers[j];
        if (!s.alive) continue;
        for (let k = 0; k < shot.numPlayersHit; k++) {
          if (shot.playersHit[k] === i && shot.soldiersHit[k] === j) {
            total += players[i].team !== team ? 2000000 : -2000000;
            continue soldiers;
          }
        }
        if (players[i].team !== team) {
          let soldierMin = Number.MAX_VALUE;
          for (let k = 0; k < shot.numSteps; k++) {
            let distX: number;
            const distY = (-PLANE_LENGTH * shot.valuesY[k] / PLANE_GAME_LENGTH + PLANE_HEIGHT / 2) - s.y;
            if (team === TEAM2) {
              distX = PLANE_LENGTH - (PLANE_LENGTH * shot.valuesX[k] / PLANE_GAME_LENGTH + PLANE_LENGTH / 2) - s.x;
              if (distX < 0) continue;
            } else {
              distX = (PLANE_LENGTH * shot.valuesX[k] / PLANE_GAME_LENGTH + PLANE_LENGTH / 2) - s.x;
              if (distX > 0) continue;
            }
            const d = distX * distX + distY * distY;
            if (d < soldierMin) soldierMin = d;
          }
          if (soldierMin < minDistSquared) minDistSquared = soldierMin;
        }
      }
    }
    total += 1000000 - minDistSquared;
    return total;
  }

  private toReproduce(fs: Evolvable[], totalPoints: number): number {
    const randomPoints = totalPoints * this.rng.next();
    for (let i = 0; i < fs.length; i++) {
      if (totalPoints > randomPoints) totalPoints -= fs[i].points;
      else return i;
    }
    return 0;
  }

  private alive(id: number) { return this.processing && this.runId === id; }

  private async run(id: number) {
    const g = this.game;
    const mode = g.gameMode;
    const me = this.player;
    let functions = this.pop[me.currentTurnSoldier];
    let sliceStart = performance.now();
    const maybeYield = async () => {
      if (performance.now() - sliceStart > this.workBudgetMs) { await this.sleep(); sliceStart = performance.now(); }
    };

    generation:
    for (let k = 0;
      this.alive(id) && g.gameState === GameState.GAME &&
      ((k < this.numGenerations && g.remainingTime() > 5000) || this.over9000);
      k++) {
      functions = this.pop[me.currentTurnSoldier];
      const total = functions.reduce((a, f) => a + f.points, 0);
      const next: Evolvable[] = new Array(NUM_FUNCTIONS_AI);
      for (let i = 0; i < NUM_FUNCTIONS_UNCHANGED_TURN_AI; i++) next[i] = functions[i];
      for (let i = NUM_FUNCTIONS_UNCHANGED_TURN_AI; i < NUM_FUNCTIONS_UNCHANGED_TURN_AI + NUM_FUNCTION_MUTATED_AI; i++) {
        const idx = this.toReproduce(functions, total);
        next[i] = { fn: PolishNotationFunction.mutate(functions[idx].fn, mode, this.rng), angle: functions[idx].angle, points: 0 };
        if (mode === SND_ODE && nextBoolean(this.rng)) this.mutateAngleQuirk(functions, i);
      }
      for (let i = NUM_FUNCTIONS_UNCHANGED_TURN_AI + NUM_FUNCTION_MUTATED_AI; i < NUM_FUNCTIONS_AI; i++) {
        const c1 = this.toReproduce(functions, total);
        const c2 = this.toReproduce(functions, total);
        next[i] = {
          fn: PolishNotationFunction.crossover(functions[c1].fn, functions[c2].fn, mode, this.rng),
          angle: nextBoolean(this.rng) ? functions[c1].angle : functions[c2].angle, points: 0,
        };
        if (mode === SND_ODE && nextBoolean(this.rng)) this.mutateAngleQuirk(functions, i);
      }
      const old = this.pop[me.currentTurnSoldier];
      this.pop[me.currentTurnSoldier] = next;
      functions = next;
      for (let i = 0; i < NUM_FUNCTIONS_AI; i++) {
        functions[i].points = this.score(functions[i].fn, functions[i].angle);
        await maybeYield();
        if (!this.alive(id) || g.gameState !== GameState.GAME) return;
        if (g.remainingTime() < 3000 && !this.over9000) {
          functions = old;
          this.pop[me.currentTurnSoldier] = old;
          break generation;
        }
      }
      functions.sort((a, b) => (a.points < b.points ? 1 : a.points > b.points ? -1 : 0));
      if (this.over9000 && this.myTurn && g.remainingTime() < 5000) {
        this.best[me.currentTurnSoldier] = functions[0];
        this.fire();
        this.myTurn = false;
      }
      await this.sleep();
    }
    if (!this.alive(id)) return;
    if (!this.over9000) {
      this.best[me.currentTurnSoldier] = functions[0];
      this.fire();
    }
    this.processing = false;
  }

  /** the Java code mutates functions[i] (previous generation) instead of newFunctions[i]; preserved */
  private mutateAngleQuirk(functions: Evolvable[], i: number) {
    if (nextBoolean(this.rng)) functions[i].angle = Math.PI * this.rng.next() - Math.PI / 2;
    else functions[i].angle = functions[i].angle + functions[i].angle * (this.rng.next() - 0.5) / 5;
  }

  private fire() {
    const b = this.best[this.player.currentTurnSoldier];
    this.lastFunction = b.fn.simplifyFunction().getStringFunction();
    this.bestAngle = b.angle;
    this.game.setAngle(b.angle);
    this.game.sendFunction(this.lastFunction);
  }
}

