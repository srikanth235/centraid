import { describe, expect, it } from "vitest";

import { argmax, ctcGreedyDecode } from "./ctc.js";

describe(argmax, () => {
  it("returns the index and value of the largest entry", () => {
    expect(argmax([0.1, 0.7, 0.2])).toStrictEqual({ index: 1, value: 0.7 });
  });

  it("throws on an empty row", () => {
    expect(() => argmax([])).toThrow(/non-empty/u);
  });
});

describe(ctcGreedyDecode, () => {
  const dictionary = ["<blank>", "c", "a", "t"];

  it("collapses consecutive repeats before dropping blanks", () => {
    const probs = [
      [0.1, 0.9, 0, 0],
      [0.1, 0.9, 0, 0],
      [0.1, 0, 0.9, 0],
      [0.1, 0, 0, 0.9],
      [0.1, 0, 0, 0.9],
      [0.1, 0, 0, 0.9],
    ];
    const result = ctcGreedyDecode(probs, dictionary);
    expect(result.text).toBe("cat");
  });

  it("uses blanks to separate two identical adjacent letters", () => {
    const probs = [
      [0, 0.9, 0, 0],
      [0, 0.9, 0, 0],
      [0.9, 0, 0, 0],
      [0, 0.9, 0, 0],
    ];
    const result = ctcGreedyDecode(probs, dictionary);
    expect(result.text).toBe("cc");
  });

  it("computes confidence as the mean probability of exactly the kept characters", () => {
    const probs = [
      [0.1, 0.8, 0, 0], // kept: c @ 0.8
      [0.1, 0, 0.6, 0], // kept: a @ 0.6
      [0.1, 0, 0.6, 0], // repeat of "a" -> collapsed, not kept
      [0.1, 0, 0, 1], // kept: t @ 1.0
    ];
    const result = ctcGreedyDecode(probs, dictionary);
    expect(result.text).toBe("cat");
    expect(result.confidence).toBeCloseTo((0.8 + 0.6 + 1) / 3, 10);
  });

  it("returns empty text and zero confidence when every timestep decodes to blank", () => {
    const probs = [
      [0.9, 0, 0, 0],
      [0.9, 0, 0, 0],
    ];
    const result = ctcGreedyDecode(probs, dictionary);
    expect(result).toStrictEqual({ text: "", confidence: 0 });
  });
});
