/*
 * Fixed-size file parts (FORMAT.md § Parts — centraid-snapshot/1).
 *
 * Format /1 uses fixed parts instead of FastCDC content-defined chunking:
 * objects left in a snapshot are SQLite base files, git bundles and the seal
 * key. SQLite updates pages IN PLACE (no insert-shift), so fixed boundaries
 * dedup consecutive bases at ~O(changed pages) via the existing HMAC content
 * addressing — CDC's insert-resilience bought nothing here while costing a
 * frozen gear table and a cross-repo parameter-unification liability
 * (#405 §1). Part size is part of the format: same bytes must produce the
 * same part ids everywhere, so it MUST NOT change within format `/1`.
 */

export const PART_BYTES = 16 * 1024 * 1024;

/**
 * Re-frame a byte stream into exact `partBytes` slices (last part short).
 * An empty source yields no parts — a zero-byte file is an entry with an
 * empty part list, matching /1's chunker behavior.
 * @yields Owned `partBytes`-sized slices (final slice short), in order.
 */
export async function* partStream(
  source: AsyncIterable<Uint8Array>,
  partBytes: number = PART_BYTES,
): AsyncIterable<Uint8Array> {
  if (!Number.isInteger(partBytes) || partBytes <= 0) {
    throw new Error(`partStream: invalid part size ${partBytes}`);
  }
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  for await (const piece of source) {
    let rest = piece;
    while (pendingBytes + rest.length >= partBytes) {
      const take = partBytes - pendingBytes;
      const slice = rest.subarray(0, take);
      // When `pending` is empty this slice IS the whole part and `concat`
      // returns it as-is — copy it, or the yielded part would be a live view
      // of the caller's (reused) read buffer and mutate after yield. With
      // `pending` non-empty, `concat` always allocates, so the view is safe.
      pending.push(pending.length === 0 ? Uint8Array.from(slice) : slice);
      yield concat(pending, partBytes);
      pending = [];
      pendingBytes = 0;
      rest = rest.subarray(take);
    }
    if (rest.length > 0) {
      // Copy the tail: callers (readFileStream) reuse their read buffer, so
      // holding a subarray across loop iterations would alias mutated bytes.
      pending.push(Uint8Array.from(rest));
      pendingBytes += rest.length;
    }
  }
  if (pendingBytes > 0) yield concat(pending, pendingBytes);
}

function concat(pieces: Uint8Array[], total: number): Uint8Array {
  if (pieces.length === 1 && pieces[0]!.length === total) return pieces[0]!;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Split an in-memory buffer (small inputs / tests). */
export async function partBuffer(
  data: Uint8Array,
  partBytes: number = PART_BYTES,
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const part of partStream(single(data), partBytes)) out.push(part);
  return out;
}

async function* single(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}
