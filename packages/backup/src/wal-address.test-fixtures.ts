import { fc } from "@centraid/test-kit/fast-check";

import type {
  WalDbName,
  WalGroupCloser,
  WalSegmentAddress,
} from "./wal-format.js";

/** WAL address domain (#656). */

export const hex32: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 16, maxLength: 16 })
  .map((b) => Buffer.from(b).toString("hex"));

export const dbName: fc.Arbitrary<WalDbName> = fc.constantFrom(
  "vault",
  "journal"
);

export const segmentAddr: fc.Arbitrary<WalSegmentAddress> = fc
  .record({
    db: dbName,
    generation: hex32,
    group: fc.integer({ min: 0, max: 999 }),
    startOffset: fc.integer({ min: 0, max: 1_000_000 }),
    length: fc.integer({ min: 1, max: 1_000_000 }),
    tickMs: fc.integer({ min: 0, max: 9_999_999_999_999 }),
  })
  .map(({ db, generation, group, startOffset, length, tickMs }) => ({
    db,
    generation,
    group,
    startOffset,
    endOffset: startOffset + length,
    tickMs,
  }));

export const closerAddr: fc.Arbitrary<WalGroupCloser> = fc.record({
  db: dbName,
  generation: hex32,
  group: fc.integer({ min: 0, max: 999 }),
  endOffset: fc.integer({ min: 1, max: 1_000_000 }),
});

// Mutation-kill laws (#656 Layer 1C): L1 key parses back;
// L2 prefix soundness (over-match GC-deletes live streams);
// L3 refusal names the field it refused.

/** Outside the non-negative-int domain. */
export const notNonNegativeInt: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: 1_000_000 }).map((n) => -n),
  fc.integer({ min: 0, max: 1_000_000 }).map((n) => n + 0.5),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY)
);

/** Not a 32-lowercase-hex generation. */
export const notGeneration: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  hex32.map((g) => g.slice(1)),
  hex32.map((g) => `${g}0`),
  hex32.map((g) => `${g.slice(0, 31)}G`),
  fc
    .string({ minLength: 0, maxLength: 40 })
    .filter((s) => !/^[0-9a-f]{32}$/u.test(s))
);

/** One field bad — mutant-validator shape. */
export const corruptSegmentAddr: fc.Arbitrary<WalSegmentAddress> = fc
  .tuple(
    segmentAddr,
    fc.constantFrom(
      "generation",
      "group",
      "startOffset",
      "endOffset",
      "emptyRange"
    ),
    notGeneration,
    notNonNegativeInt,
    notNonNegativeInt,
    notNonNegativeInt
  )
  .map(([addr, field, badGen, badGroup, badStart, badEnd]) => {
    if (field === "generation") return { ...addr, generation: badGen };
    if (field === "group") return { ...addr, group: badGroup };
    if (field === "startOffset") return { ...addr, startOffset: badStart };
    if (field === "endOffset") return { ...addr, endOffset: badEnd };
    // Zero-length: names no bytes.
    return { ...addr, endOffset: addr.startOffset };
  });

/** Key emitted, or null on refusal. */
export function emitted<T>(
  encode: (value: T) => string,
  value: T
): string | null {
  try {
    return encode(value);
  } catch {
    return null;
  }
}
