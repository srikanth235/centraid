/*
 * FastCDC content-defined chunking (FORMAT.md § Chunking) — frozen for
 * `centraid-snapshot/1`. Boundaries (and therefore dedup ids) must be
 * stable across processes, machines and versions, so every piece of this
 * file that affects a boundary decision is deterministic and documented:
 *
 * - The 256-entry gear table is generated from a FIXED seed via splitmix64
 *   (a small, public-domain, bit-exact PRNG) — not `Math.random`, not a
 *   library table. Anyone re-deriving `GEAR` from `GEAR_SEED` below gets the
 *   exact same 256 uint32s, forever.
 * - The cut-point search is a single-mask FastCDC variant (Xia et al. 2016,
 *   simplified to one normalization level): `min 512 KiB, avg 1 MiB (20
 *   mask bits), max 4 MiB`, exactly the parameters FORMAT.md specifies.
 *   PROTOCOL/FORMAT don't mandate FastCDC's optional two-level
 *   normalization, so this file doesn't implement it — a deliberate scope
 *   cut, not an oversight.
 */

const MIN_CHUNK = 512 * 1024;
const AVG_MASK_BITS = 20;
const MAX_CHUNK = 4 * 1024 * 1024;
const MASK = (1 << AVG_MASK_BITS) - 1;

/** Frozen seed for the gear table — digits of e, unrelated to anything else. */
const GEAR_SEED = 0x2718281828459045n;
const U64_MASK = (1n << 64n) - 1n;

function splitmix64Next(state: bigint): { value: bigint; next: bigint } {
  let s = (state + 0x9e3779b97f4a7c15n) & U64_MASK;
  let z = s;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  z ^= z >> 31n;
  return { value: z, next: s };
}

function buildGearTable(): Uint32Array {
  const table = new Uint32Array(256);
  let state = GEAR_SEED;
  for (let i = 0; i < 256; i++) {
    const { value, next } = splitmix64Next(state);
    state = next;
    table[i] = Number(value & 0xffffffffn) >>> 0;
  }
  return table;
}

/** The frozen gear table for format `/1`. MUST NOT change (FORMAT.md). */
export const GEAR: Readonly<Uint32Array> = buildGearTable();

export const CHUNKER_PARAMS = {
  minChunk: MIN_CHUNK,
  avgMaskBits: AVG_MASK_BITS,
  maxChunk: MAX_CHUNK,
} as const;

/**
 * Find the cut offset within `buf` (a contiguous logical byte window, up to
 * `maxChunk` long). Returns the length of the first chunk in `buf`, always
 * `<= buf.length`. Exposed for the frozen-vector test; normal callers use
 * `chunkStream`.
 */
export function findCut(buf: Uint8Array): number {
  const n = buf.length;
  if (n <= MIN_CHUNK) return n;
  const barrier = Math.min(MAX_CHUNK, n);
  let fp = 0;
  for (let i = MIN_CHUNK; i < barrier; i++) {
    fp = ((fp << 1) + GEAR[buf[i] as number]!) >>> 0;
    if ((fp & MASK) === 0) return i + 1;
  }
  return barrier;
}

/**
 * FastCDC over a byte stream, bounded memory: never holds more than
 * `maxChunk` bytes plus the most recent single read in the pending buffer.
 * Boundaries are identical no matter how the input is sliced into reads —
 * the algorithm always waits until it has a full `maxChunk` window (or the
 * source is exhausted) before deciding a cut, so partial reads never
 * perturb the decision.
 *
 * Pending bytes accumulate as a LIST of parts (not a single reallocated
 * buffer) and are materialized into one contiguous array only once per fill
 * cycle — appending is O(1) per read, so total work stays O(total bytes)
 * even for a source that yields one byte at a time (an eager
 * concat-on-every-append implementation is O(n^2) on such input and was
 * measured timing out on a multi-megabyte, single-byte-read stream).
 *
 * @yields One content-defined chunk at a time, in stream order.
 */
export async function* chunkStream(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  const iter = source[Symbol.asyncIterator]();
  let done = false;
  let pendingParts: Uint8Array[] = [];
  let pendingLen = 0;

  async function fill(): Promise<void> {
    while (!done && pendingLen < MAX_CHUNK) {
      const { value, done: iterDone } = await iter.next();
      if (iterDone) {
        done = true;
        break;
      }
      if (value.length === 0) continue;
      pendingParts.push(value);
      pendingLen += value.length;
    }
  }

  function materialize(): Uint8Array {
    const first = pendingParts[0];
    if (pendingParts.length === 1 && first) return first;
    const buf = new Uint8Array(pendingLen);
    let offset = 0;
    for (const part of pendingParts) {
      buf.set(part, offset);
      offset += part.length;
    }
    return buf;
  }

  while (true) {
    // Fill up to MAX_CHUNK bytes before attempting a cut, unless the source
    // is already exhausted (then we cut whatever remains). This loop only
    // exits early (before reaching MAX_CHUNK) when the source is done, so
    // afterwards either `done` is true or `pendingLen >= MAX_CHUNK`.
    await fill();

    if (pendingLen === 0) {
      // Only reachable with `done === true` (see invariant above) — an
      // empty source, or a source whose final read landed exactly on a
      // prior cut boundary.
      return;
    }

    if (done && pendingLen <= MIN_CHUNK) {
      // Final, undersized remainder — a single trailing chunk.
      yield materialize();
      return;
    }

    const buf = materialize();
    const cut = findCut(buf);
    yield buf.subarray(0, cut);
    const remainder = buf.subarray(cut);
    pendingParts = remainder.length > 0 ? [remainder] : [];
    pendingLen = remainder.length;
  }
}

/** Chunk an in-memory buffer (small files, tests) without the streaming ceremony. */
export async function chunkBuffer(data: Uint8Array): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  async function* one(): AsyncGenerator<Uint8Array> {
    yield data;
  }
  for await (const c of chunkStream(one())) out.push(c);
  return out;
}
