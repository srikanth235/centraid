// Sha computed HERE and persisted — resume, dedupe, and seal AAD all key on
// it. A crash mid-hash left nothing enqueued; the next pass re-hashes.

import { partCountFor, frameCountFor, sealedSizeFor } from "./cbsf";
import type { FileSourceOpener } from "./file-source";
import { IncrementalSha256 } from "./incremental-sha256";
import type {
  UploadFollowupFactory,
  UploadItem,
  UploadQueueStore,
} from "./store";

/** Must match the seal frame size. */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export interface EnqueueInput {
  localUri: string;
  targetVaultId?: string;
  mediaType?: string;
  filename?: string;
  /** Verified against the opened file. */
  plaintextSize: number;
  /** Precomputed digest avoids hashing a 4 GB file twice (F11 probe); verified like a fresh hash. */
  digest?: { sha256: string; size: number };
}

export interface StreamingDigest {
  update: (bytes: Uint8Array) => unknown;
  digestHex: () => string;
}

export interface EnqueueDeps {
  store: UploadQueueStore;
  openFile: FileSourceOpener;
  newId: () => string;
  createDigest?: () => StreamingDigest;
}

/** Flat-memory streaming SHA-256; the JS default is slow (~12 MB/s on Hermes) — inject a native digest. */
export async function sha256OfFile(
  openFile: FileSourceOpener,
  localUri: string,
  createDigest: () => StreamingDigest = () => new IncrementalSha256()
): Promise<{ sha256: string; size: number }> {
  const source = await openFile(localUri);
  try {
    const hash = createDigest();
    const hashNextChunk = async (offset: number): Promise<void> => {
      if (offset >= source.size) return;
      const length = Math.min(HASH_CHUNK_BYTES, source.size - offset);
      const chunk = await source.read(offset, length);
      if (chunk.byteLength !== length) {
        throw new Error(
          `read ${chunk.byteLength} bytes at ${offset}, expected ${length}`
        );
      }
      hash.update(chunk);
      return hashNextChunk(offset + HASH_CHUNK_BYTES);
    };
    await hashNextChunk(0);
    return { sha256: hash.digestHex(), size: source.size };
  } finally {
    source.close();
  }
}

/** How much of each end of the file the edge digest covers (#1014, P22). */
export const EDGE_DIGEST_BYTES = 1024 * 1024;

/**
 * A cheap fingerprint of the file's first and last {@link EDGE_DIGEST_BYTES}.
 *
 * Not a substitute for the content sha — it is the RESUME guard: re-hashing a
 * 4 GB video on every resumed attempt would cost more than re-uploading it,
 * while a size check alone passes an in-place rewrite that keeps the byte
 * count. A file shorter than one window hashes whole, which is exact.
 */
export async function edgeDigestOfFile(
  source: {
    size: number;
    read: (offset: number, length: number) => Promise<Uint8Array>;
  },
  createDigest: () => StreamingDigest = () => new IncrementalSha256()
): Promise<string> {
  const hash = createDigest();
  const head = Math.min(EDGE_DIGEST_BYTES, source.size);
  hash.update(await source.read(0, head));
  if (source.size > EDGE_DIGEST_BYTES) {
    const tail = Math.min(EDGE_DIGEST_BYTES, source.size - head);
    hash.update(await source.read(source.size - tail, tail));
  }
  return hash.digestHex();
}

export async function enqueueLocalFile(
  deps: EnqueueDeps,
  input: EnqueueInput,
  makeFollowup?: UploadFollowupFactory
): Promise<UploadItem> {
  const { sha256, size } =
    input.digest ??
    (await sha256OfFile(
      deps.openFile,
      input.localUri,
      ...(deps.createDigest ? [deps.createDigest] : [])
    ));
  if (size !== input.plaintextSize) {
    throw new Error(
      `file is ${size} bytes, caller declared ${input.plaintextSize}`
    );
  }
  const frameCount = frameCountFor(size);
  // Taken once, here, from the same file the sha addressed; the drainer
  // re-takes it on every resumed attempt (#1014, P22).
  const edgeSource = await deps.openFile(input.localUri);
  let edgeDigest: string;
  try {
    edgeDigest = await edgeDigestOfFile(
      edgeSource,
      ...(deps.createDigest ? [deps.createDigest] : [])
    );
  } finally {
    edgeSource.close();
  }
  const upload = {
    itemId: deps.newId(),
    sha256,
    localUri: input.localUri,
    ...(input.targetVaultId ? { targetVaultId: input.targetVaultId } : {}),
    ...(input.mediaType ? { mediaType: input.mediaType } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
    plaintextSize: size,
    edgeDigest,
    sealedSize: sealedSizeFor(size, frameCount),
    frameCount,
    partCount: partCountFor(frameCount),
  };
  return makeFollowup
    ? deps.store.enqueueWithFollowup(upload, makeFollowup)
    : deps.store.enqueue(upload);
}
