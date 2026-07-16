import type { DatabaseSync } from 'node:sqlite';
import {
  VaultBlobAuthorizationError,
  VaultBlobRemoteUnavailableError,
  VaultBlobSessionError,
} from '../errors.js';
import { uuidv7 } from '../ids.js';
import type { BlobCache } from './cache.js';
import { BlobContentKeyRegistry, type DeviceWrappedContentKey } from './content-keys.js';
import type { CustodyState, RemoteTier } from './custody-types.js';
import type { MultipartPart } from './remote-transfer.js';
import { verifyRemoteSealedObject } from './remote-verify.js';
import { recordKnownStagedBlob } from './staging-record.js';
import { assertSha } from './store.js';
import type { BlobTransferState } from './transfer-state.js';
import type { CommittedBlob } from './transfers.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export interface DirectBlobInitInput {
  sha256: string;
  plaintextSize: number;
  sealedSize: number;
  partCount?: number;
  mediaType?: string;
  filename?: string;
  stagedBy?: string;
  deviceId: string;
}

export interface DirectBlobInitResult {
  sessionId?: string;
  alreadyPresent: boolean;
  custody: CustodyState;
  contentKey: DeviceWrappedContentKey;
  /** Raw per-blob key, only on this authenticated gateway response (never URL/object). */
  keyBase64: string;
  completedParts: MultipartPart[];
  upload?:
    | { kind: 'single'; url: string }
    | { kind: 'multipart'; uploadId: string; parts: { partNumber: number; url: string }[] };
}

export interface DirectBlobDownloadResult {
  url: string;
  contentKey: DeviceWrappedContentKey;
  keyBase64: string;
}

export interface DirectBlobTransferDeps {
  vault: DatabaseSync;
  cache: BlobCache;
  remote: () => RemoteTier | null;
  contentKeys: BlobContentKeyRegistry;
  state: BlobTransferState;
  preflight(
    sha256: string,
  ): Promise<{ exists: boolean; custody: CustodyState; remoteAvailable: boolean }>;
  emit(): void;
}

export class DirectBlobTransfers {
  constructor(private readonly deps: DirectBlobTransferDeps) {}

  async begin(input: DirectBlobInitInput): Promise<DirectBlobInitResult> {
    const sha = assertSha(input.sha256);
    const deviceId = this.deps.contentKeys.resolvePairedDevice(input.deviceId);
    const grant = this.deps.contentKeys.grantToDevice(sha, deviceId);
    const keyBase64 = this.deps.contentKeys.getOrCreate(sha).toString('base64');
    const remote = this.deps.remote();
    if (!remote?.transfer || !remote.keyFor) {
      throw new VaultBlobRemoteUnavailableError(
        'direct edge-sealed upload requires an available encrypted S3 transfer tier',
      );
    }
    const partCount = input.partCount ?? 1;
    if (!Number.isSafeInteger(partCount) || partCount < 1 || partCount > 10_000) {
      throw new Error('direct upload partCount must be between 1 and 10000');
    }
    const resumed = this.deps.state.openDirectSession({
      sha256: sha,
      plaintextSize: input.plaintextSize,
      sealedSize: input.sealedSize,
      partCount,
      deviceId,
    });
    if (resumed) return this.resumeResult(resumed, remote, grant, keyBase64);
    const existing = await this.deps.preflight(sha);
    if (!existing.remoteAvailable) {
      throw new VaultBlobRemoteUnavailableError();
    }
    if (existing.custody === 'replicated' || existing.custody === 'remote-only') {
      return {
        alreadyPresent: true,
        custody: existing.custody,
        contentKey: grant,
        keyBase64,
        completedParts: [],
      };
    }
    const sessionId = uuidv7();
    const tempId = `direct-${sessionId}`;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    if (partCount === 1) {
      this.createSession(input, deviceId, sessionId, tempId, expiresAt, partCount);
      const url = await remote.transfer.presignTemporaryPut(tempId);
      return {
        sessionId,
        alreadyPresent: false,
        custody: 'pending-offsite',
        contentKey: grant,
        keyBase64,
        completedParts: [],
        upload: { kind: 'single', url: url.toString() },
      };
    }
    const uploadId = await remote.transfer.beginTemporaryUpload(tempId);
    this.createSession(input, deviceId, sessionId, tempId, expiresAt, partCount, uploadId);
    const parts = await Promise.all(
      Array.from({ length: partCount }, async (_, index) => ({
        partNumber: index + 1,
        url: (await remote.transfer!.presignTemporaryPart(tempId, uploadId, index + 1)).toString(),
      })),
    );
    return {
      sessionId,
      alreadyPresent: false,
      custody: 'pending-offsite',
      contentKey: grant,
      keyBase64,
      completedParts: [],
      upload: { kind: 'multipart', uploadId, parts },
    };
  }

  private createSession(
    input: DirectBlobInitInput,
    deviceId: string,
    sessionId: string,
    tempId: string,
    expiresAt: string,
    partCount: number,
    remoteUploadId?: string,
  ): void {
    this.deps.state.createSession({
      sessionId,
      kind: 'direct',
      expectedSha256: input.sha256,
      expectedSize: input.plaintextSize,
      sealedSize: input.sealedSize,
      remoteTempId: tempId,
      expiresAt,
      partCount,
      deviceId,
      ...(remoteUploadId ? { remoteUploadId } : {}),
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
      ...(input.filename ? { filename: input.filename } : {}),
      ...(input.stagedBy ? { stagedBy: input.stagedBy } : {}),
    });
  }

  private async resumeResult(
    row: import('./transfer-state.js').IngressSessionRow,
    remote: NonNullable<ReturnType<DirectBlobTransferDeps['remote']>>,
    contentKey: DeviceWrappedContentKey,
    keyBase64: string,
  ): Promise<DirectBlobInitResult> {
    const completedParts = this.parts(row.remote_parts_json);
    if (!row.remote_temp_id) throw new Error('direct session has no remote temp id');
    if (!row.remote_upload_id) {
      return {
        sessionId: row.session_id,
        alreadyPresent: false,
        custody: 'pending-offsite',
        contentKey,
        keyBase64,
        completedParts,
        upload: {
          kind: 'single',
          url: (await remote.transfer!.presignTemporaryPut(row.remote_temp_id)).toString(),
        },
      };
    }
    const done = new Set(completedParts.map((part) => part.partNumber));
    const missing = Array.from({ length: row.part_count ?? 1 }, (_, index) => index + 1).filter(
      (partNumber) => !done.has(partNumber),
    );
    const parts = await Promise.all(
      missing.map(async (partNumber) => ({
        partNumber,
        url: (
          await remote.transfer!.presignTemporaryPart(
            row.remote_temp_id!,
            row.remote_upload_id!,
            partNumber,
          )
        ).toString(),
      })),
    );
    return {
      sessionId: row.session_id,
      alreadyPresent: false,
      custody: 'pending-offsite',
      contentKey,
      keyBase64,
      completedParts,
      upload: { kind: 'multipart', uploadId: row.remote_upload_id, parts },
    };
  }

  private parts(json: string): MultipartPart[] {
    try {
      const value = JSON.parse(json) as unknown;
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

  recordPart(
    sessionId: string,
    partNumber: number,
    etag: string,
    deviceIdentity: string,
  ): MultipartPart[] {
    const row = this.deps.state.session(sessionId);
    if (!row || row.kind !== 'direct' || row.state !== 'open' || !row.remote_upload_id) {
      throw new VaultBlobSessionError(`unknown or closed multipart direct session ${sessionId}`);
    }
    this.assertSessionDevice(row, deviceIdentity);
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > (row.part_count ?? 0)) {
      throw new VaultBlobSessionError(`part ${partNumber} is outside this session's part range`);
    }
    if (!etag) throw new VaultBlobSessionError('multipart ETag is required');
    const byNumber = new Map(
      this.parts(row.remote_parts_json).map((part) => [part.partNumber, part]),
    );
    byNumber.set(partNumber, { partNumber, etag });
    const parts = [...byNumber.values()].sort((a, b) => a.partNumber - b.partNumber);
    this.deps.state.setDirectParts(sessionId, parts);
    return parts;
  }

  async complete(
    sessionId: string,
    deviceIdentity: string,
    parts: readonly MultipartPart[] = [],
  ): Promise<CommittedBlob> {
    const row = this.deps.state.session(sessionId);
    if (!row || row.kind !== 'direct' || (row.state !== 'open' && row.state !== 'committing')) {
      throw new VaultBlobSessionError(`unknown or closed direct session ${sessionId}`);
    }
    this.assertSessionDevice(row, deviceIdentity);
    const remote = this.deps.remote();
    if (!remote?.transfer || !row.remote_temp_id || !row.expected_sha256) {
      throw new Error('direct session remote tier is unavailable');
    }
    const merged = new Map(
      this.parts(row.remote_parts_json).map((part) => [part.partNumber, part]),
    );
    for (const part of parts) {
      if (
        !Number.isInteger(part.partNumber) ||
        part.partNumber < 1 ||
        part.partNumber > (row.part_count ?? 1) ||
        !part.etag
      ) {
        throw new VaultBlobSessionError('multipart completion contains an invalid part receipt');
      }
      merged.set(part.partNumber, part);
    }
    const allParts = [...merged.values()].sort((a, b) => a.partNumber - b.partNumber);
    let temp = await remote.transfer.statTemporary(row.remote_temp_id);
    if (!temp && row.remote_upload_id) {
      if (allParts.length !== row.part_count) {
        throw new Error(
          `multipart completion has ${allParts.length}/${row.part_count} part receipts`,
        );
      }
      this.deps.state.setDirectParts(sessionId, allParts);
      this.deps.state.setSessionState(sessionId, 'committing');
      await remote.transfer.completeTemporaryUpload(
        row.remote_temp_id,
        row.remote_upload_id,
        allParts,
      );
      temp = await remote.transfer.statTemporary(row.remote_temp_id);
    } else {
      this.deps.state.setSessionState(sessionId, 'committing');
    }
    if (!temp || (row.sealed_size !== null && temp.size !== row.sealed_size)) {
      throw new Error(
        `direct upload size mismatch: expected ${row.sealed_size ?? 'an object'}, got ${temp?.size ?? 'missing'}`,
      );
    }
    const byteSize = row.expected_size ?? 0;
    // Direct-to-cold heuristic (issue #425 Wave 3): the CopyObject that mints
    // the final CAS object carries STANDARD_IA for an eligible large original.
    // The staging row is written after custody, so the declared media type +
    // size are handed in directly for the resolver (a session without a declared
    // media type falls back to the DB lookup, which is empty ⇒ class-less).
    const storageClass = remote.storageClassFor?.(
      row.expected_sha256,
      'cas',
      row.media_type ? { mediaType: row.media_type, byteSize } : undefined,
    );
    await remote.transfer.copyTemporaryToSha(row.remote_temp_id, row.expected_sha256, storageClass);
    const final = await remote.store.stat(row.expected_sha256);
    if (!final || final.size !== temp.size)
      throw new Error('provider HEAD did not confirm final object');
    await verifyRemoteSealedObject({
      store: remote.store,
      sha256: row.expected_sha256,
      key: this.deps.contentKeys.getOrCreate(row.expected_sha256),
      sealedSize: final.size,
      expectedPlaintextSize: byteSize,
    });
    this.deps.cache.replica.mark(row.expected_sha256, byteSize);
    this.deps.state.completeSession(sessionId, row.expected_sha256);
    await remote.transfer.deleteTemporary(row.remote_temp_id).catch(() => undefined);
    const staged = recordKnownStagedBlob(this.deps.vault, {
      sha256: row.expected_sha256,
      byteSize,
      ...(row.media_type ? { mediaType: row.media_type } : {}),
      ...(row.original_name ? { filename: row.original_name } : {}),
      ...(row.staged_by ? { stagedBy: row.staged_by } : {}),
    });
    this.deps.emit();
    return { ...staged, casAck: 'replicated', custody: 'remote-only' };
  }

  async download(sha256: string, deviceId: string): Promise<DirectBlobDownloadResult> {
    const sha = assertSha(sha256);
    const resolvedDeviceId = this.deps.contentKeys.resolvePairedDevice(deviceId);
    const remote = this.deps.remote();
    if (!remote?.transfer || !(await remote.store.stat(sha)))
      throw new Error('remote blob not found');
    return {
      url: (await remote.transfer.presignShaGet(sha)).toString(),
      contentKey: this.deps.contentKeys.grantToDevice(sha, resolvedDeviceId),
      keyBase64: this.deps.contentKeys.getOrCreate(sha).toString('base64'),
    };
  }

  private assertSessionDevice(
    row: import('./transfer-state.js').IngressSessionRow,
    deviceIdentity: string,
  ): void {
    const deviceId = this.deps.contentKeys.resolvePairedDevice(deviceIdentity);
    if (!row.device_id || row.device_id !== deviceId) {
      throw new VaultBlobAuthorizationError('direct session belongs to another paired device');
    }
  }
}
