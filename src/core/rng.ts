// Small RNG helpers mirroring java.util.Random usage in the original.
export interface Rng {
  next(): number; // [0,1)
}

export const defaultRng: Rng = { next: () => Math.random() };

/** mulberry32 – seedable, used by tests so results are reproducible */
export function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

export const nextInt = (r: Rng, bound: number) => Math.floor(r.next() * bound);
export const nextBoolean = (r: Rng) => r.next() < 0.5;

/** Box–Muller standard normal (java's nextGaussian is polar method; same distribution). */
export function nextGaussian(r: Rng): number {
  let u = 0;
  while (u === 0) u = r.next();
  const v = r.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
