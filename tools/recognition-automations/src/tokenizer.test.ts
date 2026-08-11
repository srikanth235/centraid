import { describe, expect, it } from "vitest";

import {
  bpeMerge,
  buildBpeRanks,
  bytesToUnicode,
  createClipTokenizer,
  getPairs,
  pretokenize,
} from "./tokenizer.js";

describe(bytesToUnicode, () => {
  it("maps all 256 byte values to distinct codepoints", () => {
    const map = bytesToUnicode();
    expect(map.size).toBe(256);
    expect(new Set(map.values()).size).toBe(256);
  });

  it("identity-maps printable ASCII (GPT-2/CLIP's own byte encoder does this too)", () => {
    const map = bytesToUnicode();
    for (const char of ["l", "o", "w", "e", "r", "A", "9", "!"]) {
      const byte = char.codePointAt(0) as number;
      expect(map.get(byte)).toBe(char);
    }
  });
});

describe(getPairs, () => {
  it("returns every adjacent symbol pair", () => {
    expect(getPairs(["l", "o", "w"])).toStrictEqual(new Set(["l o", "o w"]));
  });

  it("returns an empty set for a single-symbol word", () => {
    expect(getPairs(["low"])).toStrictEqual(new Set());
  });
});

describe(bpeMerge, () => {
  // Classic worked BPE example (word "lower", merges learned in this
  // priority order): trace by hand below to keep the fixture self-verifying
  // rather than asserting against the real CLIP vocab from memory.
  //   start:            l  o  w  e  r</w>
  //   merge "l o"  (r0): lo  w  e  r</w>
  //   merge "lo w" (r1): low  e  r</w>
  //   merge "e r</w>" (r2): low  er</w>
  //   no remaining ranked pair ("low er</w>") -> stop
  const ranks = buildBpeRanks([
    ["l", "o"],
    ["lo", "w"],
    ["e", "r</w>"],
  ]);

  it("merges the lowest-rank pair first, repeatedly, until no ranked pair remains", () => {
    expect(bpeMerge("lower", ranks)).toStrictEqual(["low", "er</w>"]);
  });

  it("appends the end-of-word marker to a single-character token", () => {
    expect(bpeMerge("a", ranks)).toStrictEqual(["a</w>"]);
  });

  it("leaves a word with no matching merges split into individual end-marked symbols", () => {
    expect(bpeMerge("xyz", ranks)).toStrictEqual(["x", "y", "z</w>"]);
  });

  it("returns an empty array for an empty token", () => {
    expect(bpeMerge("", ranks)).toStrictEqual([]);
  });
});

describe(pretokenize, () => {
  it("splits a contraction into the letter run and the contraction suffix", () => {
    expect(pretokenize("don't")).toStrictEqual(["don", "'t"]);
  });

  it("lowercases and collapses whitespace before splitting", () => {
    expect(pretokenize("A   Photo")).toStrictEqual(["a", "photo"]);
  });

  it("splits digits from adjacent letters, one digit per token", () => {
    expect(pretokenize("v2 model")).toStrictEqual(["v", "2", "model"]);
  });

  it("groups punctuation runs together, separate from letters", () => {
    expect(pretokenize("hello!!")).toStrictEqual(["hello", "!!"]);
  });

  it("recognizes the CLIP special tokens verbatim", () => {
    expect(pretokenize("<|startoftext|>hi<|endoftext|>")).toStrictEqual([
      "<|startoftext|>",
      "hi",
      "<|endoftext|>",
    ]);
  });
});

describe(createClipTokenizer, () => {
  // Small, fully hand-verified vocab/merges fixture — NOT the real 49408-
  // token CLIP vocabulary. Only the final BPE symbols need vocab entries;
  // intermediate merge steps are looked up by rank, not by vocab id.
  const vocab = new Map<string, number>([
    ["<|startoftext|>", 100],
    ["<|endoftext|>", 101],
    ["low", 7],
    ["er</w>", 8],
    ["a</w>", 9],
  ]);
  const merges: Array<[string, string]> = [
    ["l", "o"],
    ["lo", "w"],
    ["e", "r</w>"],
  ];

  it("wraps encoded text with start/end tokens and pads to contextLength", () => {
    const tokenizer = createClipTokenizer({ vocab, merges });
    expect(tokenizer.encode("lower", 8)).toStrictEqual([
      100, 7, 8, 101, 0, 0, 0, 0,
    ]);
  });

  it("encodes a single-letter word via its own single-char fixture entry", () => {
    const tokenizer = createClipTokenizer({ vocab, merges });
    expect(tokenizer.encode("a", 6)).toStrictEqual([100, 9, 101, 0, 0, 0]);
  });

  it("truncates content tokens (never the start/end tokens) to fit contextLength", () => {
    const tokenizer = createClipTokenizer({ vocab, merges });
    const ids = tokenizer.encode("lower", 3);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBe(100);
    expect(ids.at(-1)).toBe(101);
  });

  it("throws when the vocab is missing a required special token", () => {
    const brokenVocab = new Map<string, number>([["<|startoftext|>", 100]]);
    expect(() => createClipTokenizer({ vocab: brokenVocab, merges })).toThrow(
      /startoftext|endoftext/u
    );
  });
});
