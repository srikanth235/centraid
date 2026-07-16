import { Readable } from 'node:stream';
import type { BlobCache } from './cache.js';
import type { LocalBlobStore } from './local.js';
import { remoteEncryptionKey, type RemoteTier } from './custody-types.js';
import type { MultipartPart, RemoteBlobTransfer } from './remote-transfer.js';
import { verifyRemoteSealedObject } from './remote-verify.js';
import { sealBlob, sealBlobStream } from './seal.js';
import { sha256OfBytes } from './store.js';
import type { OutboxRow, BlobTransferState } from './transfer-state.js';

const PART_BYTES = 16 * 1024 * 1024;
// Match the S3 driver's single-PUT ceiling. Larger outbox residents use a
// restartable multipart upload directly at the final SHA key; temporary keys
// are reserved for hash-unknown stream-through ingress.
const DIRECT_FINAL_PUT_MAX_BYTES = 32 * 1024 * 1024;

async function* fixedChunks(
  source: NodeJS.ReadableStream,
  partSize = PART_BYTES,
): AsyncGenerator<Buffer> {
  let pending: Buffer[] = [];
  let length = 0;
  for await (const value of source as AsyncIterable<Buffer | string>) {
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    while (chunk.length > 0) {
      const take = chunk.subarray(0, Math.min(partSize - length, chunk.length));
      pending.push(take);
      length += take.length;
      chunk = chunk.subarray(take.length);
      if (length === partSize) {
        yield Buffer.concat(pending, length);
        pending = [];
        length = 0;
      }
    }
  }
  if (length > 0) yield Buffer.concat(pending, length);
}

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
}

async function confirmFinal(
  deps: OutboxDrainDeps,
  remote: RemoteTier,
  row: OutboxRow,
): Promise<boolean> {
  const final = await remote.store.stat(row.sha256);
  if (!final) return false;
  try {
    const key = remoteEncryptionKey(remote, row.sha256);
    if (key) {
      await verifyRemoteSealedObject({
        store: remote.store,
        sha256: row.sha256,
        key,
        sealedSize: final.size,
        expectedPlaintextSize: row.byte_size,
      });
    } else {
      const bytes = await remote.store.get(row.sha256);
      if (!bytes || bytes.length !== row.byte_size || sha256OfBytes(bytes) !== row.sha256) {
        return false;
      }
    }
  } catch {
    // A stale zero/truncated/tampered object is not a custody receipt. The
    // resumable writer below replaces it from the still-present local source.
    return false;
  }
  deps.cache.replica.mark(row.sha256, row.byte_size);
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
): Promise<void> {
  const transfer = remote.transfer!;
  if (!supportsFinalMultipart(transfer)) throw new Error('final multipart upload is unavailable');
  const opened = deps.local.openReadStreamSync?.(row.sha256);
  if (!opened) throw new Error(`pending blob ${row.sha256} has no local source`);
  deps.state.markUploadingFinal(row.sha256);

  let uploadId = row.upload_id;
  if (!uploadId) {
    uploadId = await transfer.beginShaUpload(row.sha256);
    deps.state.setOutboxUpload(row.sha256, uploadId);
  }
  const saved = new Map(partsOf(row).map((part) => [part.partNumber, part.etag]));
  const encryptionKey = remoteEncryptionKey(remote, row.sha256);
  const source = encryptionKey
    ? opened.stream.pipe(sealBlobStream(encryptionKey, row.sha256, opened.size, remote.frameSize))
    : opened.stream;
  let partNumber = 1;
  for await (const bytes of fixedChunks(source)) {
    if (!saved.has(partNumber)) {
      saved.set(partNumber, await transfer.uploadShaPart(row.sha256, uploadId, partNumber, bytes));
      deps.state.setOutboxParts(
        row.sha256,
        [...saved].map(([number, etag]) => ({ partNumber: number, etag })),
      );
    }
    partNumber += 1;
  }
  const parts = [...saved]
    .filter(([number]) => number < partNumber)
    .map(([number, etag]) => ({ partNumber: number, etag }))
    .sort((a, b) => a.partNumber - b.partNumber);
  if (parts.length === 0) {
    // Only possible for an unencrypted zero-byte object.
    await transfer.abortShaUpload(row.sha256, uploadId).catch(() => undefined);
    await remote.store.put(row.sha256, Buffer.alloc(0));
  } else {
    await transfer.completeShaUpload(row.sha256, uploadId, parts);
  }
  if (!(await confirmFinal(deps, remote, row))) {
    throw new Error(`provider did not expose ${row.sha256} after final multipart completion`);
  }
}

async function uploadViaCasStore(
  deps: OutboxDrainDeps,
  remote: RemoteTier,
  row: OutboxRow,
): Promise<void> {
  const opened = remote.store.putStream ? deps.local.openReadStreamSync?.(row.sha256) : null;
  if (opened && remote.store.putStream) {
    const encryptionKey = remoteEncryptionKey(remote, row.sha256);
    const source = encryptionKey
      ? opened.stream.pipe(sealBlobStream(encryptionKey, row.sha256, opened.size, remote.frameSize))
      : opened.stream;
    await remote.store.putStream(row.sha256, source, opened.size);
  } else {
    const plain = deps.local.getSync(row.sha256);
    if (!plain) throw new Error(`pending blob ${row.sha256} has no local source`);
    const encryptionKey = remoteEncryptionKey(remote, row.sha256);
    await remote.store.put(
      row.sha256,
      encryptionKey ? sealBlob(encryptionKey, row.sha256, plain, remote.frameSize) : plain,
    );
  }
  if (!(await confirmFinal(deps, remote, row))) {
    throw new Error(`provider did not HEAD-confirm ${row.sha256} after upload`);
  }
}

/** Drain one durable custody obligation; transient failures remain resumable. */
export async function drainOutboxRow(deps: OutboxDrainDeps, row: OutboxRow): Promise<void> {
  const remote = deps.remote();
  if (!remote) throw new Error('remote CAS is not currently reachable/configured');
  if (await confirmFinal(deps, remote, row)) return; // preflight/dedupe
  await deps.cache.qosWait(); // interactive reads preempt bulk custody traffic
  const durableUploadStarted = row.upload_id !== null || partsOf(row).length > 0;
  if (
    remote.transfer &&
    deps.local.openReadStreamSync &&
    supportsFinalMultipart(remote.transfer) &&
    (durableUploadStarted || row.byte_size > DIRECT_FINAL_PUT_MAX_BYTES)
  ) {
    await uploadViaDurableFinalMultipart(deps, remote, row);
  } else {
    await uploadViaCasStore(deps, remote, row);
  }
}

/** Convenience used by stream-through for small in-memory fakes. */
export function readableOf(bytes: Buffer): NodeJS.ReadableStream {
  return Readable.from([bytes]);
}
