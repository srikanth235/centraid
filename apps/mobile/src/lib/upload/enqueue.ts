// Enqueue: address the bytes, then durably record the intent to back them up.
//
// The content sha is computed HERE, at enqueue, and persisted — every later
// step (resume, dedupe, seal AAD) is keyed by it, so it must be settled before
// the item is considered queued. If the process dies mid-hash the item was
// never enqueued and nothing is lost; the next pass re-hashes.

import { partCountFor, frameCountFor, sealedSizeFor } from './cbsf';
import type { FileSourceOpener } from './file-source';
import { IncrementalSha256 } from './incremental-sha256';
import type { UploadItem, UploadQueueStore } from './store';

/** Hash window. Matches the seal frame size, so memory stays flat and bounded. */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export interface EnqueueInput {
  localUri: string;
  mediaType?: string;
  filename?: string;
  /** Caller-known plaintext size; verified against the opened file. */
  plaintextSize: number;
}

/** The streaming-digest shape; `IncrementalSha256` is the portable default. */
export interface StreamingDigest {
  update(bytes: Uint8Array): unknown;
  digestHex(): string;
}

export interface EnqueueDeps {
  store: UploadQueueStore;
  openFile: FileSourceOpener;
  newId: () => string;
  createDigest?: () => StreamingDigest;
}

/**
 * Stream a local file through SHA-256 without ever holding it in memory.
 *
 * The default digest is pure JS and therefore SLOW: ~35 MB/s on V8 and an
 * estimated ~12 MB/s on Hermes, so a 4 GB video costs minutes of hashing
 * before a byte is uploaded. Memory stays flat (one 4 MiB window) at any size,
 * so this is a latency cost, not a stability one. `createDigest` exists so the
 * device can pass a native streaming hash — the WebCrypto polyfill the sealer
 * needs (see crypto.ts) also brings a native `createHash`, ~50x faster.
 */
export async function sha256OfFile(
  openFile: FileSourceOpener,
  localUri: string,
  createDigest: () => StreamingDigest = () => new IncrementalSha256(),
): Promise<{ sha256: string; size: number }> {
  const source = await openFile(localUri);
  try {
    const hash = createDigest();
    for (let offset = 0; offset < source.size; offset += HASH_CHUNK_BYTES) {
      const length = Math.min(HASH_CHUNK_BYTES, source.size - offset);
      const chunk = await source.read(offset, length);
      if (chunk.byteLength !== length) {
        throw new Error(`read ${chunk.byteLength} bytes at ${offset}, expected ${length}`);
      }
      hash.update(chunk);
    }
    return { sha256: hash.digestHex(), size: source.size };
  } finally {
    source.close();
  }
}

export async function enqueueLocalFile(
  deps: EnqueueDeps,
  input: EnqueueInput,
): Promise<UploadItem> {
  const { sha256, size } = await sha256OfFile(
    deps.openFile,
    input.localUri,
    ...(deps.createDigest ? [deps.createDigest] : []),
  );
  if (size !== input.plaintextSize) {
    throw new Error(`file is ${size} bytes, caller declared ${input.plaintextSize}`);
  }
  const frameCount = frameCountFor(size);
  return deps.store.enqueue({
    itemId: deps.newId(),
    sha256,
    localUri: input.localUri,
    ...(input.mediaType ? { mediaType: input.mediaType } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
    plaintextSize: size,
    sealedSize: sealedSizeFor(size, frameCount),
    frameCount,
    partCount: partCountFor(frameCount),
  });
}
