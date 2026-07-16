import { Readable } from 'node:stream';
import type { BlobCache } from './cache.js';
import type { LocalBlobStore } from './local.js';
import { remoteEncryptionKey, type RemoteTier } from './custody-types.js';
import type { ReplicaStore } from './replica-index.js';
import { resolveWriteStore } from './store-routing.js';
import type { BlobStore } from './store.js';
import type { MultipartPart, RemoteBlobTransfer } from './remote-transfer.js';
import { verifyRemoteSealedObject } from './remote-verify.js';
import { sealBlob, sealBlobStream } from './seal.js';
import {
  DEFAULT_FRAME_SIZE,
  encodeHeader,
  encodeTrailer,
  frameCountFor,
  sealDirectory,
  sealStoredFrame,
} from './seal-frames.js';
import type { OutboxRow, BlobTransferState } from './transfer-state.js';

const PART_BYTES = 16 * 1024 * 1024;
// Match the S3 driver's single-PUT ceiling. Larger outbox residents use a
// restartable multipart upload directly at the final SHA key; temporary keys
// are reserved for hash-unknown stream-through ingress.
const DIRECT_FINAL_PUT_MAX_BYTES = 32 * 1024 * 1024;

function partsOf(row: OutboxRow): MultipartPart[] {
  try {
    const value = JSON.parse(row.parts_json) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter(
      (part): part is MultipartPart =>
        part !== null &&
        typeof part === 'object' &&
        Number.isInteger((part as MultipartPart).partNumber) &&
        typeof (part as MultipartPart).etag === 'string',
    );
  } catch {
    return [];
  }
}

export interface OutboxDrainDeps {
  state: BlobTransferState;
  local: LocalBlobStore;
  cache: BlobCache;
  remote: () => RemoteTier | null;
  onReplicated(sha256: string): void;
  settlementAllowed?: () => boolean;
  /** The store class a sha's bytes belong in (issue #425 Wave 2). Default cas. */
  desiredStore?: (sha256: string) => ReplicaStore;
}

async function confirmFinal(
  deps: OutboxDrainDeps,
  remote: RemoteTier,
  row: OutboxRow,
  store: BlobStore,
  storeClass: ReplicaStore,
): Promise<boolean> {
  const final = await store.stat(row.sha256);
  if (deps.settlementAllowed?.() === false) return true;
  if (!final) return false;
  try {
    const key = remoteEncryptionKey(remote, row.sha256);
    if (key) {
      await verifyRemoteSealedObject({
        store,
        sha256: row.sha256,
        key,
        sealedSize: final.size,
        expectedPlaintextSize: row.byte_size,
      });
    } else {
      if (final.size !== row.byte_size) return false;
      // Plaintext stores do not expose a provider checksum through BlobStat.
      // Compare bounded head/tail samples with the authoritative local CAS;
      // confirmation stays O(1) egress instead of downloading a 500 MiB body.
      const sample = Math.min(64 * 1024, row.byte_size);
      if (sample > 0) {
        const ranges = [
          { start: 0, end: sample - 1 },
          { start: Math.max(0, row.byte_size - sample), end: row.byte_size - 1 },
        ];
        for (const range of ranges) {
          const [remoteBytes, localBytes] = await Promise.all([
            store.get(row.sha256, range),
            Promise.resolve(deps.local.getSync(row.sha256, range)),
          ]);
          if (!remoteBytes || !localBytes || !remoteBytes.equals(localBytes)) return false;
        }
      }
    }
  } catch {
    // A stale zero/truncated/tampered object is not a custody receipt. The
    // resumable writer below replaces it from the still-present local source.
    return false;
  }
  // `stat` and integrity reads can outlive a synchronous database close.
  // Recheck the fence at the actual settlement boundary so no late promise
  // writes replica evidence or deletes the durable restart obligation.
  if (deps.settlementAllowed?.() === false) return true;
  deps.cache.replica.mark(row.sha256, row.byte_size, storeClass);
  deps.state.completeOutbox(row.sha256);
  deps.onReplicated(row.sha256);
  return true;
}

function supportsFinalMultipart(
  transfer: RemoteBlobTransfer,
): transfer is RemoteBlobTransfer &
  Required<
    Pick<
      RemoteBlobTransfer,
      'beginShaUpload' | 'uploadShaPart' | 'completeShaUpload' | 'abortShaUpload'
    >
  > {
  return (
    typeof transfer.beginShaUpload === 'function' &&
    typeof transfer.uploadShaPart === 'function' &&
    typeof transfer.completeShaUpload === 'function' &&
    typeof transfer.abortShaUpload === 'function'
  );
}

async function uploadViaDurableFinalMultipart(
  deps: OutboxDrainDeps,
  remote: RemoteTier,
  row: OutboxRow,
  storageClass: string | undefined,
): Promise<void> {
  const transfer = remote.transfer!;
  if (!supportsFinalMultipart(transfer)) throw new Error('final multipart upload is unavailable');
  if (!deps.local.hasSync(row.sha256)) {
    throw new Error(`pending blob ${row.sha256} has no local source`);
  }
  if (deps.settlementAllowed?.() === false) return;
  deps.state.markUploadingFinal(row.sha256);

  let uploadId = row.upload_id;
  if (!uploadId) {
    // The class rides the CreateMultipartUpload — the object-creating call — so
    // a resume (uploadId already set) keeps the class fixed at creation.
    uploadId = await transfer.beginShaUpload(row.sha256, storageClass);
    if (deps.settlementAllowed?.() === false) return;
    deps.state.setOutboxUpload(row.sha256, uploadId);
  }
  const saved = new Map(partsOf(row).map((part) => [part.partNumber, part.etag]));
  const encryptionKey = remoteEncryptionKey(remote, row.sha256);
  const frameSize = Math.max(remote.frameSize ?? DEFAULT_FRAME_SIZE, 8 * 1024 * 1024);
  const frameCount = frameCountFor(row.byte_size, frameSize);
  const sealedLens = Array.from({ length: frameCount }, (_, index) => {
    const plainLength = Math.min(frameSize, row.byte_size - index * frameSize);
    return plainLength + 1 + 12 + 16;
  });
  const directory = encryptionKey
    ? sealDirectory(encryptionKey, row.sha256, frameCount, frameSize, row.byte_size, sealedLens)
    : Buffer.alloc(0);
  const totalParts = encryptionKey
    ? Math.max(1, frameCount)
    : Math.ceil(row.byte_size / PART_BYTES);
  for (let partNumber = 1; partNumber <= totalParts; partNumber += 1) {
    if (!saved.has(partNumber)) {
      let bytes: Buffer;
      if (encryptionKey) {
        const index = Math.min(partNumber - 1, frameCount - 1);
        const start = index * frameSize;
        const end = Math.min(row.byte_size, start + frameSize) - 1;
        const plain =
          frameCount === 0 ? Buffer.alloc(0) : deps.local.getSync(row.sha256, { start, end });
        if (!plain) throw new Error(`pending blob ${row.sha256} has no local source range`);
        const frame =
          frameCount === 0
            ? Buffer.alloc(0)
            : sealStoredFrame(encryptionKey, row.sha256, index, frameCount, plain);
        bytes = Buffer.concat([
          ...(partNumber === 1 ? [encodeHeader(row.sha256)] : []),
          frame,
          ...(partNumber === totalParts
            ? [directory, encodeTrailer(directory.length, frameCount)]
            : []),
        ]);
      } else {
        const start = (partNumber - 1) * PART_BYTES;
        const end = Math.min(row.byte_size, start + PART_BYTES) - 1;
        bytes = deps.local.getSync(row.sha256, { start, end }) ?? Buffer.alloc(0);
      }
      saved.set(partNumber, await transfer.uploadShaPart(row.sha256, uploadId, partNumber, bytes));
      if (deps.settlementAllowed?.() === false) return;
      deps.state.setOutboxParts(
        row.sha256,
        [...saved].map(([number, etag]) => ({ partNumber: number, etag })),
      );
    }
  }
  const parts = [...saved]
    .filter(([number]) => number <= totalParts)
    .map(([number, etag]) => ({ partNumber: number, etag }))
    .sort((a, b) => a.partNumber - b.partNumber);
  if (parts.length === 0) {
    // Only possible for an unencrypted zero-byte object.
    await transfer.abortShaUpload(row.sha256, uploadId).catch(() => undefined);
    await remote.store.put(row.sha256, Buffer.alloc(0));
  } else {
    await transfer.completeShaUpload(row.sha256, uploadId, parts);
  }
  if (deps.settlementAllowed?.() === false) return;
  // The durable multipart path is cas-only (large originals); binary derivatives
  // never reach it, so it always confirms + marks under the cas store.
  if (!(await confirmFinal(deps, remote, row, remote.store, 'cas'))) {
    throw new Error(`provider did not expose ${row.sha256} after final multipart completion`);
  }
}

async function uploadViaCasStore(
  deps: OutboxDrainDeps,
  remote: RemoteTier,
  row: OutboxRow,
  store: BlobStore,
  storeClass: ReplicaStore,
  storageClass: string | undefined,
): Promise<void> {
  const opened = store.putStream ? deps.local.openReadStreamSync?.(row.sha256) : null;
  if (opened && store.putStream) {
    const encryptionKey = remoteEncryptionKey(remote, row.sha256);
    const source = encryptionKey
      ? opened.stream.pipe(sealBlobStream(encryptionKey, row.sha256, opened.size, remote.frameSize))
      : opened.stream;
    await store.putStream(row.sha256, source, opened.size, storageClass);
  } else {
    const plain = deps.local.getSync(row.sha256);
    if (!plain) throw new Error(`pending blob ${row.sha256} has no local source`);
    const encryptionKey = remoteEncryptionKey(remote, row.sha256);
    await store.put(
      row.sha256,
      encryptionKey ? sealBlob(encryptionKey, row.sha256, plain, remote.frameSize) : plain,
      storageClass,
    );
  }
  if (!(await confirmFinal(deps, remote, row, store, storeClass))) {
    throw new Error(`provider did not HEAD-confirm ${row.sha256} after upload`);
  }
}

/** Drain one durable custody obligation; transient failures remain resumable. */
export async function drainOutboxRow(deps: OutboxDrainDeps, row: OutboxRow): Promise<void> {
  const remote = deps.remote();
  if (!remote) throw new Error('remote CAS is not currently reachable/configured');
  // Route by the sha's store class (issue #425 Wave 2): a binary derivative
  // lands under the derived prefix when the tier grants one, else cas — the
  // resolver caps size + degrades gracefully, so `store`/`storeClass` always
  // agree with where the bytes go, and the preflight HEADs the same store.
  const desired = deps.desiredStore?.(row.sha256) ?? 'cas';
  const { store, storeClass } = resolveWriteStore(remote, desired, row.byte_size);
  if (await confirmFinal(deps, remote, row, store, storeClass)) return; // preflight/dedupe
  // Direct-to-cold heuristic (issue #425 Wave 3): a large media original writes
  // to STANDARD_IA when the target declares it. Computed once here and threaded
  // to whichever door serves it — both the single-PUT and the multipart path are
  // cas-only, so a derived write never resolves a class (`storageClassFor`
  // returns undefined for the derived store class).
  const storageClass = remote.storageClassFor?.(row.sha256, storeClass);
  await deps.cache.qosWait(); // interactive reads preempt bulk custody traffic
  if (deps.settlementAllowed?.() === false) return;
  const durableUploadStarted = row.upload_id !== null || partsOf(row).length > 0;
  if (
    storeClass === 'cas' &&
    remote.transfer &&
    deps.local.openReadStreamSync &&
    supportsFinalMultipart(remote.transfer) &&
    (durableUploadStarted || row.byte_size > DIRECT_FINAL_PUT_MAX_BYTES)
  ) {
    await uploadViaDurableFinalMultipart(deps, remote, row, storageClass);
  } else {
    await uploadViaCasStore(deps, remote, row, store, storeClass, storageClass);
  }
}

/** Convenience used by stream-through for small in-memory fakes. */
export function readableOf(bytes: Buffer): NodeJS.ReadableStream {
  return Readable.from([bytes]);
}
