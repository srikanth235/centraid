import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { CHUNKER_PARAMS, chunkBuffer, chunkStream, findCut, GEAR } from './chunker.js';

/** Feed `data` through `chunkStream` in reads of exactly `readSize` bytes. */
async function chunkWithReadSize(data: Uint8Array, readSize: number): Promise<Uint8Array[]> {
  /** @yields Successive `readSize`-byte slices of `data`. */
  async function* source(): AsyncGenerator<Uint8Array> {
    for (let i = 0; i < data.length; i += readSize) {
      yield data.subarray(i, Math.min(i + readSize, data.length));
    }
  }
  const out: Uint8Array[] = [];
  for await (const c of chunkStream(source())) out.push(c);
  return out;
}

/** A deterministic pseudorandom buffer (xorshift32), NOT crypto-random — repeatable across runs. */
function pseudoRandomBuffer(size: number, seed: number): Uint8Array {
  let x = seed >>> 0 || 1;
  const buf = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    buf[i] = x & 0xff;
  }
  return buf;
}

describe('gear table', () => {
  test('is 256 entries, all uint32', () => {
    expect(GEAR.length).toBe(256);
    for (const v of GEAR) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });

  test('is deterministic — matches a frozen snapshot of the first/last entries', () => {
    // Freezing a handful of entries (not all 256) keeps this test readable
    // while still catching any change to the seed or the splitmix64 derivation.
    expect(GEAR[0]).toBe(2573196849);
    expect(GEAR[1]).toBe(561545032);
    expect(GEAR[255]).toBe(3644695417);
  });
});

describe('findCut', () => {
  test('returns full length when input is at or below min chunk size', () => {
    expect(findCut(new Uint8Array(0))).toBe(0);
    expect(findCut(new Uint8Array(100))).toBe(100);
    expect(findCut(new Uint8Array(CHUNKER_PARAMS.minChunk))).toBe(CHUNKER_PARAMS.minChunk);
  });

  test('never exceeds max chunk size', () => {
    const buf = pseudoRandomBuffer(CHUNKER_PARAMS.maxChunk * 2, 42);
    const cut = findCut(buf.subarray(0, CHUNKER_PARAMS.maxChunk + 500));
    expect(cut).toBeLessThanOrEqual(CHUNKER_PARAMS.maxChunk);
  });

  test('never returns less than min chunk size for input larger than min', () => {
    const buf = pseudoRandomBuffer(CHUNKER_PARAMS.maxChunk, 7);
    const cut = findCut(buf);
    expect(cut).toBeGreaterThanOrEqual(CHUNKER_PARAMS.minChunk);
  });
});

describe('chunkStream', () => {
  test('empty source yields zero chunks', async () => {
    const chunks = await chunkBuffer(new Uint8Array(0));
    expect(chunks).toEqual([]);
  });

  test('tiny file (below min) yields exactly one chunk equal to the whole file', async () => {
    const data = pseudoRandomBuffer(123, 1);
    const chunks = await chunkBuffer(data);
    expect(chunks.length).toBe(1);
    expect([...chunks[0]!]).toEqual([...data]);
  });

  test('reassembled chunks equal the original bytes', async () => {
    const data = pseudoRandomBuffer(6 * 1024 * 1024, 99);
    const chunks = await chunkBuffer(data);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBe(data.length);
    const reassembled = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      reassembled.set(c, offset);
      offset += c.length;
    }
    expect([...reassembled]).toEqual([...data]);
  });

  test('every chunk (except possibly the last) is within [min, max] bounds', async () => {
    const data = pseudoRandomBuffer(10 * 1024 * 1024, 123);
    const chunks = await chunkBuffer(data);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      const size = chunks[i]!.length;
      expect(size).toBeLessThanOrEqual(CHUNKER_PARAMS.maxChunk);
      if (i < chunks.length - 1) {
        expect(size).toBeGreaterThanOrEqual(CHUNKER_PARAMS.minChunk);
      }
    }
  });

  test('boundaries are identical regardless of how input is sliced into reads', async () => {
    const data = pseudoRandomBuffer(3 * 1024 * 1024 + 777, 2024);
    const asOneRead = await chunkWithReadSize(data, data.length);
    const asOneByteReads = await chunkWithReadSize(data, 1);
    const asOddReads = await chunkWithReadSize(data, 3333);
    const sizesOf = (chunks: Uint8Array[]) => chunks.map((c) => c.length);
    expect(sizesOf(asOneByteReads)).toEqual(sizesOf(asOneRead));
    expect(sizesOf(asOddReads)).toEqual(sizesOf(asOneRead));
  });

  test('frozen test vector: hash of concatenated chunk sizes for a seeded 10MB buffer', async () => {
    const data = pseudoRandomBuffer(10 * 1024 * 1024, 0xc0ffee);
    const chunks = await chunkBuffer(data);
    const sizesCsv = chunks.map((c) => c.length).join(',');
    const hash = createHash('sha256').update(sizesCsv).digest('hex');
    // Freezes the gear table + cut algorithm together — any change to either
    // changes this hash. Recorded once, from this implementation's own output.
    expect(hash).toBe('09185ee4da1781639e3dcc25a6a4600c2b5c23a56b094504db1ef7dff7fc18b3');
  });
});
