/*
 * Fixed-size part splitting (FORMAT.md § Parts — centraid-snapshot/1).
 * The part boundary math is format-normative: same bytes MUST produce the
 * same parts (and therefore the same keyed part ids) everywhere, forever
 * within /1 — so these tests pin exact boundary arithmetic, not just "it
 * splits". The aliasing tests exist because the engine's readFileStream
 * reuses one read buffer across yields: a part that aliases the source
 * buffer would silently back up bytes from the WRONG read.
 */

import { describe, expect, test } from 'vitest';
import { PART_BYTES, partBuffer, partStream } from './parts.js';

async function collect(
  source: AsyncIterable<Uint8Array>,
  partBytes?: number,
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const part of partStream(source, partBytes)) out.push(part);
  return out;
}

async function* pieces(...arrays: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const a of arrays) yield a;
}

/** Deterministic distinguishable bytes: value = (offset + i) mod 251 (prime, so no 256-alignment). */
function seq(length: number, offset = 0): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (offset + i) % 251;
  return out;
}

function concatAll(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const a of arrays) {
    out.set(a, at);
    at += a.length;
  }
  return out;
}

describe('part size constant', () => {
  test('PART_BYTES is exactly 16 MiB — format-normative, MUST NOT change within /1', () => {
    expect(PART_BYTES).toBe(16 * 1024 * 1024);
    expect(PART_BYTES).toBe(16777216);
  });
});

describe('partStream boundary math', () => {
  test('re-frames ragged pieces into exact partBytes slices, last part short', async () => {
    // 40+40+40+10 = 130 bytes → parts of 64, 64, 2.
    const input = [seq(40, 0), seq(40, 40), seq(40, 80), seq(10, 120)];
    const parts = await collect(pieces(...input), 64);
    expect(parts.map((p) => p.length)).toEqual([64, 64, 2]);
    // Byte-exact reassembly: no bytes lost, duplicated, or reordered.
    expect([...concatAll(parts)]).toEqual([...seq(130, 0)]);
  });

  test('one piece larger than several parts splits within the piece', async () => {
    const parts = await collect(pieces(seq(200, 0)), 64);
    expect(parts.map((p) => p.length)).toEqual([64, 64, 64, 8]);
    expect([...concatAll(parts)]).toEqual([...seq(200, 0)]);
    expect([...parts[1]!]).toEqual([...seq(64, 64)]);
  });

  test('exact multiple of partBytes yields no empty trailing part', async () => {
    const parts = await collect(pieces(seq(50, 0), seq(78, 50)), 64);
    expect(parts.map((p) => p.length)).toEqual([64, 64]);
    expect([...concatAll(parts)]).toEqual([...seq(128, 0)]);
  });

  test('input exactly one part long yields exactly one part', async () => {
    const parts = await collect(pieces(seq(64, 0)), 64);
    expect(parts.map((p) => p.length)).toEqual([64]);
    expect([...parts[0]!]).toEqual([...seq(64, 0)]);
  });

  test('empty source yields zero parts (a zero-byte file has an empty part list)', async () => {
    expect(await collect(pieces(), 64)).toEqual([]);
  });

  test('source of only empty pieces yields zero parts', async () => {
    expect(await collect(pieces(new Uint8Array(0), new Uint8Array(0)), 64)).toEqual([]);
  });

  test('single byte yields a single one-byte part', async () => {
    const parts = await collect(pieces(Uint8Array.of(0xab)), 64);
    expect(parts.map((p) => [...p])).toEqual([[0xab]]);
  });

  test('empty pieces interleaved with data do not perturb boundaries', async () => {
    const parts = await collect(
      pieces(new Uint8Array(0), seq(64, 0), new Uint8Array(0), seq(3, 64)),
      64,
    );
    expect(parts.map((p) => p.length)).toEqual([64, 3]);
    expect([...concatAll(parts)]).toEqual([...seq(67, 0)]);
  });

  test('rejects invalid part sizes', async () => {
    await expect(collect(pieces(seq(1)), 0)).rejects.toThrow(/invalid part size/);
    await expect(collect(pieces(seq(1)), -64)).rejects.toThrow(/invalid part size/);
    await expect(collect(pieces(seq(1)), 1.5)).rejects.toThrow(/invalid part size/);
  });
});

describe('source-buffer aliasing (engine readFileStream reuses its read buffer)', () => {
  test('tail-buffered parts hold the bytes as-of-yield, not later mutations', async () => {
    // The source yields the SAME 40-byte buffer three times, refilled between
    // yields — exactly readFileStream's shape. 120 bytes at partBytes 64:
    // part 0 = 40×1 ‖ 24×2, part 1 = 16×2 ‖ 40×3.
    const buf = new Uint8Array(40);
    async function* reused(): AsyncGenerator<Uint8Array> {
      buf.fill(1);
      yield buf;
      buf.fill(2);
      yield buf;
      buf.fill(3);
      yield buf;
    }
    const parts = await collect(reused(), 64);
    expect(parts.map((p) => p.length)).toEqual([64, 56]);
    expect([...parts[0]!]).toEqual([...new Uint8Array(40).fill(1), ...new Uint8Array(24).fill(2)]);
    expect([...parts[1]!]).toEqual([...new Uint8Array(16).fill(2), ...new Uint8Array(40).fill(3)]);
  });

  test('a part spanning exactly one full source piece is copied, never aliased', async () => {
    // Dangerous fast path: a lone piece of exactly partBytes could be yielded
    // as a live view of the source buffer; the next refill would then rewrite
    // the already-yielded part. Backup-corrupting if it ever regresses.
    const buf = new Uint8Array(64);
    async function* reused(): AsyncGenerator<Uint8Array> {
      buf.fill(1);
      yield buf;
      buf.fill(2);
      yield buf;
    }
    const parts = await collect(reused(), 64);
    expect(parts.map((p) => p.length)).toEqual([64, 64]);
    expect([...parts[0]!]).toEqual([...new Uint8Array(64).fill(1)]);
    expect([...parts[1]!]).toEqual([...new Uint8Array(64).fill(2)]);
  });

  test('multiple parts cut from one reused oversized piece are all copies', async () => {
    const buf = new Uint8Array(128);
    async function* reused(): AsyncGenerator<Uint8Array> {
      buf.fill(1);
      yield buf;
      buf.fill(2);
      yield buf;
    }
    const parts = await collect(reused(), 64);
    expect(parts.map((p) => p.length)).toEqual([64, 64, 64, 64]);
    expect([...parts[0]!]).toEqual([...new Uint8Array(64).fill(1)]);
    expect([...parts[1]!]).toEqual([...new Uint8Array(64).fill(1)]);
    expect([...parts[2]!]).toEqual([...new Uint8Array(64).fill(2)]);
    expect([...parts[3]!]).toEqual([...new Uint8Array(64).fill(2)]);
  });

  test('the final short part does not alias the source buffer either', async () => {
    const buf = new Uint8Array(10);
    let done = false;
    async function* reused(): AsyncGenerator<Uint8Array> {
      buf.fill(5);
      yield buf;
      done = true;
    }
    const parts = await collect(reused(), 64);
    buf.fill(9); // mutate AFTER the stream completed
    expect(done).toBe(true);
    expect([...parts[0]!]).toEqual([...new Uint8Array(10).fill(5)]);
  });
});

describe('partBuffer / partStream agreement', () => {
  test('partBuffer equals partStream over the same bytes regardless of piece framing', async () => {
    const data = seq(200, 7);
    const fromBuffer = await partBuffer(data, 64);
    const fromRaggedStream = await collect(
      pieces(data.subarray(0, 1), data.subarray(1, 65), data.subarray(65, 130), data.subarray(130)),
      64,
    );
    expect(fromBuffer.map((p) => [...p])).toEqual(fromRaggedStream.map((p) => [...p]));
    expect(fromBuffer.map((p) => p.length)).toEqual([64, 64, 64, 8]);
  });

  test('partBuffer of an empty buffer is an empty part list', async () => {
    expect(await partBuffer(new Uint8Array(0), 64)).toEqual([]);
  });
});
