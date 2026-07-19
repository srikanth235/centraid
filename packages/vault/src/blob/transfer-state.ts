import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../ids.js';
import type { MultipartPart } from './remote-transfer.js';
import type { SerializableSha256State } from './incremental-sha256.js';

export interface IngressSessionRow {
  session_id: string;
  kind: 'fallback' | 'stream-through' | 'direct';
  state: 'open' | 'committing' | 'complete' | 'aborted';
  expected_sha256: string | null;
  expected_size: number | null;
  received_bytes: number;
  hash_state_json: string | null;
  temp_path: string | null;
  remote_temp_id: string | null;
  remote_upload_id: string | null;
  remote_parts_json: string;
  media_type: string | null;
  original_name: string | null;
  meta_json: string;
  staged_by: string | null;
  sealed_size: number | null;
  part_count: number | null;
  device_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

export interface OutboxRow {
  sha256: string;
  byte_size: number;
  state: 'pending' | 'uploading';
  temp_id: string | null;
  upload_id: string | null;
  parts_json: string;
  attempt_count: number;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateIngressSession {
  sessionId: string;
  kind: 'fallback' | 'stream-through' | 'direct';
  expectedSha256?: string;
  expectedSize?: number;
  tempPath?: string;
  remoteTempId?: string;
  remoteUploadId?: string;
  mediaType?: string;
  filename?: string;
  stagedBy?: string;
  sealedSize?: number;
  partCount?: number;
  deviceId?: string;
  expiresAt: string;
  hashState?: SerializableSha256State;
}

export class BlobTransferState {
  constructor(private readonly db: DatabaseSync) {}

  createSession(input: CreateIngressSession): IngressSessionRow {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO blob_ingress_session
           (session_id, kind, state, expected_sha256, expected_size, received_bytes,
            hash_state_json, temp_path, remote_temp_id, remote_upload_id,
            remote_parts_json, media_type, original_name, meta_json, staged_by,
            sealed_size, part_count, device_id, created_at, updated_at, expires_at)
         VALUES (?, ?, 'open', ?, ?, 0, ?, ?, ?, ?, '[]', ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.sessionId,
        input.kind,
        input.expectedSha256 ?? null,
        input.expectedSize ?? null,
        input.hashState ? JSON.stringify(input.hashState) : null,
        input.tempPath ?? null,
        input.remoteTempId ?? null,
        input.remoteUploadId ?? null,
        input.mediaType ?? null,
        input.filename ?? null,
        input.stagedBy ?? null,
        input.sealedSize ?? null,
        input.partCount ?? null,
        input.deviceId ?? null,
        now,
        now,
        input.expiresAt,
      );
    return this.session(input.sessionId)!;
  }

  session(sessionId: string): IngressSessionRow | null {
    return (
      (this.db.prepare('SELECT * FROM blob_ingress_session WHERE session_id = ?').get(sessionId) as
        | IngressSessionRow
        | undefined) ?? null
    );
  }

  recordAppend(
    sessionId: string,
    receivedBytes: number,
    hashState?: SerializableSha256State,
  ): void {
    this.db
      .prepare(
        `UPDATE blob_ingress_session
            SET received_bytes = ?, hash_state_json = ?, updated_at = ?
          WHERE session_id = ? AND state = 'open'`,
      )
      .run(receivedBytes, hashState ? JSON.stringify(hashState) : null, nowIso(), sessionId);
  }

  setSessionState(sessionId: string, state: IngressSessionRow['state']): void {
    this.db
      .prepare('UPDATE blob_ingress_session SET state = ?, updated_at = ? WHERE session_id = ?')
      .run(state, nowIso(), sessionId);
  }

  /**
   * Cross the fallback commit boundary while durably retaining a hash resolved
   * from the incremental state. Replaying an existing committing row is a
   * no-op; a different hash or terminal state is never overwritten.
   */
  beginFallbackCommit(sessionId: string, sha256: string): IngressSessionRow {
    const result = this.db
      .prepare(
        `UPDATE blob_ingress_session
            SET state = 'committing', expected_sha256 = COALESCE(expected_sha256, ?),
                updated_at = ?
          WHERE session_id = ? AND kind = 'fallback'
            AND state IN ('open','committing')
            AND (expected_sha256 IS NULL OR expected_sha256 = ?)`,
      )
      .run(sha256, nowIso(), sessionId, sha256);
    if (result.changes !== 1) {
      throw new Error(`fallback upload session ${sessionId} cannot begin commit`);
    }
    return this.session(sessionId)!;
  }

  setSessionUpload(sessionId: string, uploadId: string): void {
    this.db
      .prepare(
        `UPDATE blob_ingress_session SET remote_upload_id = ?, updated_at = ?
          WHERE session_id = ? AND state = 'open'`,
      )
      .run(uploadId, nowIso(), sessionId);
  }

  setSessionTempPath(sessionId: string, tempPath: string | null): void {
    this.db
      .prepare(
        `UPDATE blob_ingress_session SET temp_path = ?, updated_at = ?
          WHERE session_id = ?`,
      )
      .run(tempPath, nowIso(), sessionId);
  }

  completeSession(sessionId: string, sha256: string): void {
    this.db
      .prepare(
        `UPDATE blob_ingress_session SET state = 'complete', expected_sha256 = ?,
           updated_at = ? WHERE session_id = ?`,
      )
      .run(sha256, nowIso(), sessionId);
  }

  setDirectParts(sessionId: string, parts: readonly MultipartPart[]): void {
    this.db
      .prepare(
        'UPDATE blob_ingress_session SET remote_parts_json = ?, updated_at = ? WHERE session_id = ?',
      )
      .run(JSON.stringify(parts), nowIso(), sessionId);
  }

  recordRemoteAppend(input: {
    sessionId: string;
    receivedBytes: number;
    hashState: SerializableSha256State;
    parts: readonly MultipartPart[];
    meta: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        `UPDATE blob_ingress_session
            SET received_bytes = ?, hash_state_json = ?, remote_parts_json = ?,
                meta_json = ?, updated_at = ?
          WHERE session_id = ? AND state = 'open' AND kind = 'stream-through'`,
      )
      .run(
        input.receivedBytes,
        JSON.stringify(input.hashState),
        JSON.stringify(input.parts),
        JSON.stringify(input.meta),
        nowIso(),
        input.sessionId,
      );
  }

  recordProbe(sessionId: string, kind: 'head' | 'tail', bytes: Buffer): void {
    if (kind === 'head') {
      this.db
        .prepare(
          `INSERT INTO blob_ingress_probe (session_id, head_bytes) VALUES (?, ?)
           ON CONFLICT (session_id) DO UPDATE SET head_bytes = excluded.head_bytes`,
        )
        .run(sessionId, bytes);
    } else {
      this.db
        .prepare(
          `INSERT INTO blob_ingress_probe (session_id, tail_bytes) VALUES (?, ?)
           ON CONFLICT (session_id) DO UPDATE SET tail_bytes = excluded.tail_bytes`,
        )
        .run(sessionId, bytes);
    }
  }

  probes(sessionId: string): { head: Buffer; tail: Buffer } {
    const row = this.db
      .prepare('SELECT head_bytes, tail_bytes FROM blob_ingress_probe WHERE session_id = ?')
      .get(sessionId) as
      | { head_bytes: Uint8Array | null; tail_bytes: Uint8Array | null }
      | undefined;
    return {
      head: row?.head_bytes ? Buffer.from(row.head_bytes) : Buffer.alloc(0),
      tail: row?.tail_bytes ? Buffer.from(row.tail_bytes) : Buffer.alloc(0),
    };
  }

  openIngressSession(input: {
    sha256: string;
    expectedSize: number;
    stagedBy?: string;
  }): IngressSessionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM blob_ingress_session
            WHERE ((kind = 'fallback' AND state IN ('open','committing'))
                OR (kind = 'stream-through' AND state IN ('open','committing')))
              AND expected_sha256 = ? AND expected_size = ? AND staged_by IS ?
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(input.sha256, input.expectedSize, input.stagedBy ?? null) as
        | IngressSessionRow
        | undefined) ?? null
    );
  }

  openDirectSession(input: {
    sha256: string;
    plaintextSize: number;
    sealedSize: number;
    partCount: number;
    deviceId: string;
  }): IngressSessionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM blob_ingress_session
            WHERE kind = 'direct' AND state IN ('open','committing')
              AND expected_sha256 = ? AND expected_size = ? AND sealed_size = ?
              AND part_count = ? AND device_id = ?
            ORDER BY created_at DESC LIMIT 1`,
        )
        .get(
          input.sha256,
          input.plaintextSize,
          input.sealedSize,
          input.partCount,
          input.deviceId,
        ) as IngressSessionRow | undefined) ?? null
    );
  }

  deleteSession(sessionId: string): void {
    this.db.prepare('DELETE FROM blob_ingress_session WHERE session_id = ?').run(sessionId);
  }

  expiredSessions(at = nowIso()): IngressSessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM blob_ingress_session
          WHERE expires_at <= ?
          ORDER BY expires_at`,
      )
      .all(at) as unknown as IngressSessionRow[];
  }

  activeMultipartUploads(at = nowIso()): { tempId: string; uploadId: string }[] {
    const rows = this.db
      .prepare(
        `SELECT remote_temp_id AS temp_id, remote_upload_id AS upload_id
           FROM blob_ingress_session
          WHERE state IN ('open','committing') AND expires_at > ?
            AND remote_temp_id IS NOT NULL AND remote_upload_id IS NOT NULL
          UNION ALL
         SELECT temp_id, upload_id
           FROM blob_outbox
          WHERE temp_id IS NOT NULL AND upload_id IS NOT NULL`,
      )
      .all(at) as unknown as { temp_id: string; upload_id: string }[];
    return rows.map((row) => ({ tempId: row.temp_id, uploadId: row.upload_id }));
  }

  reservedIngressBytes(exceptSessionId?: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(
           CASE WHEN expected_size IS NULL THEN received_bytes ELSE expected_size END
         ), 0) AS bytes
           FROM blob_ingress_session
          WHERE kind = 'fallback' AND state IN ('open','committing')
            AND (? IS NULL OR session_id <> ?)`,
      )
      .get(exceptSessionId ?? null, exceptSessionId ?? null) as { bytes: number };
    return row.bytes;
  }

  /** Future fallback bytes not yet reflected in statfs free-space accounting. */
  reservedIngressRemainingBytes(exceptSessionId?: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(
           CASE WHEN expected_size IS NULL THEN 0
                ELSE MAX(expected_size - received_bytes, 0) END
         ), 0) AS bytes
           FROM blob_ingress_session
          WHERE kind = 'fallback' AND state IN ('open','committing')
            AND (? IS NULL OR session_id <> ?)`,
      )
      .get(exceptSessionId ?? null, exceptSessionId ?? null) as { bytes: number };
    return row.bytes;
  }

  enqueue(sha256: string, byteSize: number): void {
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO blob_outbox
           (sha256, byte_size, state, created_at, updated_at)
         VALUES (?, ?, 'pending', ?, ?)
         ON CONFLICT (sha256) DO UPDATE SET
           byte_size = excluded.byte_size,
           state = 'pending',
           next_retry_at = NULL,
           last_error = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(sha256, byteSize, now, now);
  }

  outbox(sha256: string): OutboxRow | null {
    return (
      (this.db.prepare('SELECT * FROM blob_outbox WHERE sha256 = ?').get(sha256) as
        | OutboxRow
        | undefined) ?? null
    );
  }

  dueOutbox(at = nowIso(), limit = 8): OutboxRow[] {
    return this.db
      .prepare(
        `SELECT * FROM blob_outbox
          WHERE next_retry_at IS NULL OR next_retry_at <= ?
          ORDER BY created_at LIMIT ?`,
      )
      .all(at, limit) as unknown as OutboxRow[];
  }

  markUploading(sha256: string, tempId: string, uploadId?: string): void {
    this.db
      .prepare(
        `UPDATE blob_outbox SET state = 'uploading', temp_id = ?,
           upload_id = COALESCE(?, upload_id), updated_at = ? WHERE sha256 = ?`,
      )
      .run(tempId, uploadId ?? null, nowIso(), sha256);
  }

  markUploadingFinal(sha256: string, uploadId?: string): void {
    this.db
      .prepare(
        `UPDATE blob_outbox SET state = 'uploading', temp_id = NULL,
           upload_id = COALESCE(?, upload_id), updated_at = ? WHERE sha256 = ?`,
      )
      .run(uploadId ?? null, nowIso(), sha256);
  }

  setOutboxUpload(sha256: string, uploadId: string): void {
    this.db
      .prepare('UPDATE blob_outbox SET upload_id = ?, updated_at = ? WHERE sha256 = ?')
      .run(uploadId, nowIso(), sha256);
  }

  setOutboxParts(sha256: string, parts: readonly MultipartPart[]): void {
    this.db
      .prepare('UPDATE blob_outbox SET parts_json = ?, updated_at = ? WHERE sha256 = ?')
      .run(JSON.stringify(parts), nowIso(), sha256);
  }

  failOutbox(sha256: string, message: string, retryAt: string): void {
    this.db
      .prepare(
        `UPDATE blob_outbox SET state = 'pending', attempt_count = attempt_count + 1,
           last_error = ?, next_retry_at = ?, updated_at = ? WHERE sha256 = ?`,
      )
      .run(message, retryAt, nowIso(), sha256);
  }

  completeOutbox(sha256: string): void {
    this.db.prepare('DELETE FROM blob_outbox WHERE sha256 = ?').run(sha256);
  }

  pendingShas(): string[] {
    return (
      this.db.prepare('SELECT sha256 FROM blob_outbox ORDER BY sha256').all() as {
        sha256: string;
      }[]
    ).map((row) => row.sha256);
  }

  status(): {
    pendingCount: number;
    pendingBytes: number;
    uploadingCount: number;
    lastError: string | null;
  } {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS pending_count, COALESCE(SUM(byte_size), 0) AS pending_bytes,
                COALESCE(SUM(CASE WHEN state = 'uploading' THEN 1 ELSE 0 END), 0) AS uploading_count
           FROM blob_outbox`,
      )
      .get() as { pending_count: number; pending_bytes: number; uploading_count: number };
    const failure = this.db
      .prepare(
        `SELECT last_error FROM blob_outbox WHERE last_error IS NOT NULL
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get() as { last_error: string } | undefined;
    return {
      pendingCount: totals.pending_count,
      pendingBytes: totals.pending_bytes,
      uploadingCount: totals.uploading_count,
      lastError: failure?.last_error ?? null,
    };
  }
}
