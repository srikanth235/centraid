export interface SeededRandom {
  /** Uniform in [0, 1), the `Math.random` contract, but reproducible. */
  next: () => number;
  /** Uniform integer in [min, max]. */
  int: (min: number, max: number) => number;
  /** A short lowercase alphanumeric token — the usual "unique suffix" need. */
  token: (length?: number) => string;
}

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A deterministic replacement for `Math.random()`, which is banned in test
 * files (see the test-seam override in `oxlint.config.ts`).
 *
 * A test seeded from `Math.random()` has a different input on every run, so a
 * failure it finds is not reproducible from the failing run's output alone —
 * the run that goes red and the run the author reproduces it in are different
 * tests. Seeding from a literal keeps the generated corpus varied across
 * *cases* while keeping any single case replayable forever.
 *
 * mulberry32: 32-bit state, no dependencies, passes gjrand for the small draws
 * a fixture needs. Not for cryptography.
 */
export function seededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;
  const draw = (): number => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number): number =>
    min + Math.floor(draw() * (max - min + 1));
  return {
    next: draw,
    int,
    token: (length = 6) => {
      let out = "";
      for (let index = 0; index < length; index += 1) {
        out += TOKEN_ALPHABET[int(0, TOKEN_ALPHABET.length - 1)];
      }
      return out;
    },
  };
}
