// THE SNAPSHOT DOOR, SERVED FROM MEMORY.
//
// Three rigs bootstrap a seat off an artifact they just built — the golden
// year-3 replica, the test-kit's own seat fixture and the gateway/seat parity
// run — and each used to spell the same stub out: an etag made of the epoch
// and the seq, the compressed size, the three numbers, and a `range` that
// yields the bytes from an offset. One spelling, so a change to the head's
// shape is a change in one place rather than a hunt through the rigs.
//
// Structurally typed on purpose: the kit does not depend on `@centraid/client`
// (whose `SeatSnapshotTransport` this satisfies) or on `@centraid/core`.

/** The three numbers a snapshot carries, as its builder reports them. */
export interface SeatSnapshotFacts {
  readonly seq: number;
  readonly epoch: string;
  readonly schemaEpoch: number;
}

export interface StaticSeatSnapshotTransport {
  head: () => Promise<{
    readonly etag: string;
    readonly bytes: number;
    readonly seq: number;
    readonly epoch: string;
    readonly schemaEpoch: number;
  }>;
  range: (start: number) => AsyncIterable<Uint8Array>;
}

/**
 * Serve `compressed` as the snapshot named by `snapshot`.
 *
 * `chunkBytes` splits the body, so a rig can exercise the resume-and-append
 * path rather than a single write that happens to work; the default is one
 * chunk.
 */
export function staticSeatSnapshotTransport(
  compressed: Uint8Array,
  snapshot: SeatSnapshotFacts,
  options: { readonly chunkBytes?: number } = {}
): StaticSeatSnapshotTransport {
  const chunkBytes = Math.max(1, options.chunkBytes ?? compressed.byteLength);
  return {
    head: () =>
      Promise.resolve({
        etag: `"${snapshot.epoch}-${snapshot.seq}"`,
        bytes: compressed.byteLength,
        seq: snapshot.seq,
        epoch: snapshot.epoch,
        schemaEpoch: snapshot.schemaEpoch,
      }),
    range: (start: number) => ({
      async *[Symbol.asyncIterator]() {
        for (let at = start; at < compressed.byteLength; at += chunkBytes)
          yield compressed.subarray(
            at,
            Math.min(at + chunkBytes, compressed.byteLength)
          );
      },
    }),
  };
}
