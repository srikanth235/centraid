import { afterEach, describe, expect, test } from 'vitest';

import { openVaultDb, type VaultDb } from '../db.js';
import { cleanupOrphanedMultipartUploads, ORPHAN_MULTIPART_GRACE_MS } from './orphan-multipart.js';
import type { RemoteBlobTransfer, TemporaryMultipartUpload } from './remote-transfer.js';
import { BlobTransferState } from './transfer-state.js';

type CleanupTransfer = Pick<RemoteBlobTransfer, 'abortTemporaryUpload' | 'listTemporaryUploads'>;

let db: VaultDb | undefined;
describe('orphan-multipart', () => {
  afterEach(() => {
    db?.close();
    db = undefined;
  });

  function state(): BlobTransferState {
    db = openVaultDb();
    return new BlobTransferState(db.vault);
  }

  test('a multipart create that crashed before SQLite persistence is reaped after grace', async () => {
    const transfers = state();
    const initiatedAt = Date.parse('2026-07-01T00:00:00.000Z');
    const uploads: TemporaryMultipartUpload[] = [];
    const aborted: string[] = [];
    const provider = {
      async beginTemporaryUpload(tempId: string): Promise<string> {
        const uploadId = 'provider-only-upload';
        uploads.push({
          tempId,
          uploadId,
          initiatedAt: new Date(initiatedAt).toISOString(),
        });
        return uploadId;
      },
      async listTemporaryUploads(): Promise<TemporaryMultipartUpload[]> {
        return uploads;
      },
      async abortTemporaryUpload(tempId: string, uploadId: string): Promise<void> {
        aborted.push(`${tempId}:${uploadId}`);
      },
    };

    // Simulate CreateMultipartUpload returning, followed by a process crash:
    // deliberately never write the returned id to BlobTransferState.
    await provider.beginTemporaryUpload('direct-crash-gap');
    expect(transfers.activeMultipartUploads()).toStrictEqual([]);
    await expect(
      cleanupOrphanedMultipartUploads({
        state: transfers,
        transfer: provider,
        nowMs: initiatedAt + ORPHAN_MULTIPART_GRACE_MS,
      }),
    ).resolves.toBe(0);
    await expect(
      cleanupOrphanedMultipartUploads({
        state: transfers,
        transfer: provider,
        nowMs: initiatedAt + ORPHAN_MULTIPART_GRACE_MS + 1,
      }),
    ).resolves.toBe(1);
    expect(aborted).toStrictEqual(['direct-crash-gap:provider-only-upload']);
  });

  test('active session/outbox upload ids stay protected while stale sibling ids are reaped', async () => {
    const transfers = state();
    const nowMs = Date.parse('2026-07-16T00:00:00.000Z');
    const old = new Date(nowMs - ORPHAN_MULTIPART_GRACE_MS - 1).toISOString();
    transfers.createSession({
      sessionId: 'session-active',
      kind: 'stream-through',
      remoteTempId: 'stream-temp',
      remoteUploadId: 'stream-active',
      expiresAt: new Date(nowMs + 60_000).toISOString(),
    });
    const sha = 'a'.repeat(64);
    transfers.enqueue(sha, 100);
    transfers.markUploading(sha, 'outbox-temp');
    transfers.setOutboxUpload(sha, 'outbox-active');
    const uploads: TemporaryMultipartUpload[] = [
      { tempId: 'stream-temp', uploadId: 'stream-active', initiatedAt: old },
      {
        tempId: 'stream-temp',
        uploadId: 'stream-unpersisted',
        initiatedAt: old,
      },
      { tempId: 'outbox-temp', uploadId: 'outbox-active', initiatedAt: old },
      {
        tempId: 'outbox-temp',
        uploadId: 'outbox-unpersisted',
        initiatedAt: old,
      },
    ];
    const aborted: string[] = [];
    const transfer: CleanupTransfer = {
      listTemporaryUploads: async () => uploads,
      abortTemporaryUpload: async (tempId, uploadId) => void aborted.push(`${tempId}:${uploadId}`),
    };

    await expect(
      cleanupOrphanedMultipartUploads({ state: transfers, transfer, nowMs }),
    ).resolves.toBe(2);
    expect(aborted).toStrictEqual([
      'stream-temp:stream-unpersisted',
      'outbox-temp:outbox-unpersisted',
    ]);
  });
});
