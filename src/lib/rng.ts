/**
 * Deterministic pseudo-random number generation.
 *
 * Every stochastic part of this system -- the simulator that builds the demo
 * dataset and the Monte Carlo inside the risk engine -- runs through a seeded
 * generator. That is a deliberate choice: a demo that produces different
 * numbers on every reload cannot be debugged, cannot be regression-tested, and
 * cannot be shown twice to a jury with the same result.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  int(minInclusive: number, maxExclusive: number): number;
  /** Uniform real in [min, max). */
  real(min: number, max: number): number;
  bool(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Box-Muller normal deviate. */
  normal(mean: number, sd: number): number;
  /** Knuth / PTRS Poisson deviate. */
  poisson(lambda: number): number;
  /** Marsaglia-Tsang gamma deviate, shape k > 0, scale theta > 0. */
  gamma(shape: number, scale: number): number;
  /** Negative binomial via gamma-Poisson mixture. Useful for overdispersed counts. */
  negBinomial(mean: number, dispersion: number): number;
}

/** mulberry32 -- small, fast, and good enough for simulation and Monte Carlo. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  let spare: number | null = null;

  const rng: Rng = {
    next,
    int: (min, max) => Math.floor(next() * (max - min)) + min,
    real: (min, max) => next() * (max - min) + min,
    bool: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],

    normal(mean, sd) {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return mean + sd * v;
      }
      let u = 0;
      let v = 0;
      let s = 0;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        s = u * u + v * v;
      } while (s === 0 || s >= 1);
      const mul = Math.sqrt((-2 * Math.log(s)) / s);
      spare = v * mul;
      return mean + sd * (u * mul);
    },

    poisson(lambda) {
      if (lambda <= 0) return 0;
      // Knuth is exact but O(lambda); switch to a normal approximation with
      // continuity correction once that gets expensive.
      if (lambda < 30) {
        const l = Math.exp(-lambda);
        let k = 0;
        let p = 1;
        do {
          k++;
          p *= next();
        } while (p > l);
        return k - 1;
      }
      return Math.max(0, Math.round(rng.normal(lambda, Math.sqrt(lambda))));
    },

    gamma(shape, scale) {
      if (shape <= 0 || scale <= 0) return 0;
      if (shape < 1) {
        // Boost low shapes into the valid range for Marsaglia-Tsang.
        return rng.gamma(shape + 1, scale) * Math.pow(next(), 1 / shape);
      }
      const d = shape - 1 / 3;
      const c = 1 / Math.sqrt(9 * d);
      for (;;) {
        let x = 0;
        let v = 0;
        do {
          x = rng.normal(0, 1);
          v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = next();
        if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
      }
    },

    negBinomial(mean, dispersion) {
      if (mean <= 0) return 0;
      if (dispersion <= 0) return rng.poisson(mean);
      // Gamma-Poisson mixture: variance = mean + mean^2 / dispersion.
      const lambda = rng.gamma(dispersion, mean / dispersion);
      return rng.poisson(lambda);
    },
  };

  return rng;
}

/** Stable 32-bit hash of a string, so any entity ID can seed its own generator. */
export function hashSeed(...parts: (string | number)[]): number {
  const str = parts.join('|');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
