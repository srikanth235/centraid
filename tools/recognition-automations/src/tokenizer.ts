// Pure-TS byte-level BPE tokenizer matching OpenAI CLIP's reference
// `simple_tokenizer.py` (MIT-licensed, https://github.com/openai/CLIP —
// same source as the ViT-B/32 weights this service downloads, see
// LICENSES.md). Implemented from the published algorithm rather than a
// vendored port: byte<->unicode remapping (identical to GPT-2's
// `bytes_to_unicode`), regex pre-tokenization, then rank-ordered pairwise
// merges read from the `merges.txt` BPE-rank file `bun run setup` fetches
// alongside the model weights.
//
// Deliberately generic over its vocab/merges input so the unit tests below
// can verify the ALGORITHM against a small, hand-computable synthetic
// vocabulary rather than asserting specific token ids from the real 49408-
// entry CLIP vocabulary from memory — this repo's honesty rule (never
// present an unverified number as fact) applies to test fixtures too. The
// real vocab.json/merges.txt (fetched by setup.ts from the same source as
// the ONNX weights) plug into this same `createBpeTokenizer` at runtime.

const START_OF_TEXT = "<|startoftext|>";
const END_OF_TEXT = "<|endoftext|>";

/**
 * GPT-2/CLIP's byte<->printable-unicode remapping: every one of the 256
 * byte values gets a stable, mergeable unicode codepoint, so BPE can be
 * learned over Unicode strings instead of raw bytes (which include
 * unmergeable control characters and don't roundtrip through Python's/JS's
 * string types uniformly).
 */
export function bytesToUnicode(): Map<number, string> {
  const bytes: number[] = [];
  for (
    let b = "!".codePointAt(0) as number;
    b <= ("~".codePointAt(0) as number);
    b++
  ) {
    bytes.push(b);
  }
  for (
    let b = "¡".codePointAt(0) as number;
    b <= ("¬".codePointAt(0) as number);
    b++
  ) {
    bytes.push(b);
  }
  for (
    let b = "®".codePointAt(0) as number;
    b <= ("ÿ".codePointAt(0) as number);
    b++
  ) {
    bytes.push(b);
  }

  const codepoints = [...bytes];
  let extra = 0;
  for (let b = 0; b < 256; b++) {
    if (!bytes.includes(b)) {
      bytes.push(b);
      codepoints.push(256 + extra);
      extra++;
    }
  }

  const map = new Map<number, string>();
  for (let i = 0; i < bytes.length; i++) {
    map.set(bytes[i] as number, String.fromCodePoint(codepoints[i] as number));
  }
  return map;
}

/** All adjacent symbol pairs in a word (a word is an array of BPE symbols). */
export function getPairs(word: readonly string[]): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < word.length - 1; i++) {
    pairs.add(`${word[i]} ${word[i + 1]}`);
  }
  return pairs;
}

/** Builds a rank lookup ("sym1 sym2" -> merge priority, lower = merges first) from ordered merge pairs. */
export function buildBpeRanks(
  merges: ReadonlyArray<readonly [string, string]>
): Map<string, number> {
  const ranks = new Map<string, number>();
  merges.forEach(([a, b], index) => {
    ranks.set(`${a} ${b}`, index);
  });
  return ranks;
}

/**
 * Applies BPE merges to a single word (already byte-remapped) until no
 * mergeable pair remains, following CLIP's reference algorithm: at each
 * step, merge the pair with the lowest rank (the earliest-learned merge);
 * stop when no remaining pair has a rank.
 */
export function bpeMerge(
  token: string,
  ranks: ReadonlyMap<string, number>
): string[] {
  if (token.length === 0) {
    return [];
  }
  if (token.length === 1) {
    return [`${token}</w>`];
  }

  let word: string[] = [...token.slice(0, -1), `${token.at(-1)}</w>`];

  for (;;) {
    let bestPair: [string, string] | undefined;
    let bestRank = Number.POSITIVE_INFINITY;

    for (let i = 0; i < word.length - 1; i++) {
      const a = word[i] as string;
      const b = word[i + 1] as string;
      const rank = ranks.get(`${a} ${b}`);
      if (rank !== undefined && rank < bestRank) {
        bestRank = rank;
        bestPair = [a, b];
      }
    }

    if (!bestPair) {
      break;
    }

    const [first, second] = bestPair;
    const merged: string[] = [];
    let i = 0;
    while (i < word.length) {
      if (word[i] === first && word[i + 1] === second) {
        merged.push(first + second);
        i += 2;
      } else {
        merged.push(word[i] as string);
        i += 1;
      }
    }
    word = merged;
  }

  return word;
}

// CLIP's pre-tokenization regex: special tokens first, then contractions,
// then runs of letters, single digits, or runs of "other" (punctuation/
// symbol) characters. The `u` flag is required for the `\p{...}` Unicode
// property escapes (repo oxlint convention — see docs/toolchain.md).
const PRETOKENIZE_PATTERN =
  /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+/gu;

function cleanText(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLowerCase();
}

/**
 * Lowercases, collapses whitespace, and splits into CLIP's pre-tokens
 * (special tokens, contractions, letter runs, single digits, punctuation
 * runs). Exported separately from `encode` so the splitting behavior itself
 * is directly unit-testable without needing a vocab/merges fixture.
 */
export function pretokenize(text: string): string[] {
  return cleanText(text).match(PRETOKENIZE_PATTERN) ?? [];
}

export interface ClipTokenizerData {
  /** token string -> id */
  vocab: ReadonlyMap<string, number>;
  merges: ReadonlyArray<readonly [string, string]>;
}

export interface ClipTokenizer {
  /** Encodes text to a fixed-length id sequence: [startoftext, ...bpe ids (truncated), endoftext, ...zero padding]. */
  encode: (text: string, contextLength?: number) => number[];
}

const DEFAULT_CONTEXT_LENGTH = 77;

export function createClipTokenizer(data: ClipTokenizerData): ClipTokenizer {
  const byteEncoder = bytesToUnicode();
  const ranks = buildBpeRanks(data.merges);
  const bpeCache = new Map<string, string[]>();
  const maybeStartId = data.vocab.get(START_OF_TEXT);
  const maybeEndId = data.vocab.get(END_OF_TEXT);
  if (maybeStartId === undefined || maybeEndId === undefined) {
    throw new Error(
      "createClipTokenizer: vocab is missing <|startoftext|> or <|endoftext|>"
    );
  }
  // Re-bound to new consts: TS's control-flow narrowing above doesn't carry
  // into the `encode` closure defined below (it's a nested function, called
  // at some later, unknowable time), so without this rebinding `encode`
  // would see `startId`/`endId` widened back to `number | undefined`.
  const startId: number = maybeStartId;
  const endId: number = maybeEndId;

  function byteEncodeToken(token: string): string {
    const utf8Bytes = new TextEncoder().encode(token);
    let out = "";
    for (const byte of utf8Bytes) {
      out += byteEncoder.get(byte) ?? "";
    }
    return out;
  }

  function bpeSymbols(byteEncoded: string): string[] {
    const cached = bpeCache.get(byteEncoded);
    if (cached) {
      return cached;
    }
    const symbols = bpeMerge(byteEncoded, ranks);
    bpeCache.set(byteEncoded, symbols);
    return symbols;
  }

  function encode(
    text: string,
    contextLength = DEFAULT_CONTEXT_LENGTH
  ): number[] {
    const matches = pretokenize(text);

    const ids: number[] = [];
    for (const match of matches) {
      const byteEncoded = byteEncodeToken(match);
      for (const symbol of bpeSymbols(byteEncoded)) {
        const id = data.vocab.get(symbol);
        if (id !== undefined) {
          ids.push(id);
        }
      }
    }

    const maxContentTokens = contextLength - 2;
    const truncated = ids.slice(0, Math.max(0, maxContentTokens));
    const withSpecials = [startId, ...truncated, endId];
    while (withSpecials.length < contextLength) {
      withSpecials.push(0);
    }
    return withSpecials;
  }

  return { encode };
}
