// Port of Graphwar/PolishNotationFunction.java + FunctionToken/ValueToken.
// Expression -> prefix (Polish) token array, evaluated recursively.
import {
  RANDOM_FUNC_MEAN_CROSSOVER_LENGTH, RANDOM_FUNC_MEAN_LENGTH,
  RANDOM_FUNC_VALUE_CHANCE, RANDOM_FUNC_VALUE_MEAN, RANDOM_FUNC_VARIABLE_CHANCE,
  NORMAL_FUNC, FST_ODE, SND_ODE,
} from './constants';
import { Rng, defaultRng, nextBoolean, nextGaussian, nextInt } from './rng';

export const T = {
  ADD: 1, SUBTRACT: 2, MULTIPLY: 3, DIVIDE: 4, POW: 5, SQRT: 6, LOG: 7, ABS: 8,
  SIN: 9, COS: 10, TAN: 11, LN: 12, VARIABLE1: 13, VARIABLE2: 14, VARIABLE3: 15,
  VALUE: 16, LEFT_BRACKET: 17, RIGHT_BRACKET: 18,
} as const;

export interface Token { type: number; value?: number }

export class MalformedFunction extends Error {
  constructor() { super('Malformed function'); }
}

const tok = (type: number): Token => ({ type });
const val = (value: number): Token => ({ type: T.VALUE, value });

const isOperation = (t: number) => t >= 1 && t <= 12;
const getNumParam = (t: number) => (t === 2 ? 1 : t >= 1 && t <= 5 ? 2 : t >= 6 && t <= 12 ? 1 : 0);
// lower type value = higher precedence for the "split point" search (same as Java `precedes`)
const precedes = (t0: number, t1: number) => t0 < t1;

const TOKEN_RE = /[0-9]*\.?[0-9]+|\(|\)|x|y'|y|\+|\*|\/|\^|sqrt|log|abs|sin|sen|cos|tan|tg|-|ln|e|pi/g;
const NUMBER_RE = /^[0-9]*\.?[0-9]+$/;

function isImplicit(t1: number, t2: number): boolean {
  if (t1 === T.VALUE || t1 === T.VARIABLE1 || t1 === T.VARIABLE2 || t1 === T.VARIABLE3 || t1 === T.RIGHT_BRACKET) {
    if (t2 === T.VALUE || t2 === T.VARIABLE1 || t2 === T.VARIABLE2 || t2 === T.VARIABLE3 ||
        t2 === T.LEFT_BRACKET || getNumParam(t2) === 1) return true;
  }
  return false;
}

function createRegularNotationTokens(arg: string): Token[] {
  let s = arg.toLowerCase();
  s = s.replace(/-/g, '+-');
  s = s.replace(/exp/g, 'e^');
  s = s.replace(/,/g, '.');

  const out: Token[] = [];
  for (const m of s.matchAll(TOKEN_RE)) {
    const t = m[0];
    if (NUMBER_RE.test(t)) { out.push(val(parseFloat(t))); continue; }
    switch (t) {
      case 'x': out.push(tok(T.VARIABLE1)); break;
      case 'y': out.push(tok(T.VARIABLE2)); break;
      case "y'": out.push(tok(T.VARIABLE3)); break;
      case '+': out.push(tok(T.ADD)); break;
      case '-': out.push(tok(T.SUBTRACT)); break;
      case '*': out.push(tok(T.MULTIPLY)); break;
      case '/': out.push(tok(T.DIVIDE)); break;
      case 'sqrt': out.push(tok(T.SQRT)); break;
      case 'log': out.push(tok(T.LOG)); break;
      case 'abs': out.push(tok(T.ABS)); break;
      case 'sin': case 'sen': out.push(tok(T.SIN)); break;
      case 'cos': out.push(tok(T.COS)); break;
      case 'tan': case 'tg': out.push(tok(T.TAN)); break;
      case '^': out.push(tok(T.POW)); break;
      case 'ln': out.push(tok(T.LN)); break;
      case 'e': out.push(val(Math.E)); break;
      case 'pi': out.push(val(Math.PI)); break;
      case '(': out.push(tok(T.LEFT_BRACKET)); break;
      case ')': out.push(tok(T.RIGHT_BRACKET)); break;
    }
  }
  // implicit multiplications
  const res: Token[] = [];
  for (let i = 0; i < out.length; i++) {
    if (i > 0 && isImplicit(out[i - 1].type, out[i].type)) res.push(tok(T.MULTIPLY));
    res.push(out[i]);
  }
  return res;
}

function reorderRec(polish: Token[], f: Token[], start: number, end: number): boolean {
  if (start > end || start >= f.length) return false;
  let next = -1;
  let nextNest = Number.MAX_SAFE_INTEGER;
  let nest = 0;
  for (let i = start; i <= end; i++) {
    if (f[i].type === T.LEFT_BRACKET) nest++;
    else if (f[i].type === T.RIGHT_BRACKET) nest--;
    else if (nest < nextNest || (nest === nextNest && (next === -1 || precedes(f[i].type, f[next].type)))) {
      next = i;
      nextNest = nest;
    }
  }
  if (next === -1) return false;
  switch (getNumParam(f[next].type)) {
    case 0: polish.push(f[next]); break;
    case 1:
      polish.push(f[next]);
      reorderRec(polish, f, next + 1, end);
      break;
    case 2: {
      polish.push(f[next]);
      const leftExists = reorderRec(polish, f, start, next - 1);
      if (f[next].type === T.ADD && !leftExists) polish.push(val(0)); // unary plus
      reorderRec(polish, f, next + 1, end);
      break;
    }
  }
  return true;
}

function fmt(v: number): string {
  // Java DecimalFormat("#######.##") : max 2 decimals, no trailing zeros, HALF_EVEN
  const r = Math.round(v * 100) / 100;
  let s = r.toFixed(2).replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  return s;
}

export class PolishNotationFunction {
  fn: Token[];
  private readLocation = 0;
  private var1 = 0; private var2 = 0; private var3 = 0;

  constructor(source?: string | Token[]) {
    if (source === undefined) { this.fn = []; return; }
    if (Array.isArray(source)) { this.fn = source; return; }
    const normal = createRegularNotationTokens(source);
    const polish: Token[] = [];
    reorderRec(polish, normal, 0, normal.length - 1);
    this.fn = polish;
    if (this.getValuesNeeded() !== 0) throw new MalformedFunction();
  }

  private getValuesNeeded(): number {
    let needed = 1;
    for (let i = 0; i < this.fn.length; i++) {
      if (isOperation(this.fn[i].type)) needed += getNumParam(this.fn[i].type) - 1;
      else needed--;
      if (needed === 0 && i + 1 < this.fn.length) return -1;
    }
    return needed;
  }

  evaluateFunction(v1: number, v2: number, v3: number): number {
    this.var1 = v1; this.var2 = v2; this.var3 = v3;
    this.readLocation = 0;
    return this.evalRec();
  }

  private evalRec(): number {
    const t = this.fn[this.readLocation++];
    switch (t.type) {
      case T.VARIABLE1: return this.var1;
      case T.VARIABLE2: return this.var2;
      case T.VARIABLE3: return this.var3;
      case T.VALUE: return t.value!;
      case T.ADD: { const a = this.evalRec(); return a + this.evalRec(); }
      case T.SUBTRACT: return -this.evalRec();
      case T.MULTIPLY: { const a = this.evalRec(); return a * this.evalRec(); }
      case T.DIVIDE: { const a = this.evalRec(); return a / this.evalRec(); }
      case T.SQRT: return Math.sqrt(this.evalRec());
      case T.LOG: return Math.log10(this.evalRec());
      case T.ABS: return Math.abs(this.evalRec());
      case T.SIN: return Math.sin(this.evalRec());
      case T.COS: return Math.cos(this.evalRec());
      case T.TAN: return Math.tan(this.evalRec());
      case T.POW: { const a = this.evalRec(); return Math.pow(a, this.evalRec()); }
      case T.LN: return Math.log(this.evalRec());
    }
    return 0;
  }

  // ---------- string output (used by AI to say its function) ----------
  getStringFunction(): string { this.readLocation = 0; return this.makeString(); }

  private printToken(t: Token): string {
    switch (t.type) {
      case T.VARIABLE1: return 'x';
      case T.VARIABLE2: return 'y';
      case T.VARIABLE3: return "y'";
      case T.VALUE: return fmt(t.value!);
      case T.ADD: return '+';
      case T.SUBTRACT: return '-';
      case T.MULTIPLY: return '*';
      case T.DIVIDE: return '/';
      case T.SQRT: return 'sqrt';
      case T.LOG: return 'log';
      case T.ABS: return 'abs';
      case T.SIN: return 'sin';
      case T.COS: return 'cos';
      case T.TAN: return 'tan';
      case T.POW: return '^';
      case T.LN: return 'ln';
    }
    return '';
  }

  private makeString(): string {
    const cur = this.fn[this.readLocation++];
    const type = cur.type;
    if (isOperation(type)) {
      if (getNumParam(type) === 2) {
        const l = this.makeString();
        const op = this.printToken(cur);
        return '(' + l + op + this.makeString() + ')';
      }
      if (type === T.SUBTRACT) return '(' + this.printToken(cur) + '(' + this.makeString() + '))';
      return this.printToken(cur) + '(' + this.makeString() + ')';
    }
    if (type === T.VALUE && cur.value! < 0) return '(' + this.printToken(cur) + ')';
    return this.printToken(cur);
  }

  // ---------- genetic helpers (used by computer players) ----------
  makeCopy(): PolishNotationFunction {
    return new PolishNotationFunction(this.fn.map(t => (t.type === T.VALUE ? val(t.value!) : tok(t.type))));
  }

  private static randomValueToken(mode: number, r: Rng): Token {
    if (r.next() < RANDOM_FUNC_VARIABLE_CHANCE) {
      switch (mode) {
        case NORMAL_FUNC: return tok(T.VARIABLE1);
        case FST_ODE: return nextBoolean(r) ? tok(T.VARIABLE1) : tok(T.VARIABLE2);
        case SND_ODE:
          if (nextInt(r, 3) === 0) return tok(T.VARIABLE1);
          return nextBoolean(r) ? tok(T.VARIABLE2) : tok(T.VARIABLE3);
      }
    }
    return val(nextGaussian(r) * RANDOM_FUNC_VALUE_MEAN);
  }

  private static randomOperator(r: Rng): number {
    switch (nextInt(r, 19)) {
      case 0: return T.SQRT; case 1: return T.LOG; case 2: return T.ABS;
      case 3: return T.SIN; case 4: return T.COS; case 5: return T.TAN; case 6: return T.LN;
      case 7: case 8: case 9: case 10: return T.ADD;
      case 11: case 12: case 13: return T.MULTIPLY;
      case 14: case 15: case 16: return T.DIVIDE;
      default: return T.POW;
    }
  }

  private static randomToken(mode: number, r: Rng): Token {
    return r.next() < RANDOM_FUNC_VALUE_CHANCE
      ? PolishNotationFunction.randomValueToken(mode, r)
      : tok(PolishNotationFunction.randomOperator(r));
  }

  private static adjust(f: Token[], mode: number, r: Rng): Token[] {
    let needed = 1;
    for (let i = 0; i < f.length; i++) {
      if (isOperation(f[i].type)) needed += getNumParam(f[i].type) - 1;
      else needed--;
      if (needed === 0) return f.slice(0, i + 1);
    }
    const out = f.slice();
    for (let i = 0; i < needed; i++) out.push(PolishNotationFunction.randomValueToken(mode, r));
    return out;
  }

  makeRandomFunction(mode: number, r: Rng = defaultRng): void {
    const size = Math.floor(RANDOM_FUNC_MEAN_LENGTH * Math.abs(nextGaussian(r)));
    const f: Token[] = [];
    for (let i = 0; i < size; i++) f.push(PolishNotationFunction.randomToken(mode, r));
    this.fn = PolishNotationFunction.adjust(f, mode, r);
  }

  /** mutation of an existing function (fine tune a constant, or replace a region) */
  static mutate(f1: PolishNotationFunction, mode: number, r: Rng = defaultRng): PolishNotationFunction {
    const res = new PolishNotationFunction();
    res.fn = nextBoolean(r) ? res.mutateFineTune(f1, mode, r) : res.mutateRegion(f1, mode, r);
    return res;
  }

  private mutateRegion(f1: PolishNotationFunction, mode: number, r: Rng): Token[] {
    let lengthOut = Math.floor(RANDOM_FUNC_MEAN_CROSSOVER_LENGTH * Math.abs(nextGaussian(r)));
    const lengthIn = Math.floor(RANDOM_FUNC_MEAN_CROSSOVER_LENGTH * Math.abs(nextGaussian(r)));
    if (lengthOut > f1.fn.length) lengthOut = f1.fn.length;
    const outLocation = nextInt(r, f1.fn.length - lengthOut + 1);
    const f: Token[] = [];
    for (let i = 0; i < outLocation; i++) f.push(f1.fn[i]);
    for (let i = 0; i < lengthIn; i++) f.push(PolishNotationFunction.randomToken(mode, r));
    for (let i = 0; i < f1.fn.length - lengthOut - outLocation; i++) f.push(f1.fn[outLocation + lengthOut + i]);
    return PolishNotationFunction.adjust(f, mode, r);
  }

  private mutateFineTune(f1: PolishNotationFunction, mode: number, r: Rng): Token[] {
    const copy = f1.makeCopy();
    let numValues = 0;
    for (const t of copy.fn) if (t.type === T.VALUE) numValues++;
    if (numValues === 0) { this.makeRandomFunction(mode, r); return this.fn; }
    let target = nextInt(r, numValues);
    for (let i = 0; i < copy.fn.length; i++) {
      if (copy.fn[i].type === T.VALUE) {
        if (target === 0) {
          copy.fn[i] = nextBoolean(r)
            ? val(nextGaussian(r) * RANDOM_FUNC_VALUE_MEAN)
            : val(copy.fn[i].value! * (nextGaussian(r) + 1));
          break;
        }
        target--;
      }
    }
    return copy.fn;
  }

  static crossover(a: PolishNotationFunction, b: PolishNotationFunction, mode: number, r: Rng = defaultRng): PolishNotationFunction {
    if (nextBoolean(r)) { const t = a; a = b; b = t; }
    let c1 = Math.floor(RANDOM_FUNC_MEAN_CROSSOVER_LENGTH * Math.abs(nextGaussian(r)));
    let c2 = Math.floor(RANDOM_FUNC_MEAN_CROSSOVER_LENGTH * Math.abs(nextGaussian(r)));
    const l1 = a.fn.length, l2 = b.fn.length;
    if (c1 > l1) c1 = l1;
    if (c2 > l2) c2 = l2;
    const loc1 = nextInt(r, l1 - c1 + 1);
    const loc2 = nextInt(r, l2 - c2 + 1);
    const f: Token[] = [];
    for (let i = 0; i < loc1; i++) f.push(a.fn[i]);
    for (let i = 0; i < c2; i++) f.push(b.fn[loc2 + i]);
    for (let i = 0; i < l1 - c1 - loc1; i++) f.push(a.fn[loc1 + c1 + i]);
    return new PolishNotationFunction(PolishNotationFunction.adjust(f, mode, r));
  }

  /** constant folding */
  simplifyFunction(): PolishNotationFunction {
    this.readLocation = 0;
    return new PolishNotationFunction(this.simplifyRec());
  }

  private evalToken(t: Token, p1: number, p2: number): number {
    switch (t.type) {
      case T.ADD: return p1 + p2;
      case T.SUBTRACT: return -p1;
      case T.MULTIPLY: return p1 * p2;
      case T.DIVIDE: return p1 / p2;
      case T.SQRT: return Math.sqrt(p1);
      case T.LOG: return Math.log10(p1);
      case T.ABS: return Math.abs(p1);
      case T.SIN: return Math.sin(p1);
      case T.COS: return Math.cos(p1);
      case T.TAN: return Math.tan(p1);
      case T.POW: return Math.pow(p1, p2);
      case T.LN: return Math.log(p1);
    }
    return 0;
  }

  private simplifyRec(): Token[] {
    const cur = this.fn[this.readLocation++];
    const n = getNumParam(cur.type);
    if (n === 2) {
      const l1 = this.simplifyRec(), l2 = this.simplifyRec();
      if (l1.length === 1 && l2.length === 1 && l1[0].type === T.VALUE && l2[0].type === T.VALUE)
        return [val(this.evalToken(cur, l1[0].value!, l2[0].value!))];
      return [cur, ...l1, ...l2];
    }
    if (n === 1) {
      const l1 = this.simplifyRec();
      if (l1.length === 1 && l1[0].type === T.VALUE) return [val(this.evalToken(cur, l1[0].value!, 0))];
      return [cur, ...l1];
    }
    return [cur];
  }
}
