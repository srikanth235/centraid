import type { DatabaseSync } from 'node:sqlite';
import type { LocalBlobStore } from './local.js';
import type { BlobTransferState } from './transfer-state.js';

/** Atomically seed remote-primary obligations from every live local claim. */
export function enqueueExistingLocalBlobs(
  vault: DatabaseSync,
  localStore: LocalBlobStore,
  state: BlobTransferState,
): number {
  const candidates = vault
    .prepare(
      `SELECT sha256, MAX(byte_size) AS byte_size FROM (
         SELECT sha256, byte_size FROM core_content_item
          WHERE sha256 IS NOT NULL AND deleted_at IS NULL
         UNION ALL
         SELECT d.sha256, d.byte_size FROM core_content_derivative d
           JOIN core_content_item i ON i.content_id = d.content_id
          WHERE d.sha256 IS NOT NULL AND i.deleted_at IS NULL
         UNION ALL
         SELECT sha256, byte_size FROM blob_staging
       ) GROUP BY sha256`,
    )
    .all() as unknown as { sha256: string; byte_size: number }[];
  const local = candidates.filter((row) => localStore.hasSync(row.sha256));
  vault.exec('BEGIN IMMEDIATE');
  try {
    for (const row of local) state.enqueue(row.sha256, row.byte_size);
    vault.exec('COMMIT');
  } catch (error) {
    vault.exec('ROLLBACK');
    throw error;
  }
  return local.length;
}
