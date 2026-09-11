/**
 * Deterministic mutation engine for the fuzz lane (#839 G10).
 *
 * No external fuzzing dependency exists in this repo and none may be added
 * (Node is pinned to 24.4.1, bun to 1.3.13). This is the whole engine: a
 * seeded PRNG, a byte-mutation table, and a structure-aware JSON pass. Every
 * choice comes from the PRNG, so a run is a pure function of
 * (seed, corpus bytes, iteration count) — a failing iteration replays from the
 * seed alone, exactly like `commons-sim` replays a failing schedule.
 */

/** Largest mutated input the engine will produce. Bounds memory and keeps
 * throughput high enough that a 30–60s budget is thousands of executions. */
export const MAX_INPUT_BYTES = 4096;

/**
 * mulberry32 — small, fast, and identical on every platform.
 * Mirrors `commons-sim-world.test-fixtures.ts` so the repo has one seeded
 * scheduler, not two.
 * @param {number} seed 32-bit seed.
 * @returns {() => number} Uniform [0,1) generator.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  int: (limit: number) => number;
  pick: <T>(items: readonly T[]) => T;
  bool: () => boolean;
}

/**
 * Seeded RNG facade.
 * @param {number} seed 32-bit seed.
 * @returns {Rng} Generator facade.
 */
export function createRng(seed: number): Rng {
  const random = mulberry32(seed);
  const int = (limit: number): number =>
    limit <= 0 ? 0 : Math.floor(random() * limit);
  return {
    int,
    pick: <T>(items: readonly T[]): T => {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error("rng.pick on empty list");
      return item;
    },
    bool: () => random() < 0.5,
  };
}

/** Byte values that sit on the boundaries parsers actually branch on. */
const INTERESTING_BYTES = [
  0x00, 0x01, 0x07, 0x0a, 0x0d, 0x20, 0x22, 0x2a, 0x2d, 0x2e, 0x2f, 0x30, 0x39,
  0x3a, 0x5c, 0x7b, 0x7d, 0x7f, 0x80, 0xc0, 0xf0, 0xfd, 0xfe, 0xff,
];

/** Multi-byte values that flip integer decoders across a boundary. */
const INTERESTING_WORDS = [
  [0x00, 0x00, 0x00, 0x00],
  [0x00, 0x00, 0x00, 0x01],
  [0x7f, 0xff, 0xff, 0xff],
  [0x80, 0x00, 0x00, 0x00],
  [0xff, 0xff, 0xff, 0xff],
  [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  [0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
];

/** JSON values worth splicing into a structure-aware mutation. */
const INTERESTING_JSON = [
  null,
  true,
  false,
  0,
  -1,
  1e308,
  -0,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  1.5,
  "",
  '"',
  "\0",
  "\uD800",
  [],
  {},
  [[[[[]]]]],
];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Decode bytes as UTF-8 with replacement characters (never throws).
 * @param {Uint8Array} bytes Input bytes.
 * @returns {string} Lossy UTF-8 text.
 */
export function utf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/**
 * Encode text as UTF-8 bytes.
 * @param {string} text Input text.
 * @returns {Uint8Array} Encoded bytes.
 */
export function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * Clamp an input to {@link MAX_INPUT_BYTES}.
 * @param {Uint8Array} bytes Candidate input.
 * @returns {Uint8Array} Bounded input.
 */
function bound(candidate: Uint8Array): Uint8Array {
  return candidate.length <= MAX_INPUT_BYTES
    ? candidate
    : candidate.subarray(0, MAX_INPUT_BYTES);
}

/**
 * Splice `insert` into `bytes` at `at`, replacing `remove` bytes.
 * @param {Uint8Array} bytes Base input.
 * @param {number} at Offset.
 * @param {number} remove Bytes to drop at `at`.
 * @param {ArrayLike<number>} insert Bytes to write at `at`.
 * @returns {Uint8Array} New input.
 */
function splice(
  bytes: Uint8Array,
  at: number,
  remove: number,
  insert: ArrayLike<number>
): Uint8Array {
  const head = bytes.subarray(0, at);
  const tail = bytes.subarray(Math.min(bytes.length, at + remove));
  const out = new Uint8Array(head.length + insert.length + tail.length);
  out.set(head, 0);
  out.set(Uint8Array.from(insert), head.length);
  out.set(tail, head.length + insert.length);
  return bound(out);
}

/**
 * Rewrite one node of a parsed JSON value, chosen by the RNG.
 * Structure-aware mutation keeps JSON-shaped inputs *parseable* far more often
 * than a bit flip does, which is the only way the deeper branches of a JSON
 * parser (field type checks, version gates) are ever reached.
 * @param {unknown} value Parsed JSON value.
 * @param {Rng} rng Seeded RNG.
 * @param {number} depth Recursion guard.
 * @returns {unknown} Mutated value.
 */
function mutateJsonValue(value: unknown, rng: Rng, depth: number = 0): unknown {
  if (depth > 6) return rng.pick(INTERESTING_JSON);
  if (Array.isArray(value)) {
    if (value.length === 0 || rng.int(4) === 0)
      return [...value, rng.pick(INTERESTING_JSON)];
    const index = rng.int(value.length);
    const next = [...value];
    if (rng.int(5) === 0) next.splice(index, 1);
    else next[index] = mutateJsonValue(value[index], rng, depth + 1);
    return next;
  }
  if (value !== null && typeof value === "object") {
    const record = { ...value } as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 0 || rng.int(5) === 0) {
      record[`k${rng.int(8)}`] = rng.pick(INTERESTING_JSON);
      return record;
    }
    const key = rng.pick(keys);
    if (rng.int(6) === 0) delete record[key];
    else record[key] = mutateJsonValue(record[key], rng, depth + 1);
    return record;
  }
  return rng.pick(INTERESTING_JSON);
}

/**
 * Structure-aware pass: parse, rewrite one node, re-serialize.
 * Returns null when the input is not JSON (the caller falls back to bytes).
 * @param {Uint8Array} bytes Candidate input.
 * @param {Rng} rng Seeded RNG.
 * @returns {Uint8Array | null} Mutated JSON bytes, or null.
 */
function mutateJson(bytes: Uint8Array, rng: Rng): Uint8Array | null {
  const text = utf8(bytes);
  let parsed;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // Not JSON — this strategy has nothing to say about the input. Reported as
    // "no candidate" rather than swallowed: the caller picks a byte strategy.
    return null;
  }
  const serialized = JSON.stringify(mutateJsonValue(parsed, rng));
  return serialized === undefined ? null : bound(bytesOf(serialized));
}

/**
 * Byte-level mutation table. Every entry has the same shape:
 * `(bytes, rng, dictionary) => Uint8Array`.
 */
type Mutator = (
  bytes: Uint8Array,
  rng: Rng,
  dictionary?: readonly string[]
) => Uint8Array;

const STRATEGIES: Record<string, Mutator> = {
  /** Flip one bit — the classic minimal perturbation. */
  bitFlip(bytes, rng) {
    if (bytes.length === 0) return Uint8Array.of(rng.int(256));
    const at = rng.int(bytes.length);
    const out = Uint8Array.from(bytes);
    const current = out[at] ?? 0;
    out[at] = current ^ (1 << rng.int(8));
    return out;
  },
  /** Overwrite one byte with a boundary value. */
  interestingByte(bytes, rng) {
    const byte = rng.pick(INTERESTING_BYTES);
    if (bytes.length === 0) return Uint8Array.of(byte);
    const out = Uint8Array.from(bytes);
    out[rng.int(bytes.length)] = byte;
    return out;
  },
  /** Overwrite a run with a boundary word (integer decoder boundaries). */
  interestingWord(bytes, rng) {
    const word = rng.pick(INTERESTING_WORDS);
    return splice(bytes, rng.int(bytes.length + 1), word.length, word);
  },
  /** Cut the tail off — truncation is where length checks fail open. */
  truncate(bytes, rng) {
    return bytes.subarray(0, rng.int(bytes.length + 1));
  },
  /** Delete an interior chunk. */
  deleteChunk(bytes, rng) {
    if (bytes.length === 0) return bytes;
    const at = rng.int(bytes.length);
    return splice(bytes, at, 1 + rng.int(bytes.length - at), []);
  },
  /** Duplicate an interior chunk (grows the input toward the cap). */
  repeatChunk(bytes, rng) {
    if (bytes.length === 0) return bytes;
    const at = rng.int(bytes.length);
    const size = 1 + rng.int(Math.min(64, bytes.length - at));
    return splice(bytes, at, 0, bytes.subarray(at, at + size));
  },
  /** Insert a target dictionary token (grammar keywords, key prefixes). */
  dictionary(bytes, rng, dictionary = []) {
    if (dictionary.length === 0) {
      const fallback = STRATEGIES["interestingByte"];
      if (!fallback) return bytes;
      return fallback(bytes, rng);
    }
    return splice(
      bytes,
      rng.int(bytes.length + 1),
      rng.bool() ? 0 : rng.int(8),
      bytesOf(rng.pick(dictionary))
    );
  },
  /** Repeat the whole input — cheap way to reach length and nesting limits. */
  double(bytes) {
    const out = new Uint8Array(bytes.length * 2);
    out.set(bytes, 0);
    out.set(bytes, bytes.length);
    return bound(out);
  },
};

const STRATEGY_NAMES = Object.keys(STRATEGIES);

/**
 * Produce one mutant from a corpus entry.
 *
 * `structure: "json"` first tries the structure-aware pass, then falls back to
 * a byte strategy; a crossover with a second corpus entry runs with fixed
 * probability so the engine can combine two independently-interesting inputs.
 * @param {object} options Mutation inputs.
 * @param {Uint8Array} options.bytes Corpus entry to mutate.
 * @param {Uint8Array} [options.other] Second corpus entry for crossover.
 * @param {Rng} options.rng Seeded RNG.
 * @param {readonly string[]} [options.dictionary] Target tokens.
 * @param {"json" | "text" | "bytes"} [options.structure] Input shape hint.
 * @returns {{ bytes: Uint8Array; strategy: string }} Mutant plus the strategy that made it.
 */
export function mutate(options: {
  bytes: Uint8Array;
  other?: Uint8Array;
  rng: Rng;
  dictionary?: readonly string[];
  structure?: "json" | "text" | "bytes";
}): { bytes: Uint8Array; strategy: string } {
  const { bytes, other, rng, dictionary = [], structure = "bytes" } = options;
  if (structure === "json" && rng.int(3) !== 0) {
    const json = mutateJson(bytes, rng);
    if (json) return { bytes: json, strategy: "jsonNode" };
  }
  if (other && other.length > 0 && bytes.length > 0 && rng.int(6) === 0) {
    const cut = rng.int(bytes.length);
    const otherCut = rng.int(other.length);
    return {
      bytes: splice(bytes, cut, bytes.length - cut, other.subarray(otherCut)),
      strategy: "crossover",
    };
  }
  const strategy = rng.pick(STRATEGY_NAMES);
  const mutator = STRATEGIES[strategy];
  if (!mutator) throw new Error(`fuzz: unknown strategy ${strategy}`);
  return {
    bytes: bound(mutator(bytes, rng, dictionary)),
    strategy,
  };
}
