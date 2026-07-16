import { rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { BlobCache } from './cache.js';
import type { LocalBlobStore } from './local.js';
import { extractBlobMetaFromProbes, sniffMediaType } from './pipeline.js';
import { INGRESS_PREVIEW_MAX_BYTES, type IngressPreviewInput } from './preview.js';
import { recordKnownStagedBlob } from './staging-record.js';
import { mediaLocationPolicyForVault, type StagedBlob } from './staging.js';
import type { IngressSessionRow } from './transfer-state.js';

const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 8 * 1024 * 1024;

/** Finalize a local spool without ever reading a large original as one buffer. */
export function stageFallbackIngress(input: {
  vault: DatabaseSync;
  local: LocalBlobStore;
  row: IngressSessionRow;
  sha256: string;
  contributePreview?: (preview: IngressPreviewInput) => void;
}): StagedBlob {
  const { vault, local, row, sha256 } = input;
  const head = local.getSync(sha256, { start: 0, end: HEAD_BYTES - 1 }) ?? Buffer.alloc(0);
  const tail =
    local.getSync(sha256, {
      start: Math.max(0, row.received_bytes - TAIL_BYTES),
      end: Math.max(0, row.received_bytes - 1),
    }) ?? Buffer.alloc(0);
  const mediaType = sniffMediaType(
    head,
    row.media_type ?? undefined,
    row.original_name ?? undefined,
  );
  const staged = recordKnownStagedBlob(vault, {
    sha256,
    byteSize: row.received_bytes,
    mediaType,
    meta: extractBlobMetaFromProbes(head, tail, mediaType, {
      keepLocation: mediaLocationPolicyForVault(vault) !== 'strip',
    }),
    ...(row.original_name ? { filename: row.original_name } : {}),
    ...(row.staged_by ? { stagedBy: row.staged_by } : {}),
  });
  if (
    input.contributePreview &&
    mediaType.startsWith('image/') &&
    row.received_bytes <= INGRESS_PREVIEW_MAX_BYTES
  ) {
    const bytes = local.getSync(sha256);
    if (bytes) {
      try {
        input.contributePreview({
          sha256,
          bytes,
          mediaType,
          ...(row.staged_by ? { stagedBy: row.staged_by } : {}),
        });
      } catch {
        // Custody/staging succeed even when the optional raster codec declines.
      }
    }
  }
  return staged;
}

/** Adopt a committing fallback temp exactly once, then idempotently stage it. */
export function adoptAndStageFallbackIngress(input: {
  vault: DatabaseSync;
  local: LocalBlobStore;
  cache: BlobCache;
  row: IngressSessionRow;
  sha256: string;
  contributePreview?: (preview: IngressPreviewInput) => void;
}): StagedBlob {
  const { local, cache, row, sha256 } = input;
  let adopted = false;
  if (local.hasSync(sha256)) {
    // Adoption may have completed before the process died; the old source is
    // intentionally allowed to be absent in this replay branch.
    if (row.temp_path) rmSync(row.temp_path, { force: true });
  } else {
    if (!row.temp_path || !local.adoptTempSync) {
      throw new Error('local blob store cannot adopt resumable ingress files');
    }
    adopted = local.adoptTempSync(sha256, row.temp_path);
  }
  const final = local.statSync(sha256);
  if (!final || final.size !== row.received_bytes) {
    throw new Error(
      `fallback CAS size mismatch: expected ${row.received_bytes}, got ${final?.size ?? 'missing'}`,
    );
  }
  if (adopted) cache.onPut(row.received_bytes);
  return stageFallbackIngress(input);
}

/** Recreate an idempotent commit response from its durable completed row. */
export function stageCompletedIngress(
  vault: DatabaseSync,
  row: IngressSessionRow,
  sha256: string,
): StagedBlob {
  const existing = vault
    .prepare(
      `SELECT media_type, byte_size, meta_json
         FROM blob_staging
        WHERE sha256 = ? AND variant IS NULL`,
    )
    .get(sha256) as { media_type: string; byte_size: number; meta_json: string } | undefined;
  if (existing) {
    const content = vault
      .prepare('SELECT content_id FROM core_content_item WHERE sha256 = ?')
      .get(sha256) as { content_id: string } | undefined;
    return {
      sha256,
      mediaType: existing.media_type,
      byteSize: existing.byte_size,
      meta: JSON.parse(existing.meta_json) as Record<string, unknown>,
      existingContentId: content?.content_id ?? null,
    };
  }
  return recordKnownStagedBlob(vault, {
    sha256,
    byteSize: row.received_bytes,
    ...(row.media_type ? { mediaType: row.media_type } : {}),
    ...(row.original_name ? { filename: row.original_name } : {}),
    ...(row.staged_by ? { stagedBy: row.staged_by } : {}),
  });
}
