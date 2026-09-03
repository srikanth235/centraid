import { partCountFor, frameCountFor, sealedSizeFor } from "./cbsf";
import type { FileSourceOpener } from "./file-source";
import { IncrementalSha256 } from "./incremental-sha256";
import type {
  UploadFollowupFactory,
  UploadItem,
  UploadQueueStore,
} from "./store";

const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export interface EnqueueInput {
  localUri: string;
  targetVaultId?: string;
  mediaType?: string;
  filename?: string;
  plaintextSize: number;
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
  const upload = {
    itemId: deps.newId(),
    sha256,
    localUri: input.localUri,
    ...(input.targetVaultId ? { targetVaultId: input.targetVaultId } : {}),
    ...(input.mediaType ? { mediaType: input.mediaType } : {}),
    ...(input.filename ? { filename: input.filename } : {}),
    plaintextSize: size,
    sealedSize: sealedSizeFor(size, frameCount),
    frameCount,
    partCount: partCountFor(frameCount),
  };
  return makeFollowup
    ? deps.store.enqueueWithFollowup(upload, makeFollowup)
    : deps.store.enqueue(upload);
}
