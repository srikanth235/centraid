import { fc } from "@centraid/test-kit/fast-check";

import type {
  WalDbName,
  WalGroupCloser,
  WalSegmentAddress,
} from "./wal-format.js";

/**
 * Shared address domain for the WAL addressing suites.
 *
 * Shared by the addressing-law and prefix/minting-law suites so neither
 * re-derives the domain (#656).
 */

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

// ───────────────────────────────────────────────────────────────────────────
// Mutation-kill campaign (#656 Layer 1C).
//
// The laws below are the ones the addressing surface actually owes its
// callers. They are stated as total properties over the address domain rather
// than as assertions about how any particular clause is written:
//
//   L1 (encoder totality)  An encoder either REFUSES an address or emits a key
//                          that parses back to exactly that address. It never
//                          emits a key that means something else — a restore
//                          reading a provider LIST has nothing but the key.
//   L2 (prefix soundness)  A list prefix matches every key of its stream and
//                          no key outside it. A prefix that over-matches makes
//                          GC delete a live stream; one that under-matches
//                          makes restore read a truncated stream as "idle".
//   L3 (diagnosability)    A refusal names the field it refused, because the
//                          operator seeing it is holding a corrupt listing.
// ───────────────────────────────────────────────────────────────────────────

/** Values outside the non-negative-integer domain every offset/group/tick lives in. */
export const notNonNegativeInt: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 1, max: 1_000_000 }).map((n) => -n),
  fc.integer({ min: 0, max: 1_000_000 }).map((n) => n + 0.5),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY)
);

/** Strings that are not a 32-lowercase-hex WAL generation. */
export const notGeneration: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  hex32.map((g) => g.slice(1)),
  hex32.map((g) => `${g}0`),
  hex32.map((g) => `${g.slice(0, 31)}G`),
  fc
    .string({ minLength: 0, maxLength: 40 })
    .filter((s) => !/^[0-9a-f]{32}$/u.test(s))
);

/**
 * A segment address with exactly one field pushed outside its domain — the
 * shape a corrupt caller (or a mutant validator) would hand the encoder.
 */
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
    // A zero-length segment: well-formed characters, but names no bytes.
    return { ...addr, endOffset: addr.startOffset };
  });

/**
 * Run an encoder and report ONLY whether a key came out. Refusing is a legal
 * outcome; emitting a key that means something else is not. Folding the two
 * outcomes into one value lets the law below be asserted unconditionally.
 */
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
