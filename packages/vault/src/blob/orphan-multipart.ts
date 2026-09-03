import type {
  RemoteBlobTransfer,
  TemporaryMultipartUpload,
} from "./remote-transfer.js";
import type { BlobTransferState } from "./transfer-state.js";

export const ORPHAN_MULTIPART_GRACE_MS = 24 * 60 * 60 * 1000;

function identity(
  upload: Pick<TemporaryMultipartUpload, "tempId" | "uploadId">
): string {
  return `${upload.tempId}\0${upload.uploadId}`;
}

export interface OrphanMultipartCleanupOptions {
  state: Pick<BlobTransferState, "activeMultipartUploads">;
  transfer: Pick<
    RemoteBlobTransfer,
    "abortTemporaryUpload" | "listTemporaryUploads"
  >;
  nowMs?: number;
  graceMs?: number;
}

export async function cleanupOrphanedMultipartUploads(
  options: OrphanMultipartCleanupOptions
): Promise<number> {
  if (!options.transfer.listTemporaryUploads) return 0;
  const nowMs = options.nowMs ?? Date.now();
  const active = new Set(
    options.state
      .activeMultipartUploads(new Date(nowMs).toISOString())
      .map((upload) => identity(upload))
  );
  const cutoff = nowMs - (options.graceMs ?? ORPHAN_MULTIPART_GRACE_MS);
  const uploads = await options.transfer.listTemporaryUploads();
  const abandoned = uploads.filter((upload) => {
    const initiatedMs = Date.parse(upload.initiatedAt);
    return (
      Number.isFinite(initiatedMs) &&
      initiatedMs < cutoff &&
      !active.has(identity(upload))
    );
  });
  const results = await Promise.allSettled(
    abandoned.map(async (upload) =>
      options.transfer.abortTemporaryUpload(upload.tempId, upload.uploadId)
    )
  );
  return results.filter((result) => result.status === "fulfilled").length;
}
