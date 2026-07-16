import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { BackupPolicy } from '../backup-policy.js';
import { VaultBlobHashMismatchError, VaultBlobSessionError } from '../errors.js';
import { uuidv7 } from '../ids.js';
import type { BlobCache } from './cache.js';
import type { BlobContentKeyRegistry } from './content-keys.js';
import { remoteEncryptionKey, type RemoteTier } from './custody-types.js';
import { IncrementalSha256, type SerializableSha256State } from './incremental-sha256.js';
import { extractBlobMetaFromProbes, sniffMediaType } from './pipeline.js';
import { INGRESS_PREVIEW_MAX_BYTES, type IngressPreviewInput } from './preview.js';
import type { MultipartPart } from './remote-transfer.js';
import { verifyRemoteSealedObject } from './remote-verify.js';
import {
  DEFAULT_FRAME_SIZE,
  encodeHeader,
  encodeTrailer,
  frameCountFor,
  sealDirectory,
  sealStoredFrame,
} from './seal-frames.js';
import { recordKnownStagedBlob } from './staging-record.js';
import { mediaLocationPolicyForVault } from './staging.js';
import type { CommittedBlob } from './transfers.js';
import type { BlobTransferState, IngressSessionRow } from './transfer-state.js';

export const STREAM_INGRESS_CHUNK_BYTES = 16 * 1024 * 1024;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const PROBE_HEAD_BYTES = 1024 * 1024;
const PROBE_TAIL_BYTES = 8 * 1024 * 1024;

interface StreamMeta {
  frameSize: number;
  sealedLens: number[];
  sealedBytes: number;
}

export interface StreamIngressStart {
  mode: 'stream-through';
  sessionId: string;
  offset: number;
  expiresAt: string;
  chunkSize: number;
}

interface StreamIngressDeps {
  vault: DatabaseSync;
  state: BlobTransferState;
  cache: BlobCache;
  remote: () => RemoteTier | null;
  policy: () => BackupPolicy;
  contentKeys: BlobContentKeyRegistry;
  dir: string;
  chunkBytes?: number;
  contributePreview?: (input: IngressPreviewInput) => void;
  emit(): void;
}

function parseParts(json: string): MultipartPart[] {
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

function parseMeta(row: IngressSessionRow): StreamMeta {
  const value = JSON.parse(row.meta_json) as Partial<StreamMeta>;
  if (
    !Number.isSafeInteger(value.frameSize) ||
    value.frameSize! <= 0 ||
    !Array.isArray(value.sealedLens) ||
    !value.sealedLens.every((length) => Number.isSafeInteger(length) && length > 0) ||
    !Number.isSafeInteger(value.sealedBytes) ||
    value.sealedBytes! < 0
  ) {
    throw new VaultBlobSessionError(
      `stream-through session ${row.session_id} has invalid metadata`,
    );
  }
  return value as StreamMeta;
}

export class RemoteStreamIngress {
  private readonly chunkBytes: number;

  constructor(private readonly deps: StreamIngressDeps) {
    this.chunkBytes = deps.chunkBytes ?? STREAM_INGRESS_CHUNK_BYTES;
    if (!Number.isSafeInteger(this.chunkBytes) || this.chunkBytes <= 0) {
      throw new Error('stream ingress chunk size must be a positive safe integer');
    }
  }

  async begin(input: {
    sha256: string;
    expectedSize: number;
    mediaType?: string;
    filename?: string;
    stagedBy?: string;
  }): Promise<StreamIngressStart> {
    const sessionId = uuidv7();
    const tempId = `stream-${sessionId}`;
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    const remote = this.requireRemote(input.sha256);
    const frameSize = remote.frameSize ?? DEFAULT_FRAME_SIZE;
    if (this.chunkBytes % frameSize !== 0) {
      throw new Error('stream ingress chunk size must align to the CBSF frame size');
    }
    const row = this.deps.state.createSession({
      sessionId,
      kind: 'stream-through',
      expectedSha256: input.sha256,
      expectedSize: input.expectedSize,
      remoteTempId: tempId,
      expiresAt,
      partCount: Math.max(1, Math.ceil(input.expectedSize / this.chunkBytes)),
      hashState: new IncrementalSha256().exportState(),
      ...(input.mediaType ? { mediaType: input.mediaType } : {}),
      ...(input.filename ? { filename: input.filename } : {}),
      ...(input.stagedBy ? { stagedBy: input.stagedBy } : {}),
    });
    this.deps.state.recordRemoteAppend({
      sessionId,
      receivedBytes: 0,
      hashState: new IncrementalSha256().exportState(),
      parts: [],
      meta: { frameSize, sealedLens: [], sealedBytes: 0 },
    });
    await this.ensureUpload(row);
    return { mode: 'stream-through', sessionId, offset: 0, expiresAt, chunkSize: this.chunkBytes };
  }

  async resume(row: IngressSessionRow): Promise<StreamIngressStart> {
    await this.ensureUpload(row);
    return {
      mode: 'stream-through',
      sessionId: row.session_id,
      offset: row.received_bytes,
      expiresAt: row.expires_at,
      chunkSize: this.chunkBytes,
    };
  }

  async append(sessionId: string, offset: number, bytes: Buffer): Promise<{ offset: number }> {
    const row = this.requireSession(sessionId, 'open');
    if (offset !== row.received_bytes) {
      throw new VaultBlobSessionError(
        `upload offset ${offset} does not match durable offset ${row.received_bytes}`,
        row.received_bytes,
      );
    }
    const expectedSize = row.expected_size!;
    const chunkLength = Math.min(this.chunkBytes, expectedSize - offset);
    if (bytes.length !== chunkLength) {
      throw new VaultBlobSessionError(
        `stream-through chunks are fixed at ${this.chunkBytes} bytes except the final chunk; expected ${chunkLength}`,
        row.received_bytes,
      );
    }
    const sha = row.expected_sha256!;
    const remote = this.requireRemote(sha);
    const uploadId = await this.ensureUpload(row);
    const meta = parseMeta(this.deps.state.session(sessionId)!);
    const frameCount = frameCountFor(expectedSize, meta.frameSize);
    const startFrame = Math.floor(offset / meta.frameSize);
    if (startFrame !== meta.sealedLens.length) {
      throw new VaultBlobSessionError('stream-through frame ledger does not match its byte offset');
    }
    const state = new IncrementalSha256(
      JSON.parse(row.hash_state_json ?? '{}') as SerializableSha256State,
    );
    state.update(bytes);
    const nextOffset = offset + bytes.length;
    if (nextOffset === expectedSize) {
      const actual = new IncrementalSha256(state.exportState()).digestHex();
      if (actual !== sha) throw new VaultBlobHashMismatchError(sha, actual);
    }
    const key = remoteEncryptionKey(remote, sha)!;
    const sealedFrames: Buffer[] = [];
    const newLens: number[] = [];
    for (let at = 0, index = startFrame; at < bytes.length; index += 1) {
      const frame = bytes.subarray(at, Math.min(at + meta.frameSize, bytes.length));
      const sealed = sealStoredFrame(key, sha, index, frameCount, frame);
      sealedFrames.push(sealed);
      newLens.push(sealed.length);
      at += frame.length;
    }
    const sealedLens = [...meta.sealedLens, ...newLens];
    const body: Buffer[] = offset === 0 ? [encodeHeader(sha), ...sealedFrames] : sealedFrames;
    if (nextOffset === expectedSize) {
      const directory = sealDirectory(
        key,
        sha,
        frameCount,
        meta.frameSize,
        expectedSize,
        sealedLens,
      );
      body.push(directory, encodeTrailer(directory.length, frameCount));
    }
    const partBytes = Buffer.concat(body);
    const partNumber = Math.floor(offset / this.chunkBytes) + 1;
    this.spoolPreview(row, offset, bytes);
    const etag = await remote.transfer!.uploadTemporaryPart(
      row.remote_temp_id!,
      uploadId,
      partNumber,
      partBytes,
    );
    if (offset === 0) {
      this.deps.state.recordProbe(sessionId, 'head', bytes.subarray(0, PROBE_HEAD_BYTES));
    }
    if (nextOffset === expectedSize) {
      this.deps.state.recordProbe(
        sessionId,
        'tail',
        bytes.subarray(Math.max(0, bytes.length - PROBE_TAIL_BYTES)),
      );
    }
    const byNumber = new Map(
      parseParts(row.remote_parts_json).map((part) => [part.partNumber, part]),
    );
    byNumber.set(partNumber, { partNumber, etag });
    this.deps.state.recordRemoteAppend({
      sessionId,
      receivedBytes: nextOffset,
      hashState: state.exportState(),
      parts: [...byNumber.values()].sort((a, b) => a.partNumber - b.partNumber),
      meta: {
        ...meta,
        sealedLens,
        sealedBytes: meta.sealedBytes + partBytes.length,
      },
    });
    return { offset: nextOffset };
  }

  async commit(sessionId: string): Promise<CommittedBlob> {
    let row = this.requireSession(sessionId, 'open', 'committing');
    const sha = row.expected_sha256!;
    const expectedSize = row.expected_size!;
    if (
      expectedSize === 0 &&
      row.received_bytes === 0 &&
      parseParts(row.remote_parts_json).length === 0
    ) {
      await this.appendEmpty(row);
      row = this.requireSession(sessionId, 'open');
    }
    if (row.received_bytes !== expectedSize) {
      throw new VaultBlobSessionError(
        `upload is incomplete: have ${row.received_bytes}, expected ${expectedSize}`,
        row.received_bytes,
      );
    }
    const state = new IncrementalSha256(
      JSON.parse(row.hash_state_json ?? '{}') as SerializableSha256State,
    );
    const actual = state.digestHex();
    if (actual !== sha) throw new VaultBlobHashMismatchError(sha, actual);
    const remote = this.requireRemote(sha);
    const meta = parseMeta(row);
    const parts = parseParts(row.remote_parts_json).sort((a, b) => a.partNumber - b.partNumber);
    if (parts.length !== row.part_count) {
      throw new VaultBlobSessionError(
        `multipart completion has ${parts.length}/${row.part_count} parts`,
      );
    }
    this.deps.state.setSessionState(sessionId, 'committing');
    let temp = await remote.transfer!.statTemporary(row.remote_temp_id!);
    if (!temp) {
      await remote.transfer!.completeTemporaryUpload(
        row.remote_temp_id!,
        row.remote_upload_id!,
        parts,
      );
      temp = await remote.transfer!.statTemporary(row.remote_temp_id!);
    }
    if (!temp || temp.size !== meta.sealedBytes) {
      throw new Error(
        `stream-through provider size mismatch: expected ${meta.sealedBytes}, got ${temp?.size ?? 'missing'}`,
      );
    }
    await remote.transfer!.copyTemporaryToSha(row.remote_temp_id!, sha);
    const final = await remote.store.stat(sha);
    if (!final || final.size !== temp.size)
      throw new Error('provider HEAD did not confirm final object');
    await verifyRemoteSealedObject({
      store: remote.store,
      sha256: sha,
      key: remoteEncryptionKey(remote, sha)!,
      sealedSize: final.size,
      expectedPlaintextSize: expectedSize,
    });
    this.deps.cache.replica.mark(sha, expectedSize);
    this.deps.state.completeSession(sessionId, sha);
    await remote.transfer!.deleteTemporary(row.remote_temp_id!).catch(() => undefined);
    const probes = this.deps.state.probes(sessionId);
    const mediaType = sniffMediaType(
      probes.head,
      row.media_type ?? undefined,
      row.original_name ?? undefined,
    );
    const staged = recordKnownStagedBlob(this.deps.vault, {
      sha256: sha,
      byteSize: expectedSize,
      mediaType,
      meta: extractBlobMetaFromProbes(probes.head, probes.tail, mediaType, {
        keepLocation: mediaLocationPolicyForVault(this.deps.vault) !== 'strip',
      }),
      ...(row.original_name ? { filename: row.original_name } : {}),
      ...(row.staged_by ? { stagedBy: row.staged_by } : {}),
    });
    this.contributePreview(row, sha, mediaType);
    this.deps.emit();
    return { ...staged, casAck: this.deps.policy().casAck, custody: 'remote-only' };
  }

  private async appendEmpty(row: IngressSessionRow): Promise<void> {
    const sha = row.expected_sha256!;
    const remote = this.requireRemote(sha);
    const key = remoteEncryptionKey(remote, sha)!;
    const uploadId = await this.ensureUpload(row);
    const meta = parseMeta(this.deps.state.session(row.session_id)!);
    const directory = sealDirectory(key, sha, 0, meta.frameSize, 0, []);
    const bytes = Buffer.concat([encodeHeader(sha), directory, encodeTrailer(directory.length, 0)]);
    const etag = await remote.transfer!.uploadTemporaryPart(
      row.remote_temp_id!,
      uploadId,
      1,
      bytes,
    );
    this.deps.state.recordRemoteAppend({
      sessionId: row.session_id,
      receivedBytes: 0,
      hashState: new IncrementalSha256().exportState(),
      parts: [{ partNumber: 1, etag }],
      meta: { ...meta, sealedBytes: bytes.length },
    });
  }

  private requireRemote(sha256: string): RemoteTier {
    const remote = this.deps.remote();
    if (!remote?.transfer || !remoteEncryptionKey(remote, sha256)) {
      throw new Error('resumable stream-through requires an encrypted multipart remote tier');
    }
    return remote;
  }

  private async ensureUpload(row: IngressSessionRow): Promise<string> {
    if (row.remote_upload_id) return row.remote_upload_id;
    const remote = this.requireRemote(row.expected_sha256!);
    const uploadId = await remote.transfer!.beginTemporaryUpload(row.remote_temp_id!);
    this.deps.state.setSessionUpload(row.session_id, uploadId);
    return uploadId;
  }

  private spoolPreview(row: IngressSessionRow, offset: number, bytes: Buffer): void {
    if (!this.deps.contributePreview || row.expected_size! > INGRESS_PREVIEW_MAX_BYTES) return;
    let previewPath = row.temp_path;
    if (offset === 0) {
      const type = sniffMediaType(
        bytes.subarray(0, PROBE_HEAD_BYTES),
        row.media_type ?? undefined,
        row.original_name ?? undefined,
      );
      if (!type.startsWith('image/')) return;
      const root =
        this.deps.dir === ':memory:'
          ? path.join(os.tmpdir(), 'centraid-ingress-previews')
          : path.join(this.deps.dir, 'blob-ingress-previews');
      mkdirSync(root, { recursive: true });
      previewPath = path.join(root, `${row.session_id}.part`);
      closeSync(openSync(previewPath, 'a', 0o600));
      this.deps.state.setSessionTempPath(row.session_id, previewPath);
    }
    if (!previewPath) return;
    try {
      truncateSync(previewPath, offset);
      const fd = openSync(previewPath, 'r+');
      try {
        writeSync(fd, bytes, 0, bytes.length, offset);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      rmSync(previewPath, { force: true });
      this.deps.state.setSessionTempPath(row.session_id, null);
    }
  }

  private contributePreview(row: IngressSessionRow, sha256: string, mediaType: string): void {
    if (!this.deps.contributePreview || !row.temp_path) return;
    try {
      const bytes = readFileSync(row.temp_path);
      this.deps.contributePreview({
        sha256,
        bytes,
        mediaType,
        ...(row.staged_by ? { stagedBy: row.staged_by } : {}),
      });
    } catch {
      // Preview generation is a bounded best-effort contribution, not custody.
    } finally {
      rmSync(row.temp_path, { force: true });
      this.deps.state.setSessionTempPath(row.session_id, null);
    }
  }

  private requireSession(
    sessionId: string,
    ...states: IngressSessionRow['state'][]
  ): IngressSessionRow {
    const row = this.deps.state.session(sessionId);
    if (
      !row ||
      row.kind !== 'stream-through' ||
      !states.includes(row.state) ||
      !row.expected_sha256 ||
      row.expected_size === null ||
      !row.remote_temp_id
    ) {
      throw new VaultBlobSessionError(`unknown or closed stream-through session ${sessionId}`);
    }
    return row;
  }
}
