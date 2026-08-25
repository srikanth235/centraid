// Fixed-size parts per FORMAT.md § Parts; size MUST NOT change in-format.

export const PART_BYTES = 16 * 1024 * 1024;

/** @yields {Uint8Array} Owned exact-`partBytes` slices, in order. */
export async function* partStream(
  source: AsyncIterable<Uint8Array>,
  partBytes: number = PART_BYTES
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
      // Copy when pending is empty, else this aliases the caller's buffer.
      pending.push(pending.length === 0 ? Uint8Array.from(slice) : slice);
      yield concat(pending, partBytes);
      pending = [];
      pendingBytes = 0;
      rest = rest.subarray(take);
    }
    if (rest.length > 0) {
      // Copy the tail: callers reuse their read buffer.
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

export async function partBuffer(
  data: Uint8Array,
  partBytes: number = PART_BYTES
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for await (const part of partStream(single(data), partBytes)) out.push(part);
  return out;
}

async function* single(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}
