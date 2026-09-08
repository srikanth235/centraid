import { describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import {
  closerAddr,
  corruptSegmentAddr,
  dbName,
  emitted,
  hex32,
  notGeneration,
  notNonNegativeInt,
  segmentAddr,
} from "./wal-address.test-fixtures.js";
import {
  isWalGeneration,
  parseWalCloserKey,
  parseWalSegmentKey,
  parseWalTickMarkerKey,
  walGroupCloserKey,
  walSegmentKey,
  walTickMarkerKey,
} from "./wal-format.js";
import type { WalGroupCloser, WalSegmentAddress } from "./wal-format.js";

/**
 * WAL addressing properties (#532 core expansion).
 *
 * Model: segment / closer / tick-marker keys are injective encodings of their
 * address fields — parse(encode(x)) === x for every valid address.
 */
describe("WAL address property", () => {
  test("segment key round-trips for every valid address", () => {
    fc.assert(
      fc.property(segmentAddr, (addr) => {
        const key = walSegmentKey(addr);
        expect(parseWalSegmentKey(key)).toStrictEqual(addr);
      }),
      { numRuns: 48, seed: 53250 }
    );
  });

  test("closer key round-trips for every valid closer", () => {
    fc.assert(
      fc.property(closerAddr, (closer) => {
        const key = walGroupCloserKey(closer);
        // fast-check's shrinker can hand back a counterexample built with a
        // null prototype; spreading both sides compares the address fields
        // (the contract) without asserting either object's prototype.
        expect({ ...parseWalCloserKey(key) }).toStrictEqual({ ...closer });
      }),
      { numRuns: 40, seed: 53251 }
    );
  });

  test("tick marker key round-trips", () => {
    fc.assert(
      fc.property(
        hex32,
        fc.integer({ min: 0, max: 9_999_999_999_999 }),
        (generation, tickMs) => {
          const key = walTickMarkerKey({ generation, tickMs });
          expect(parseWalTickMarkerKey(key)).toStrictEqual({
            generation,
            tickMs,
          });
        }
      ),
      { numRuns: 32, seed: 53252 }
    );
  });

  test("segment and closer parsers never cross-accept", () => {
    fc.assert(
      fc.property(segmentAddr, closerAddr, (seg, closer) => {
        const segKey = walSegmentKey(seg);
        const closerKey = walGroupCloserKey(closer);
        expect(parseWalCloserKey(segKey)).toBeNull();
        expect(parseWalSegmentKey(closerKey)).toBeNull();
        expect(parseWalTickMarkerKey(segKey)).toBeNull();
      }),
      { numRuns: 24, seed: 53253 }
    );
  });

  test("distinct segment addresses never share a key", () => {
    fc.assert(
      fc.property(segmentAddr, segmentAddr, (a, b) => {
        fc.pre(JSON.stringify(a) !== JSON.stringify(b));
        expect(walSegmentKey(a)).not.toBe(walSegmentKey(b));
      }),
      { numRuns: 32, seed: 53254 }
    );
  });

  test("isWalGeneration accepts only 32 lowercase hex chars", () => {
    fc.assert(
      fc.property(hex32, (g) => {
        expect(isWalGeneration(g)).toBe(true);
      }),
      { numRuns: 16, seed: 53255 }
    );
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 0, maxLength: 40 })
          .filter((s) => !/^[0-9a-f]{32}$/u.test(s)),
        (g) => {
          expect(isWalGeneration(g)).toBe(false);
        }
      ),
      { numRuns: 24, seed: 53256 }
    );
  });

  test("garbage keys parse to null", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 80 }), (s) => {
        fc.pre(!s.startsWith("wal/"));
        expect(parseWalSegmentKey(s)).toBeNull();
        expect(parseWalCloserKey(s)).toBeNull();
        expect(parseWalTickMarkerKey(s)).toBeNull();
      }),
      { numRuns: 32, seed: 53257 }
    );
  });
});

describe("WAL encoder totality (L1)", () => {
  test("a segment key that is emitted always parses back to the same address", () => {
    fc.assert(
      fc.property(fc.oneof(segmentAddr, corruptSegmentAddr), (addr) => {
        const key = emitted(walSegmentKey, addr);
        // Refused ⇒ nothing was published. Emitted ⇒ it names exactly `addr`.
        expect(key === null ? addr : parseWalSegmentKey(key)).toStrictEqual(
          addr
        );
      }),
      { numRuns: 200, seed: 53260 }
    );
  });

  test("a closer key that is emitted always parses back to the same closer", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          closerAddr,
          fc.constantFrom("none", "generation", "group", "endOffset"),
          notGeneration,
          notNonNegativeInt,
          notNonNegativeInt
        ),
        ([closer, field, badGen, badGroup, badEnd]) => {
          const subject: WalGroupCloser =
            field === "generation"
              ? { ...closer, generation: badGen }
              : field === "group"
                ? { ...closer, group: badGroup }
                : field === "endOffset"
                  ? { ...closer, endOffset: badEnd }
                  : closer;
          const key = emitted(walGroupCloserKey, subject);
          expect(
            key === null ? { ...subject } : { ...parseWalCloserKey(key) }
          ).toStrictEqual({ ...subject });
        }
      ),
      { numRuns: 120, seed: 53261 }
    );
  });

  test("a tick-marker key that is emitted always parses back to the same address", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          hex32,
          fc.integer({ min: 0, max: 9_999_999_999_999 }),
          fc.constantFrom("none", "generation", "tick"),
          notGeneration,
          notNonNegativeInt
        ),
        ([generation, tickMs, field, badGen, badTick]) => {
          const subject = {
            generation: field === "generation" ? badGen : generation,
            tickMs: field === "tick" ? badTick : tickMs,
          };
          const key = emitted(walTickMarkerKey, subject);
          expect(
            key === null ? subject : parseWalTickMarkerKey(key)
          ).toStrictEqual(subject);
        }
      ),
      { numRuns: 120, seed: 53262 }
    );
  });

  test("parsers refuse a well-formed key that names an empty byte range", () => {
    // The encoder can never produce this, but a provider can serve it. A
    // zero-or-negative-length segment names no bytes, so replay must treat it
    // as "not a segment" rather than as a zero-byte hole in the stream.
    fc.assert(
      fc.property(
        dbName,
        hex32,
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1000 }),
        (db, generation, group, offset, back) => {
          const pad = (n: number, w: number) => String(n).padStart(w, "0");
          const keyFor = (end: number) =>
            `wal/${db}/${generation}/${pad(group, 8)}/` +
            `${pad(offset, 12)}-${pad(end, 12)}-${pad(0, 13)}`;
          // end === start: zero bytes. Not "an empty segment" — not a segment.
          expect(parseWalSegmentKey(keyFor(offset))).toBeNull();
          // end < start: a negative-length range, always nonsense.
          expect(
            parseWalSegmentKey(keyFor(Math.max(0, offset - back - 1)))
          ).toBeNull();
          // end > start by one byte: the smallest real segment there is.
          expect(parseWalSegmentKey(keyFor(offset + 1))).not.toBeNull();
        }
      ),
      { numRuns: 40, seed: 53263 }
    );
  });
});

describe("WAL address domain boundaries", () => {
  // The zero end of each domain is legal and must round-trip: group 0 is the
  // first group of every generation, startOffset 0 is the first byte of every
  // group, and tick 0 is a legal (if unlikely) epoch. An encoder that refused
  // them would make the very first segment of a fresh stream unaddressable.
  const generation = "0".repeat(32);

  test("group 0, startOffset 0 and tickMs 0 are addressable", () => {
    const addr: WalSegmentAddress = {
      db: "vault",
      generation,
      group: 0,
      startOffset: 0,
      endOffset: 1,
      tickMs: 0,
    };
    expect(parseWalSegmentKey(walSegmentKey(addr))).toStrictEqual(addr);
  });

  test("a closer at group 0 is addressable but one at offset 0 is refused", () => {
    const closer: WalGroupCloser = {
      db: "vault",
      generation,
      group: 0,
      endOffset: 1,
    };
    expect({ ...parseWalCloserKey(walGroupCloserKey(closer)) }).toStrictEqual({
      ...closer,
    });
    // A closer says "this group is durably captured up to N bytes". N = 0 is
    // not a closed group, it is an untouched one — the two must not share a key.
    expect(() => walGroupCloserKey({ ...closer, endOffset: 0 })).toThrow(
      /closer end/u
    );
  });

  test("a tick marker at tick 0 is addressable", () => {
    const marker = { generation, tickMs: 0 };
    expect(parseWalTickMarkerKey(walTickMarkerKey(marker))).toStrictEqual(
      marker
    );
  });
});

describe("WAL refusals name the field they refused (L3)", () => {
  const generation = "a".repeat(32);
  const base: WalSegmentAddress = {
    db: "vault",
    generation,
    group: 3,
    startOffset: 10,
    endOffset: 20,
    tickMs: 7,
  };

  test("segment refusals identify generation, group, range and tick", () => {
    expect(() => walSegmentKey({ ...base, generation: "nope" })).toThrow(
      /wal generation/u
    );
    expect(() => walSegmentKey({ ...base, group: -1 })).toThrow(/wal group/u);
    expect(() => walSegmentKey({ ...base, group: 1.5 })).toThrow(/wal group/u);
    expect(() => walSegmentKey({ ...base, startOffset: -1 })).toThrow(
      /segment range/u
    );
    expect(() => walSegmentKey({ ...base, startOffset: 0.5 })).toThrow(
      /segment range/u
    );
    expect(() => walSegmentKey({ ...base, endOffset: 10 })).toThrow(
      /segment range/u
    );
    expect(() => walSegmentKey({ ...base, endOffset: 20.5 })).toThrow(
      /segment range/u
    );
    expect(() => walSegmentKey({ ...base, tickMs: -1 })).toThrow(
      /segment tick/u
    );
    expect(() => walSegmentKey({ ...base, tickMs: 1.5 })).toThrow(
      /segment tick/u
    );
  });

  test("closer refusals identify generation, group and end", () => {
    const closer: WalGroupCloser = {
      db: "vault",
      generation,
      group: 3,
      endOffset: 20,
    };
    expect(() => walGroupCloserKey({ ...closer, generation: "x" })).toThrow(
      /wal generation/u
    );
    expect(() => walGroupCloserKey({ ...closer, group: -1 })).toThrow(
      /wal group/u
    );
    expect(() => walGroupCloserKey({ ...closer, group: 1.5 })).toThrow(
      /wal group/u
    );
    expect(() => walGroupCloserKey({ ...closer, endOffset: -1 })).toThrow(
      /closer end/u
    );
    expect(() => walGroupCloserKey({ ...closer, endOffset: 1.5 })).toThrow(
      /closer end/u
    );
  });

  test("tick-marker refusals identify the generation and the tick", () => {
    const marker = { generation, tickMs: 5 };
    // A marker naming a generation that cannot exist would be listed under a
    // base no restore can ever match.
    expect(() => walTickMarkerKey({ ...marker, generation: "x" })).toThrow(
      /generation/u
    );
    expect(() => walTickMarkerKey({ ...marker, tickMs: -1 })).toThrow(
      /marker tick/u
    );
    expect(() => walTickMarkerKey({ ...marker, tickMs: 1.5 })).toThrow(
      /marker tick/u
    );
  });
});
