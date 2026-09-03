export interface SeededRandom {
  next: () => number;
  int: (min: number, max: number) => number;
  token: (length?: number) => string;
}

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

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
