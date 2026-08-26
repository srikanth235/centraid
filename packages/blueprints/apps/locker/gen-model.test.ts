// THE GENERATOR'S PROMISES (README-Locker §5; GAPS §3.3 #12).
//
// Three of them are testable as properties rather than as examples, which is
// the only way to test a generator at all: LOOK-ALIKES ARE NEVER PRESENT, the
// length is the one that was asked for, and a mode change actually changes the
// output's shape. Everything below runs the real `crypto.getRandomValues` —
// there is no seeded-random mode in this app, because a generator with one is
// a generator somebody will ship with it on.

import { describe, expect, it } from "vitest";

import {
  GEN_LENGTHS,
  PIN_MAX,
  defaultGenOptions,
  generate,
  lengthMeaning,
  readsInclude,
} from "./gen-model.ts";

/** The characters this product refuses to put in a secret, in every mode. */
const LOOK_ALIKES = /[IOl01]/u;

const DRAWS = 40;

describe("look-alikes are excluded always", () => {
  it("never draws one in the character mode, at any length", () => {
    for (const length of GEN_LENGTHS) {
      for (let draw = 0; draw < DRAWS; draw += 1) {
        const value = generate({
          kind: "chars",
          length,
          digits: true,
          symbols: true,
        });
        expect(value).not.toMatch(LOOK_ALIKES);
      }
    }
  });

  it("never draws one in the word mode either", () => {
    for (let draw = 0; draw < DRAWS; draw += 1) {
      expect(
        generate({ kind: "words", length: 20, digits: false, symbols: false })
      ).not.toMatch(/[IO]/u);
    }
  });
});

describe("the length row means what the mode says it means", () => {
  it("gives characters exactly the length that was asked for", () => {
    for (const length of GEN_LENGTHS) {
      expect(
        generate({ kind: "chars", length, digits: true, symbols: true })
      ).toHaveLength(length);
    }
  });

  it("meets the target with whole words, and never fewer than three", () => {
    for (const length of GEN_LENGTHS) {
      const value = generate({
        kind: "words",
        length,
        digits: false,
        symbols: false,
      });
      expect(value.length).toBeGreaterThanOrEqual(length);
      expect(value.split("-").length).toBeGreaterThanOrEqual(3);
      expect(value).toMatch(/^[a-z]+(?:-[a-z]+)+$/u);
    }
  });

  it("caps a PIN, because a PIN longer than a keypad takes is a password", () => {
    for (const length of GEN_LENGTHS) {
      const value = generate({
        kind: "pin",
        length,
        digits: true,
        symbols: true,
      });
      expect(value).toMatch(/^\d+$/u);
      expect(value.length).toBeLessThanOrEqual(PIN_MAX);
      expect(value.length).toBeGreaterThanOrEqual(4);
    }
  });

  it("says how the row is read, per mode, rather than leaving it to be guessed", () => {
    expect(lengthMeaning("pin")).toContain(String(PIN_MAX));
    expect(lengthMeaning("words")).toContain("words");
    expect(lengthMeaning("chars")).toBe("characters");
  });
});

describe("the Include row is drawn only where it changes the output", () => {
  it("reads for characters and for nothing else", () => {
    expect(readsInclude("chars")).toBe(true);
    expect(readsInclude("words")).toBe(false);
    expect(readsInclude("pin")).toBe(false);
  });

  it("honours both toggles", () => {
    const letters = generate({
      kind: "chars",
      length: 40,
      digits: false,
      symbols: false,
    });
    expect(letters).toMatch(/^[A-Za-z]+$/u);
    let sawDigit = false;
    let sawSymbol = false;
    for (let draw = 0; draw < DRAWS; draw += 1) {
      const value = generate({
        kind: "chars",
        length: 40,
        digits: true,
        symbols: true,
      });
      if (/\d/u.test(value)) sawDigit = true;
      if (/[^A-Za-z0-9]/u.test(value)) sawSymbol = true;
    }
    expect(sawDigit).toBe(true);
    expect(sawSymbol).toBe(true);
  });
});

describe("the chip rows are the recipe's", () => {
  it("offers 12 to 40, and nothing under 12", () => {
    expect(GEN_LENGTHS[0]).toBe(12);
    expect(GEN_LENGTHS.at(-1)).toBe(40);
    expect(Math.min(...GEN_LENGTHS)).toBeGreaterThanOrEqual(12);
  });

  it("starts on characters, with both classes in", () => {
    expect(defaultGenOptions()).toStrictEqual({
      kind: "chars",
      length: 20,
      digits: true,
      symbols: true,
    });
  });

  it("draws something different each time, which is the whole point", () => {
    const drawn = new Set<string>();
    for (let draw = 0; draw < DRAWS; draw += 1) {
      drawn.add(generate(defaultGenOptions()));
    }
    expect(drawn.size).toBe(DRAWS);
  });
});
