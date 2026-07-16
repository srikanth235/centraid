import type { RemoteBlobTransfer, TemporaryMultipartUpload } from './remote-transfer.js';
import type { BlobTransferState } from './transfer-state.js';

export const ORPHAN_MULTIPART_GRACE_MS = 24 * 60 * 60 * 1000;

function identity(upload: Pick<TemporaryMultipartUpload, 'tempId' | 'uploadId'>): string {
  return `${upload.tempId}\0${upload.uploadId}`;
}

export interface OrphanMultipartCleanupOptions {
  state: Pick<BlobTransferState, 'activeMultipartUploads'>;
  transfer: Pick<RemoteBlobTransfer, 'abortTemporaryUpload' | 'listTemporaryUploads'>;
  nowMs?: number;
  graceMs?: number;
}

/**
 * Reap provider multipart uploads that have no matching durable local upload.
 * The grace window closes the unavoidable create-response -> SQLite-write
 * race: a fresh provider upload is never mistaken for an orphan.
 */
export async function cleanupOrphanedMultipartUploads(
  options: OrphanMultipartCleanupOptions,
): Promise<number> {
  if (!options.transfer.listTemporaryUploads) return 0;
  const nowMs = options.nowMs ?? Date.now();
  const active = new Set(
    options.state
      .activeMultipartUploads(new Date(nowMs).toISOString())
      .map((upload) => identity(upload)),
  );
  const cutoff = nowMs - (options.graceMs ?? ORPHAN_MULTIPART_GRACE_MS);
  let aborted = 0;
  for (const upload of await options.transfer.listTemporaryUploads()) {
    const initiatedMs = Date.parse(upload.initiatedAt);
    if (!Number.isFinite(initiatedMs) || initiatedMs >= cutoff || active.has(identity(upload))) {
      continue;
    }
    try {
      await options.transfer.abortTemporaryUpload(upload.tempId, upload.uploadId);
      aborted += 1;
    } catch {
      // Best-effort GC: one provider race/failure must not block custody drain.
    }
  }
  return aborted;
}
