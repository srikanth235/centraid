// CLIP BPE tokenizer matching OpenAI `simple_tokenizer.py` (MIT,
// https://github.com/openai/CLIP — same source as the ViT-B/32 weights;
// LICENSES.md). From the published algorithm, not a vendored port.
// Generic over vocab/merges so tests use a hand-computable synthetic
// vocabulary rather than asserting unverified CLIP token ids.

const START_OF_TEXT = "<|startoftext|>";
const END_OF_TEXT = "<|endoftext|>";

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

export function getPairs(word: readonly string[]): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < word.length - 1; i++) {
    pairs.add(`${word[i]} ${word[i + 1]}`);
  }
  return pairs;
}

export function buildBpeRanks(
  merges: ReadonlyArray<readonly [string, string]>
): Map<string, number> {
  const ranks = new Map<string, number>();
  merges.forEach(([a, b], index) => {
    ranks.set(`${a} ${b}`, index);
  });
  return ranks;
}

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

// CLIP pre-tokenize: specials, contractions, letter runs, single digits, other.
// `u` is required for `\p{...}` (docs/toolchain.md).
const PRETOKENIZE_PATTERN =
  /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+/gu;

function cleanText(text: string): string {
  return text.trim().replace(/\s+/gu, " ").toLowerCase();
}

export function pretokenize(text: string): string[] {
  return cleanText(text).match(PRETOKENIZE_PATTERN) ?? [];
}

export interface ClipTokenizerData {
  vocab: ReadonlyMap<string, number>;
  merges: ReadonlyArray<readonly [string, string]>;
}

export interface ClipTokenizer {
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
  // Re-bind: control-flow narrowing does not carry into the nested `encode` closure.
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
