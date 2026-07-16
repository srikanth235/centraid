// governance: allow-repo-hygiene file-size-limit (#418) the ingress/direct/stream/outbox coordinator is one lifecycle boundary; splitting only its close fence would separate shutdown ordering from the runner it owns
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  rmSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BackupPolicy } from '../backup-policy.js';
import {
  asVaultDiskFullError,
  VaultBlobBackpressureError,
  VaultBlobHashMismatchError,
  VaultBlobSessionError,
} from '../errors.js';
import { uuidv7 } from '../ids.js';
import type { BlobCache } from './cache.js';
import { BlobContentKeyRegistry } from './content-keys.js';
import type { CustodyState, RemoteTier } from './custody-types.js';
import { IncrementalSha256, type SerializableSha256State } from './incremental-sha256.js';
import {
  DirectBlobTransfers,
  type DirectBlobDownloadResult,
  type DirectBlobInitInput,
  type DirectBlobInitResult,
} from './direct-transfers.js';
import { adoptAndStageFallbackIngress, stageCompletedIngress } from './fallback-finalize.js';
import { enqueueExistingLocalBlobs } from './existing-local.js';
import { assertSpoolAdmission, requireRemote } from './ingress-admission.js';
import type { LocalBlobStore } from './local.js';
import { streamThroughOnce } from './one-shot-stream.js';
import { streamThroughUnknownHash } from './unknown-hash-stream.js';
import { BlobOutboxRunner } from './outbox-runner.js';
import { preflightBlob, type BlobPreflightHint, type BlobPreflightResult } from './preflight.js';
import type { MultipartPart } from './remote-transfer.js';
import { auditRemoteBlob } from './remote-audit.js';
import type { IngressPreviewInput } from './preview.js';
import { recordKnownStagedBlob } from './staging-record.js';
import type { StagedBlob } from './staging.js';
import { assertSha } from './store.js';
import {
  RemoteStreamIngress,
  STREAM_INGRESS_CHUNK_BYTES,
  type StreamIngressStart,
} from './stream-ingress.js';
import { BlobTransferState, type IngressSessionRow } from './transfer-state.js';

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export interface BeginBlobIngressInput {
  expectedSha256?: string;
  expectedSize?: number;
  mediaType?: string;
  filename?: string;
  stagedBy?: string;
  /** The init/PATCH door may allocate a durable provider multipart session. */
  resumable?: boolean;
}

export type BeginBlobIngressResult =
  | {
      mode: 'spool';
      sessionId: string;
      offset: number;
      expiresAt: string;
      chunkSize: number;
    }
  | StreamIngressStart
  | { mode: 'one-shot-stream-through'; expectedSha256: string; expectedSize: number }
  | { mode: 'one-shot-hash-pending'; expectedSize: number }
  | { mode: 'existing'; staged: StagedBlob; custody: CustodyState };

export interface CommittedBlob extends StagedBlob {
  casAck: 'receipt' | 'replicated';
  custody: CustodyState;
}

export interface BlobTransferStatus {
  pendingCount: number;
  pendingBytes: number;
  uploadingCount: number;
  lastError: string | null;
}

export interface BlobTransferCoordinatorOptions {
  vault: DatabaseSync;
  dir: string;
  local: LocalBlobStore;
  cache: BlobCache;
  remote: () => RemoteTier | null;
  remoteConfigured: () => boolean;
  policy: () => BackupPolicy;
  contentKeys: BlobContentKeyRegistry;
  contributePreview?: (input: IngressPreviewInput) => void;
  drainIntervalMs?: number;
  streamChunkBytes?: number;
}

export class BlobTransferCoordinator {
  readonly state: BlobTransferState;
  private readonly listeners = new Set<(status: BlobTransferStatus) => void>();
  private readonly direct: DirectBlobTransfers;
  private readonly outbox: BlobOutboxRunner;
  private readonly stream: RemoteStreamIngress;

  constructor(private readonly options: BlobTransferCoordinatorOptions) {
    this.state = new BlobTransferState(options.vault);
    this.direct = new DirectBlobTransfers({
      vault: options.vault,
      cache: options.cache,
      remote: options.remote,
      contentKeys: options.contentKeys,
      state: this.state,
      preflight: (sha256) => this.preflight(sha256),
      emit: () => this.emit(),
    });
    this.outbox = new BlobOutboxRunner({
      state: this.state,
      local: options.local,
      cache: options.cache,
      remote: options.remote,
      onStatus: () => this.emit(),
      ...(options.drainIntervalMs ? { intervalMs: options.drainIntervalMs } : {}),
    });
    this.stream = new RemoteStreamIngress({
      vault: options.vault,
      state: this.state,
      cache: options.cache,
      remote: options.remote,
      policy: options.policy,
      contentKeys: options.contentKeys,
      dir: options.dir,
      ...(options.streamChunkBytes ? { chunkBytes: options.streamChunkBytes } : {}),
      ...(options.contributePreview ? { contributePreview: options.contributePreview } : {}),
      emit: () => this.emit(),
    });
  }

  status(): BlobTransferStatus {
    return this.state.status();
  }

  pendingSnapshotShas(): string[] {
    return this.state.pendingShas();
  }

  /** Seed durable obligations before an fs-only vault enables remote-primary. */
  enqueueExistingLocal(): number {
    const count = enqueueExistingLocalBlobs(this.options.vault, this.options.local, this.state);
    if (count > 0) this.emit();
    return count;
  }

  /** Remote identity changed; old target-scoped evidence is no longer valid. */
  resetRemoteEvidence(): void {
    this.options.cache.replica.clear();
  }

  /** Start/resume continuous drain after a settings transition. */
  kickOutbox(): void {
    this.outbox.kick();
  }

  subscribe(listener: (status: BlobTransferStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.status();
    for (const listener of this.listeners) listener(snapshot);
  }

  async preflight(sha256: string, hint: BlobPreflightHint = {}): Promise<BlobPreflightResult> {
    return preflightBlob(
      {
        vault: this.options.vault,
        local: this.options.local,
        cache: this.options.cache,
        remote: this.options.remote,
        state: this.state,
        verifyRemote: async (candidate, sealedSize) => {
          try {
            await this.auditRemoteReplica(candidate, sealedSize);
            return true;
          } catch {
            return false;
          }
        },
      },
      sha256,
      hint,
    );
  }

  /** Authenticated, range-bounded CAS audit: header, directory, first frame. */
  async auditRemoteReplica(sha256: string, knownSealedSize?: number): Promise<void> {
    await auditRemoteBlob({
      vault: this.options.vault,
      local: this.options.local,
      remote: this.options.remote(),
      sha256,
      ...(knownSealedSize === undefined ? {} : { knownSealedSize }),
    });
  }

  private availableForSpool(incoming: number, expectedShaSupplied: boolean): void {
    assertSpoolAdmission(
      {
        cache: this.options.cache,
        state: this.state,
        policy: this.options.policy,
        remoteConfigured: this.options.remoteConfigured,
      },
      incoming,
      expectedShaSupplied,
    );
  }

  async beginIngress(input: BeginBlobIngressInput): Promise<BeginBlobIngressResult> {
    if (input.expectedSha256) assertSha(input.expectedSha256);
    if (
      input.expectedSize !== undefined &&
      (!Number.isSafeInteger(input.expectedSize) || input.expectedSize < 0)
    ) {
      throw new Error('expectedSize must be a non-negative safe integer');
    }
    if (input.expectedSha256) {
      const existing = await this.preflight(input.expectedSha256);
      if (existing.custody === 'replicated' || existing.custody === 'remote-only') {
        return {
          mode: 'existing',
          custody: existing.custody,
          staged: recordKnownStagedBlob(this.options.vault, {
            sha256: input.expectedSha256,
            byteSize: input.expectedSize ?? 0,
            ...(input.mediaType ? { mediaType: input.mediaType } : {}),
            ...(input.filename ? { filename: input.filename } : {}),
            ...(input.stagedBy ? { stagedBy: input.stagedBy } : {}),
          }),
        };
      }
    }
    if (input.resumable && input.expectedSha256 && input.expectedSize !== undefined) {
      const resumed = this.state.openIngressSession({
        sha256: input.expectedSha256,
        expectedSize: input.expectedSize,
        ...(input.stagedBy ? { stagedBy: input.stagedBy } : {}),
      });
      if (resumed) {
        if (resumed.kind === 'stream-through') return this.stream.resume(resumed);
        return {
          mode: 'spool',
          sessionId: resumed.session_id,
          offset: resumed.received_bytes,
          expiresAt: resumed.expires_at,
          chunkSize: STREAM_INGRESS_CHUNK_BYTES,
        };
      }
    }
    if (input.expectedSize !== undefined) {
      try {
        this.availableForSpool(input.expectedSize, input.expectedSha256 !== undefined);
      } catch (error) {
        if (error instanceof VaultBlobBackpressureError) {
          const remote = await requireRemote(this.options.remote(), error, input.expectedSha256);
          if (input.expectedSha256 && input.resumable) {
            return this.stream.begin({
              sha256: input.expectedSha256,
              expectedSize: input.expectedSize,
              ...(input.mediaType ? { mediaType: input.mediaType } : {}),
              ...(input.filename ? { filename: input.filename } : {}),
              ...(input.stagedBy ? { stagedBy: input.stagedBy } : {}),
            });
          }
          if (input.expectedSha256) {
            return {
              mode: 'one-shot-stream-through',
              expectedSha256: input.expectedSha256,
              expectedSize: input.expectedSize,
            };
          }
          if (!input.resumable && remote.transfer.getTemporary && remote.keyFor) {
            return { mode: 'one-shot-hash-pending', expectedSize: input.expectedSize };
          }
        }
        throw error;
      }
    }
    const sessionId = uuidv7();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const root =
      this.options.dir === ':memory:'
        ? path.join(os.tmpdir(), 'centraid-blob-ingress')
        : path.join(this.options.dir, 'blob-ingress');
    mkdirSync(root, { recursive: true });
    const tempPath = path.join(root, `${sessionId}.part`);
    closeSync(openSync(tempPath, 'wx', 0o600));
    this.state.createSession({
      sessionId,
      kind: 'fallback',
      tempPath,
      expiresAt,
      hashState: new IncrementalSha256().exportState(),
      ...(input.expectedSha256 ? { expectedSha256: input.expectedSha256 } : {}),
      ...(input.expectedSize !== undefined ? { expectedSize: input.expectedSize } : {}),
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
      ...(input.filename ? { filename: input.filename } : {}),
      ...(input.stagedBy ? { stagedBy: input.stagedBy } : {}),
    });
    return {
      mode: 'spool',
      sessionId,
      offset: 0,
      expiresAt,
      chunkSize: STREAM_INGRESS_CHUNK_BYTES,
    };
  }

  async appendIngress(
    sessionId: string,
    offset: number,
    bytes: Buffer,
  ): Promise<{ offset: number }> {
    if (this.state.session(sessionId)?.kind === 'stream-through') {
      return this.stream.append(sessionId, offset, bytes);
    }
    const row = this.requireOpenFallback(sessionId);
    if (offset !== row.received_bytes) {
      throw new VaultBlobSessionError(
        `upload offset ${offset} does not match durable offset ${row.received_bytes}`,
        row.received_bytes,
      );
    }
    if (row.expected_size !== null && offset + bytes.length > row.expected_size) {
      throw new VaultBlobSessionError('chunk exceeds the declared upload size', row.received_bytes);
    }
    if (row.expected_size === null)
      this.availableForSpool(bytes.length, row.expected_sha256 !== null);
    const state = new IncrementalSha256(
      JSON.parse(row.hash_state_json ?? '{}') as SerializableSha256State,
    );
    state.update(bytes);
    try {
      truncateSync(row.temp_path!, row.received_bytes); // heal a crash after fsync/before DB update
      const fd = openSync(row.temp_path!, 'r+');
      try {
        writeSync(fd, bytes, 0, bytes.length, row.received_bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      throw asVaultDiskFullError('resumable blob ingress', error);
    }
    const next = row.received_bytes + bytes.length;
    this.state.recordAppend(sessionId, next, state.exportState());
    return { offset: next };
  }

  async commitIngress(sessionId: string): Promise<CommittedBlob> {
    let row = this.state.session(sessionId);
    if (!row) throw new VaultBlobSessionError(`unknown upload session ${sessionId}`);
    if (row.state === 'complete' && row.expected_sha256) {
      let custody = (await this.preflight(row.expected_sha256)).custody;
      if (row.kind === 'fallback' && custody === 'local-only' && this.options.remoteConfigured()) {
        this.recordLocalReceipt(row.expected_sha256, row.received_bytes);
        custody = 'pending-offsite';
      }
      return {
        ...stageCompletedIngress(this.options.vault, row, row.expected_sha256),
        casAck: this.options.policy().casAck,
        custody,
      };
    }
    if (row.kind === 'stream-through') return this.stream.commit(sessionId);
    if (row.kind !== 'fallback' || (row.state !== 'open' && row.state !== 'committing')) {
      throw new VaultBlobSessionError(`upload session ${sessionId} is ${row.state}`);
    }
    if (row.expected_size !== null && row.received_bytes !== row.expected_size) {
      throw new VaultBlobSessionError(
        `upload is incomplete: have ${row.received_bytes}, expected ${row.expected_size}`,
        row.received_bytes,
      );
    }
    const hash = new IncrementalSha256(
      JSON.parse(row.hash_state_json ?? '{}') as SerializableSha256State,
    ).digestHex();
    if (row.expected_sha256 && hash !== row.expected_sha256) {
      if (row.state === 'open') await this.abortIngress(sessionId);
      throw new VaultBlobHashMismatchError(row.expected_sha256, hash);
    }

    row = this.state.beginFallbackCommit(sessionId, hash);
    const staged = adoptAndStageFallbackIngress({
      vault: this.options.vault,
      local: this.options.local,
      cache: this.options.cache,
      row,
      sha256: hash,
      ...(this.options.contributePreview
        ? { contributePreview: this.options.contributePreview }
        : {}),
    });
    this.recordLocalReceipt(hash, row.received_bytes);
    this.state.completeSession(sessionId, hash);
    const custody: CustodyState = this.options.remoteConfigured()
      ? 'pending-offsite'
      : 'local-only';
    return { ...staged, casAck: this.options.policy().casAck, custody };
  }

  async abortIngress(sessionId: string): Promise<void> {
    const row = this.state.session(sessionId);
    if (!row) return;
    this.state.setSessionState(sessionId, 'aborted');
    if (row.temp_path) rmSync(row.temp_path, { force: true });
    if (row.remote_temp_id && row.remote_upload_id) {
      await this.options
        .remote()
        ?.transfer?.abortTemporaryUpload(row.remote_temp_id, row.remote_upload_id)
        .catch(() => undefined);
    }
  }

  /** All synchronous legacy ingress paths join the same eager outbox. */
  recordLocalReceipt(sha256: string, byteSize: number): void {
    if (!this.options.remoteConfigured()) return;
    this.state.enqueue(assertSha(sha256), byteSize);
    this.emit();
    this.outbox.kick();
  }

  async streamThrough(
    input: BeginBlobIngressInput & { expectedSize: number },
    source: NodeJS.ReadableStream,
  ): Promise<CommittedBlob> {
    const deps = {
      vault: this.options.vault,
      cache: this.options.cache,
      remote: this.options.remote,
      policy: this.options.policy,
      ...(this.options.contributePreview
        ? { contributePreview: this.options.contributePreview }
        : {}),
      emit: () => this.emit(),
    };
    return input.expectedSha256
      ? streamThroughOnce(
          deps,
          input as BeginBlobIngressInput & { expectedSha256: string; expectedSize: number },
          source,
        )
      : streamThroughUnknownHash(deps, input, source);
  }

  async beginDirect(input: DirectBlobInitInput): Promise<DirectBlobInitResult> {
    return this.direct.begin(input);
  }

  async completeDirect(
    sessionId: string,
    deviceIdentity: string,
    parts: readonly MultipartPart[] = [],
  ): Promise<CommittedBlob> {
    return this.direct.complete(sessionId, deviceIdentity, parts);
  }

  recordDirectPart(
    sessionId: string,
    partNumber: number,
    etag: string,
    deviceIdentity: string,
  ): MultipartPart[] {
    return this.direct.recordPart(sessionId, partNumber, etag, deviceIdentity);
  }

  async directDownload(sha256: string, deviceId: string): Promise<DirectBlobDownloadResult> {
    return this.direct.download(sha256, deviceId);
  }

  enrollPairedDevice(input: Parameters<BlobContentKeyRegistry['enrollPairedDevice']>[0]): string {
    return this.options.contentKeys.enrollPairedDevice(input);
  }

  revokePairedDevice(identity: string): number {
    return this.options.contentKeys.revokeDevice(identity);
  }

  private requireOpenFallback(sessionId: string): IngressSessionRow {
    const row = this.state.session(sessionId);
    if (!row || row.kind !== 'fallback' || row.state !== 'open' || !row.temp_path) {
      throw new VaultBlobSessionError(`unknown or closed fallback session ${sessionId}`);
    }
    return row;
  }

  async close(): Promise<void> {
    await this.outbox.close();
  }

  /** Fence asynchronous transfer completion before a synchronous SQLite close. */
  abandon(): void {
    this.outbox.abandon();
  }
}
