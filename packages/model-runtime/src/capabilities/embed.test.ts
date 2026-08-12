import { describe, expect, it } from "vitest";

import { l2Normalize, parseMergesFile } from "./embed.js";

describe(parseMergesFile, () => {
  it("skips the version comment header and parses one pair per line", () => {
    const contents = "#version: 0.2\nl o\nlo w\n";
    expect(parseMergesFile(contents)).toStrictEqual([
      ["l", "o"],
      ["lo", "w"],
    ]);
  });

  it("ignores blank lines", () => {
    const contents = "#version: 0.2\nl o\n\nlo w\n";
    expect(parseMergesFile(contents)).toStrictEqual([
      ["l", "o"],
      ["lo", "w"],
    ]);
  });

  it("returns an empty array for a file with only a header", () => {
    expect(parseMergesFile("#version: 0.2\n")).toStrictEqual([]);
  });
});

describe(l2Normalize, () => {
  it("scales a vector to unit length", () => {
    const result = l2Normalize(new Float32Array([3, 4]));
    expect(result[0]).toBeCloseTo(0.6, 5);
    expect(result[1]).toBeCloseTo(0.8, 5);
    const norm = Math.hypot(result[0] ?? 0, result[1] ?? 0);
    expect(norm).toBeCloseTo(1, 5);
  });

  it("returns the zero vector unchanged rather than dividing by zero", () => {
    expect(l2Normalize(new Float32Array([0, 0, 0]))).toStrictEqual([0, 0, 0]);
  });
});
