import { createHash } from 'node:crypto';
import { Transform } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import type { BackupPolicy } from '../backup-policy.js';
import { VaultBlobHashMismatchError, VaultBlobSessionError } from '../errors.js';
import { uuidv7 } from '../ids.js';
import type { BlobCache } from './cache.js';
import { remoteEncryptionKey, type RemoteTier } from './custody-types.js';
import { extractBlobMetaFromProbes, sniffMediaType } from './pipeline.js';
import { INGRESS_PREVIEW_MAX_BYTES, type IngressPreviewInput } from './preview.js';
import { verifyRemoteSealedObject } from './remote-verify.js';
import { sealBlobStream } from './seal.js';
import { recordKnownStagedBlob } from './staging-record.js';
import { mediaLocationPolicyForVault } from './staging.js';
import { assertSha } from './store.js';
import type { CommittedBlob } from './transfers.js';

export async function streamThroughOnce(
  deps: {
    vault: DatabaseSync;
    cache: BlobCache;
    remote: () => RemoteTier | null;
    policy: () => BackupPolicy;
    contributePreview?: (input: IngressPreviewInput) => void;
    emit(): void;
  },
  input: {
    expectedSha256: string;
    expectedSize: number;
    mediaType?: string;
    filename?: string;
    stagedBy?: string;
  },
  source: NodeJS.ReadableStream,
): Promise<CommittedBlob> {
  const sha = assertSha(input.expectedSha256);
  const remote = deps.remote();
  const key = remote ? remoteEncryptionKey(remote, sha) : undefined;
  if (!remote?.transfer || !key) {
    throw new Error('remote CAS does not support encrypted bounded stream-through');
  }
  const tempId = `stream-${uuidv7()}`;
  const hash = createHash('sha256');
  let received = 0;
  const probeChunks: Buffer[] = [];
  let probeBytes = 0;
  let tail = Buffer.alloc(0);
  let previewChunks: Buffer[] = [];
  let previewBytes = 0;
  let previewEligible: boolean | undefined;
  const tee = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (previewEligible === undefined) {
        previewEligible = sniffMediaType(chunk, input.mediaType, input.filename).startsWith(
          'image/',
        );
      }
      hash.update(chunk);
      received += chunk.length;
      if (probeBytes < 1024 * 1024) {
        const sample = chunk.subarray(0, 1024 * 1024 - probeBytes);
        probeChunks.push(Buffer.from(sample));
        probeBytes += sample.length;
      }
      const withTail = Buffer.concat([tail, chunk]);
      tail = Buffer.from(withTail.subarray(Math.max(0, withTail.length - 8 * 1024 * 1024)));
      if (previewEligible && previewBytes + chunk.length <= INGRESS_PREVIEW_MAX_BYTES) {
        previewChunks.push(Buffer.from(chunk));
        previewBytes += chunk.length;
      } else if (previewEligible) {
        previewEligible = false;
        previewChunks = [];
        previewBytes = 0;
      }
      callback(null, chunk);
    },
  });
  const upload = source
    .pipe(tee)
    .pipe(sealBlobStream(key, sha, input.expectedSize, remote.frameSize));
  try {
    await remote.transfer.putTemporaryStream(tempId, upload, input.expectedSize);
    const actual = hash.digest('hex');
    if (received !== input.expectedSize) {
      throw new VaultBlobSessionError(
        `stream ended at ${received} bytes, expected ${input.expectedSize}`,
        received,
      );
    }
    if (actual !== sha) throw new VaultBlobHashMismatchError(sha, actual);
    await remote.transfer.copyTemporaryToSha(tempId, sha);
    const final = await remote.store.stat(sha);
    if (!final) throw new Error(`provider did not HEAD-confirm ${sha}`);
    await verifyRemoteSealedObject({
      store: remote.store,
      sha256: sha,
      key,
      sealedSize: final.size,
      expectedPlaintextSize: received,
    });
    deps.cache.replica.mark(sha, received);
    const head = Buffer.concat(probeChunks, probeBytes);
    const mediaType = sniffMediaType(head, input.mediaType, input.filename);
    const staged = recordKnownStagedBlob(deps.vault, {
      sha256: sha,
      byteSize: received,
      mediaType,
      meta: extractBlobMetaFromProbes(head, tail, mediaType, {
        keepLocation: mediaLocationPolicyForVault(deps.vault) !== 'strip',
      }),
      ...(input.filename ? { filename: input.filename } : {}),
      ...(input.stagedBy ? { stagedBy: input.stagedBy } : {}),
    });
    if (previewEligible && deps.contributePreview) {
      try {
        deps.contributePreview({
          sha256: sha,
          bytes: Buffer.concat(previewChunks, previewBytes),
          mediaType,
          ...(input.stagedBy ? { stagedBy: input.stagedBy } : {}),
        });
      } catch {
        // Custody is complete; a declined/failed preview remains backfillable.
      }
    }
    deps.emit();
    return { ...staged, casAck: deps.policy().casAck, custody: 'remote-only' };
  } finally {
    await remote.transfer.deleteTemporary(tempId).catch(() => undefined);
  }
}
