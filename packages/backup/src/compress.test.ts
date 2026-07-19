/*
 * Entropy-gated payload framing (FORMAT.md § Chunk payload framing — /2,
 * issue #405 §1). These are the format-level unit tests for the frame itself;
 * the end-to-end "does a real snapshot compress and still restore" coverage
 * lives in engine.test.ts, where framing rides inside the seal.
 */

import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  ALGO_DEFLATE,
  ALGO_STORE,
  ALGO_ZSTD,
  frameChunkPayload,
  frameChunkPayloadAsync,
  unframeChunkPayload,
  zstdAvailable,
} from './compress.js';

/** Highly compressible: a long run of one byte collapses under any codec. */
function compressible(size: number): Uint8Array {
  return new Uint8Array(size).fill(0x5a);
}

describe('frameChunkPayload / unframeChunkPayload', () => {
  test('the async writer preserves the wire format and retry determinism', async () => {
    const raw = new TextEncoder().encode('async-compression'.repeat(10_000));
    const first = await frameChunkPayloadAsync(raw);
    const retry = await frameChunkPayloadAsync(raw);
    expect(first).toEqual(retry);
    expect(first[0]).toBe(frameChunkPayload(raw)[0]);
    expect(unframeChunkPayload(first)).toEqual(raw);
  });

  test('algo id bytes are the format-normative values', () => {
    expect(ALGO_STORE).toBe(0x00);
    expect(ALGO_ZSTD).toBe(0x01);
    expect(ALGO_DEFLATE).toBe(0x02);
  });

  test('this runtime has node:zlib zstd (Node ≥22.15 / Bun ≥1.3 floor)', () => {
    // The writer prefers zstd; the whole suite assumes the documented floor.
    expect(zstdAvailable).toBe(true);
  });

  test('compressible input is compressed (0x01) and round-trips to the exact bytes', () => {
    const raw = compressible(64 * 1024);
    const framed = frameChunkPayload(raw);
    expect(framed[0]).toBe(ALGO_ZSTD);
    // Strictly smaller than the stored frame (raw + 1) — the keep-if-smaller
    // gate kept the compressed body.
    expect(framed.length).toBeLessThan(raw.length + 1);
    expect([...unframeChunkPayload(framed)]).toEqual([...raw]);
  });

  test('incompressible input stores raw (0x00) with at most one byte of overhead', () => {
    const raw = randomBytes(64 * 1024);
    const framed = frameChunkPayload(raw);
    expect(framed[0]).toBe(ALGO_STORE);
    // The whole point of the gate: random bytes never inflate the object by
    // more than the single frame id byte (#405 §1 acceptance).
    expect(framed.length).toBe(raw.length + 1);
    expect([...unframeChunkPayload(framed)]).toEqual([...raw]);
  });

  test('a mixed batch round-trips: compressed and stored frames both recover', () => {
    const comp = compressible(40_000);
    const incomp = randomBytes(40_000);
    const framedComp = frameChunkPayload(comp);
    const framedIncomp = frameChunkPayload(incomp);
    expect(framedComp[0]).toBe(ALGO_ZSTD);
    expect(framedIncomp[0]).toBe(ALGO_STORE);
    expect([...unframeChunkPayload(framedComp)]).toEqual([...comp]);
    expect([...unframeChunkPayload(framedIncomp)]).toEqual([...incomp]);
  });

  test('framing is deterministic — a retried frame is byte-identical (G7)', () => {
    const raw = compressible(32 * 1024);
    expect([...frameChunkPayload(raw)]).toEqual([...frameChunkPayload(raw)]);
  });

  test('empty input frames as stored (empty part list never reaches here, but be total)', () => {
    const framed = frameChunkPayload(new Uint8Array(0));
    expect(framed[0]).toBe(ALGO_STORE);
    expect(framed.length).toBe(1);
    expect(unframeChunkPayload(framed).length).toBe(0);
  });

  describe('reader handles every id byte a conformant writer could emit', () => {
    test('a 0x02 deflate frame decodes even though the local writer prefers zstd', () => {
      // Simulate an object written by a zstd-less runtime: the reader MUST
      // still restore it (#405 §1 — backups are read on other machines).
      const raw = compressible(20_000);
      const body = zlib.deflateRawSync(raw);
      const framed = new Uint8Array(body.length + 1);
      framed[0] = ALGO_DEFLATE;
      framed.set(body, 1);
      expect([...unframeChunkPayload(framed)]).toEqual([...raw]);
    });

    test('a hand-built 0x00 stored frame decodes to its body verbatim', () => {
      const raw = randomBytes(1024);
      const framed = new Uint8Array(raw.length + 1);
      framed[0] = ALGO_STORE;
      framed.set(raw, 1);
      expect([...unframeChunkPayload(framed)]).toEqual([...raw]);
    });
  });

  test('unframe rejects an empty frame (missing id byte)', () => {
    expect(() => unframeChunkPayload(new Uint8Array(0))).toThrow(/empty frame/);
  });

  test('unframe rejects an unknown algorithm id', () => {
    const framed = new Uint8Array([0x7f, 1, 2, 3]);
    expect(() => unframeChunkPayload(framed)).toThrow(/unknown frame algorithm id 0x7f/);
  });
});
