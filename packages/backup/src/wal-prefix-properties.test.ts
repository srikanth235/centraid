import { describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import {
  dbName,
  hex32,
  notGeneration,
  segmentAddr,
} from "./wal-address.test-fixtures.js";
import {
  isWalGeneration,
  newWalGeneration,
  walDbPrefix,
  walGroupCloserKey,
  walSegmentKey,
  walSegmentPrefix,
  walTickMarkerKey,
  walTickMarkerPrefix,
  walTickMarkerRootPrefix,
} from "./wal-format.js";

/**
 * WAL prefix soundness (L2) and generation minting.
 *
 * Kept apart from `wal-address-properties.test.ts` (#656): listing and minting
 * are a separate surface from the key encoders, and one combined file breaches
 * the file-size cap.
 */
describe("WAL list prefixes (L2)", () => {
  test("a segment prefix matches every key of its stream and no other", () => {
    fc.assert(
      fc.property(segmentAddr, segmentAddr, (a, b) => {
        const key = walSegmentKey(a);
        // Completeness: the stream prefix and the group prefix both cover it.
        expect(key.startsWith(walSegmentPrefix(a.db, a.generation))).toBe(true);
        expect(
          key.startsWith(walSegmentPrefix(a.db, a.generation, a.group))
        ).toBe(true);
        // Soundness: a prefix covers the key if and only if it is the same
        // stream — no other listing may sweep it up.
        const sameStream = a.generation === b.generation;
        expect(key.startsWith(walSegmentPrefix(b.db, b.generation))).toBe(
          sameStream
        );
        expect(
          key.startsWith(walSegmentPrefix(b.db, b.generation, b.group))
        ).toBe(sameStream && a.group === b.group);
      }),
      { numRuns: 64, seed: 53264 }
    );
  });

  test("a group prefix is strictly narrower than its generation prefix", () => {
    fc.assert(
      fc.property(
        dbName,
        hex32,
        fc.integer({ min: 0, max: 999 }),
        (db, g, n) => {
          const stream = walSegmentPrefix(db, g);
          const group = walSegmentPrefix(db, g, n);
          expect(group.startsWith(stream)).toBe(true);
          expect(group).not.toBe(stream);
        }
      ),
      { numRuns: 32, seed: 53265 }
    );
  });

  test("the db prefix covers every stream key and no tick marker", () => {
    fc.assert(
      fc.property(segmentAddr, hex32, (addr, generation) => {
        const key = walSegmentKey(addr);
        expect(key.startsWith(walDbPrefix(addr.db))).toBe(true);
        expect(
          walSegmentPrefix(addr.db, addr.generation).startsWith(
            walDbPrefix(addr.db)
          )
        ).toBe(true);
        // GC sweeps segments by this prefix — markers live outside it, or a
        // generation sweep would take the proof of its own tip with it.
        expect(
          walTickMarkerKey({ generation, tickMs: 1 }).startsWith(
            walDbPrefix(addr.db)
          )
        ).toBe(false);
      }),
      { numRuns: 40, seed: 53266 }
    );
  });

  test("prefixes refuse a generation that is not a generation", () => {
    // A prefix built from a non-generation matches nothing, and a LIST that
    // returns nothing is indistinguishable from an idle stream — the exact
    // ambiguity the tick marker exists to remove. So it must fail loudly.
    fc.assert(
      fc.property(dbName, notGeneration, (db, bad) => {
        expect(() => walSegmentPrefix(db, bad)).toThrow(/wal generation/u);
        expect(() => walSegmentPrefix(db, bad, 0)).toThrow(/wal generation/u);
        expect(() => walTickMarkerPrefix(bad)).toThrow(/wal generation/u);
      }),
      { numRuns: 40, seed: 53267 }
    );
  });

  test("the tick-marker root prefix covers markers and only markers", () => {
    fc.assert(
      fc.property(hex32, segmentAddr, (generation, seg) => {
        const markerKey = walTickMarkerKey({ generation, tickMs: 1 });
        const root = walTickMarkerRootPrefix();
        expect(markerKey.startsWith(root)).toBe(true);
        expect(walTickMarkerPrefix(generation).startsWith(root)).toBe(true);
        // GC discovers markers by this prefix — it must never sweep segments.
        expect(walSegmentKey(seg).startsWith(root)).toBe(false);
        expect(
          walGroupCloserKey({
            db: seg.db,
            generation: seg.generation,
            group: seg.group,
            endOffset: seg.endOffset,
          }).startsWith(root)
        ).toBe(false);
      }),
      { numRuns: 40, seed: 53268 }
    );
  });

  test("a marker prefix is specific to its generation", () => {
    fc.assert(
      fc.property(hex32, hex32, (a, b) => {
        fc.pre(a !== b);
        const key = walTickMarkerKey({ generation: a, tickMs: 2 });
        expect(key.startsWith(walTickMarkerPrefix(a))).toBe(true);
        // A restore believes marker positions ABSOLUTELY, so a prefix that
        // swept another generation's markers would apply its offsets to a
        // different stream.
        expect(key.startsWith(walTickMarkerPrefix(b))).toBe(false);
      }),
      { numRuns: 32, seed: 53269 }
    );
  });
});

describe("WAL generation minting", () => {
  test("a minted generation is exactly the 128 bits drawn, hex-encoded", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        (entropy) => {
          const asked: number[] = [];
          const generation = newWalGeneration((n) => {
            asked.push(n);
            return new Uint8Array(entropy).subarray(0, n);
          });
          // The collision argument in the module header rests on the id
          // carrying the FULL 128 bits it drew — no truncation, no re-encoding.
          expect(asked).toStrictEqual([16]);
          expect(generation).toBe(Buffer.from(entropy).toString("hex"));
          expect(isWalGeneration(generation)).toBe(true);
        }
      ),
      { numRuns: 32, seed: 53270 }
    );
  });

  test("distinct entropy mints distinct generations", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        fc.uint8Array({ minLength: 16, maxLength: 16 }),
        (a, b) => {
          fc.pre(Buffer.compare(Buffer.from(a), Buffer.from(b)) !== 0);
          const mint = (bytes: Uint8Array) =>
            newWalGeneration(() => new Uint8Array(bytes));
          expect(mint(a)).not.toBe(mint(b));
        }
      ),
      { numRuns: 24, seed: 53271 }
    );
  });

  test("a minted generation is accepted by every addressing entry point", () => {
    const generation = newWalGeneration((n) =>
      Uint8Array.from({ length: n }, (_, i) => (i * 17) % 256)
    );
    expect(isWalGeneration(generation)).toBe(true);
    expect(() => walSegmentPrefix("vault", generation)).not.toThrow();
    expect(() =>
      walSegmentKey({
        db: "vault",
        generation,
        group: 0,
        startOffset: 0,
        endOffset: 1,
        tickMs: 0,
      })
    ).not.toThrow();
  });
});
