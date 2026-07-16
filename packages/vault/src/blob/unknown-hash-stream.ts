import { createHash, randomBytes } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import type { DatabaseSync } from 'node:sqlite';
import type { BackupPolicy } from '../backup-policy.js';
import { VaultBlobSessionError } from '../errors.js';
import { uuidv7 } from '../ids.js';
import type { BlobCache } from './cache.js';
import { remoteEncryptionKey, type RemoteTier } from './custody-types.js';
import { extractBlobMetaFromProbes, sniffMediaType } from './pipeline.js';
import { INGRESS_PREVIEW_MAX_BYTES, type IngressPreviewInput } from './preview.js';
import type { RemoteBlobTransfer } from './remote-transfer.js';
import { verifyRemoteSealedObject } from './remote-verify.js';
import { sealBlobStream } from './seal.js';
import {
  decodeHeader,
  decodeTrailer,
  HEADER_BYTES,
  openDirectory,
  TRAILER_BYTES,
  unsealFrame,
} from './seal-frames.js';
import { recordKnownStagedBlob } from './staging-record.js';
import { mediaLocationPolicyForVault } from './staging.js';
import { sha256OfBytes } from './store.js';
import type { CommittedBlob } from './transfers.js';

interface UnknownStreamDeps {
  vault: DatabaseSync;
  cache: BlobCache;
  remote: () => RemoteTier | null;
  policy: () => BackupPolicy;
  contributePreview?: (input: IngressPreviewInput) => void;
  emit(): void;
}

async function* temporaryPlaintext(input: {
  transfer: RemoteBlobTransfer;
  tempId: string;
  key: Buffer;
  sealId: string;
  expectedSize: number;
}): AsyncGenerator<Buffer> {
  if (!input.transfer.getTemporary)
    throw new Error('remote tier cannot read encrypted temp ranges');
  const stat = await input.transfer.statTemporary(input.tempId);
  if (!stat || stat.size < HEADER_BYTES + TRAILER_BYTES) {
    throw new Error('provider returned a truncated hash-pending object');
  }
  const header = await input.transfer.getTemporary(input.tempId, {
    start: 0,
    end: HEADER_BYTES - 1,
  });
  if (!header) throw new Error('provider lost the hash-pending header');
  decodeHeader(header, input.sealId);
  const trailerBytes = await input.transfer.getTemporary(input.tempId, {
    start: stat.size - TRAILER_BYTES,
    end: stat.size - 1,
  });
  if (!trailerBytes) throw new Error('provider lost the hash-pending trailer');
  const trailer = decodeTrailer(trailerBytes);
  const directoryStart = stat.size - TRAILER_BYTES - trailer.directoryLength;
  const sealedDirectory = await input.transfer.getTemporary(input.tempId, {
    start: directoryStart,
    end: stat.size - TRAILER_BYTES - 1,
  });
  if (!sealedDirectory) throw new Error('provider lost the hash-pending directory');
  const directory = openDirectory(input.key, input.sealId, trailer.frameCount, sealedDirectory);
  if (directory.totalSize !== input.expectedSize) {
    throw new Error('hash-pending plaintext size does not match its session');
  }
  for (let index = 0; index < directory.frameCount; index += 1) {
    const sealed = await input.transfer.getTemporary(input.tempId, {
      start: directory.offsets[index]!,
      end: directory.offsets[index]! + directory.sealedLens[index]! - 1,
    });
    if (!sealed) throw new Error(`provider lost hash-pending frame ${index}`);
    yield unsealFrame(input.key, input.sealId, index, directory.frameCount, sealed);
  }
}

/**
 * Low-disk bare-stream lane: seal under an ephemeral identity while hashing,
 * then range-read/re-key provider temp frames once the content address exists.
 */
export async function streamThroughUnknownHash(
  deps: UnknownStreamDeps,
  input: {
    expectedSize: number;
    mediaType?: string;
    filename?: string;
    stagedBy?: string;
  },
  source: NodeJS.ReadableStream,
): Promise<CommittedBlob> {
  const remote = deps.remote();
  if (!remote?.transfer?.getTemporary || !remote.keyFor) {
    throw new Error('remote CAS cannot re-key a hash-pending encrypted stream');
  }
  const firstTempId = `hash-pending-${uuidv7()}`;
  const finalTempId = `hash-final-${uuidv7()}`;
  const sealId = sha256OfBytes(Buffer.from(firstTempId));
  const tempKey = randomBytes(32);
  const hash = createHash('sha256');
  const headChunks: Buffer[] = [];
  let headBytes = 0;
  let tail = Buffer.alloc(0);
  let received = 0;
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
      if (headBytes < 1024 * 1024) {
        const sample = chunk.subarray(0, 1024 * 1024 - headBytes);
        headChunks.push(Buffer.from(sample));
        headBytes += sample.length;
      }
      const joined = Buffer.concat([tail, chunk]);
      tail = Buffer.from(joined.subarray(Math.max(0, joined.length - 8 * 1024 * 1024)));
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
  try {
    await remote.transfer.putTemporaryStream(
      firstTempId,
      source.pipe(tee).pipe(sealBlobStream(tempKey, sealId, input.expectedSize, remote.frameSize)),
      input.expectedSize,
    );
    if (received !== input.expectedSize) {
      throw new VaultBlobSessionError(
        `stream ended at ${received} bytes, expected ${input.expectedSize}`,
        received,
      );
    }
    const sha = hash.digest('hex');
    const finalKey = remoteEncryptionKey(remote, sha)!;
    const finish = (): CommittedBlob => {
      deps.cache.replica.mark(sha, received);
      const head = Buffer.concat(headChunks, headBytes);
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
    };
    const existing = await remote.store.stat(sha);
    if (existing) {
      try {
        await verifyRemoteSealedObject({
          store: remote.store,
          sha256: sha,
          key: finalKey,
          sealedSize: existing.size,
          expectedPlaintextSize: received,
        });
        return finish();
      } catch {
        deps.cache.replica.unmark(sha);
      }
    }
    const plain = Readable.from(
      temporaryPlaintext({
        transfer: remote.transfer,
        tempId: firstTempId,
        key: tempKey,
        sealId,
        expectedSize: received,
      }),
    );
    await remote.transfer.putTemporaryStream(
      finalTempId,
      plain.pipe(sealBlobStream(finalKey, sha, received, remote.frameSize)),
      received,
    );
    await remote.transfer.copyTemporaryToSha(finalTempId, sha);
    const final = await remote.store.stat(sha);
    if (!final) throw new Error(`provider did not HEAD-confirm ${sha}`);
    await verifyRemoteSealedObject({
      store: remote.store,
      sha256: sha,
      key: finalKey,
      sealedSize: final.size,
      expectedPlaintextSize: received,
    });
    return finish();
  } finally {
    await remote.transfer.deleteTemporary(firstTempId).catch(() => undefined);
    await remote.transfer.deleteTemporary(finalTempId).catch(() => undefined);
  }
}
