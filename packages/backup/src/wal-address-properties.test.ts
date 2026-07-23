import { describe, expect, test } from 'vitest';
import { fc } from '@centraid/test-kit/fast-check';
import {
  isWalGeneration,
  parseWalCloserKey,
  parseWalPairMarkerKey,
  parseWalSegmentKey,
  walGroupCloserKey,
  walPairMarkerKey,
  walSegmentKey,
  type WalDbName,
  type WalGroupCloser,
  type WalSegmentAddress,
} from './wal-format.js';

const hex32: fc.Arbitrary<string> = fc
  .uint8Array({ minLength: 16, maxLength: 16 })
  .map((b) => Buffer.from(b).toString('hex'));

const dbName: fc.Arbitrary<WalDbName> = fc.constantFrom('vault', 'journal');

const segmentAddr: fc.Arbitrary<WalSegmentAddress> = fc
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

const closerAddr: fc.Arbitrary<WalGroupCloser> = fc.record({
  db: dbName,
  generation: hex32,
  group: fc.integer({ min: 0, max: 999 }),
  endOffset: fc.integer({ min: 1, max: 1_000_000 }),
});

/**
 * WAL addressing properties (#532 core expansion).
 *
 * Model: segment / closer / pair-marker keys are injective encodings of their
 * address fields — parse(encode(x)) === x for every valid address.
 */
describe('WAL address property', () => {
  test('segment key round-trips for every valid address', () => {
    fc.assert(
      fc.property(segmentAddr, (addr) => {
        const key = walSegmentKey(addr);
        expect(parseWalSegmentKey(key)).toEqual(addr);
      }),
      { numRuns: 48, seed: 53250 },
    );
  });

  test('closer key round-trips for every valid closer', () => {
    fc.assert(
      fc.property(closerAddr, (closer) => {
        const key = walGroupCloserKey(closer);
        expect(parseWalCloserKey(key)).toEqual(closer);
      }),
      { numRuns: 40, seed: 53251 },
    );
  });

  test('pair marker key round-trips', () => {
    fc.assert(
      fc.property(
        hex32,
        hex32,
        fc.integer({ min: 0, max: 9_999_999_999_999 }),
        (vaultGeneration, journalGeneration, tickMs) => {
          const key = walPairMarkerKey({ vaultGeneration, journalGeneration, tickMs });
          expect(parseWalPairMarkerKey(key)).toEqual({
            vaultGeneration,
            journalGeneration,
            tickMs,
          });
        },
      ),
      { numRuns: 32, seed: 53252 },
    );
  });

  test('segment and closer parsers never cross-accept', () => {
    fc.assert(
      fc.property(segmentAddr, closerAddr, (seg, closer) => {
        const segKey = walSegmentKey(seg);
        const closerKey = walGroupCloserKey(closer);
        expect(parseWalCloserKey(segKey)).toBeNull();
        expect(parseWalSegmentKey(closerKey)).toBeNull();
        expect(parseWalPairMarkerKey(segKey)).toBeNull();
      }),
      { numRuns: 24, seed: 53253 },
    );
  });

  test('distinct segment addresses never share a key', () => {
    fc.assert(
      fc.property(segmentAddr, segmentAddr, (a, b) => {
        fc.pre(JSON.stringify(a) !== JSON.stringify(b));
        expect(walSegmentKey(a)).not.toBe(walSegmentKey(b));
      }),
      { numRuns: 32, seed: 53254 },
    );
  });

  test('isWalGeneration accepts only 32 lowercase hex chars', () => {
    fc.assert(
      fc.property(hex32, (g) => {
        expect(isWalGeneration(g)).toBe(true);
      }),
      { numRuns: 16, seed: 53255 },
    );
    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 40 }).filter((s) => !/^[0-9a-f]{32}$/.test(s)),
        (g) => {
          expect(isWalGeneration(g)).toBe(false);
        },
      ),
      { numRuns: 24, seed: 53256 },
    );
  });

  test('garbage keys parse to null', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 80 }), (s) => {
        fc.pre(!s.startsWith('wal/'));
        expect(parseWalSegmentKey(s)).toBeNull();
        expect(parseWalCloserKey(s)).toBeNull();
        expect(parseWalPairMarkerKey(s)).toBeNull();
      }),
      { numRuns: 32, seed: 53257 },
    );
  });
});
