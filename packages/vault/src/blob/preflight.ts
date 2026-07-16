import type { DatabaseSync } from 'node:sqlite';
import type { BlobCache } from './cache.js';
import type { CustodyState, RemoteTier } from './custody-types.js';
import type { LocalBlobStore } from './local.js';
import { recordKnownStagedBlob } from './staging-record.js';
import { assertSha } from './store.js';
import type { BlobTransferState } from './transfer-state.js';

export interface BlobPreflightResult {
  exists: boolean;
  custody: CustodyState;
  byteSize?: number;
  mediaType?: string;
  contentId?: string;
  staged: boolean;
  /** False only when a configured provider HEAD failed, not when absent. */
  remoteAvailable: boolean;
  remoteError?: string;
}

export interface BlobPreflightHint {
  byteSize?: number;
  mediaType?: string;
  filename?: string;
  stagedBy?: string;
}

export interface BlobPreflightDeps {
  vault: DatabaseSync;
  local: LocalBlobStore;
  cache: BlobCache;
  remote: () => RemoteTier | null;
  state: BlobTransferState;
  verifyRemote?: (sha256: string, sealedSize: number) => Promise<boolean>;
}

/** HEAD-style existence + custody check, with a claimable staging receipt. */
export async function preflightBlob(
  deps: BlobPreflightDeps,
  sha256: string,
  hint: BlobPreflightHint = {},
): Promise<BlobPreflightResult> {
  const sha = assertSha(sha256);
  const local = deps.local.hasSync(sha);
  const replica = deps.vault
    .prepare('SELECT byte_size FROM blob_replica WHERE sha256 = ?')
    .get(sha) as { byte_size: number } | undefined;
  let custody: CustodyState = deps.state.outbox(sha) ? 'pending-offsite' : 'missing';
  const remote = deps.remote();
  let remoteAvailable = true;
  let remoteError: string | undefined;
  let remoteStat = null;
  if (custody !== 'pending-offsite' && remote) {
    try {
      remoteStat = await remote.store.stat(sha);
      if (remoteStat && deps.verifyRemote && !(await deps.verifyRemote(sha, remoteStat.size))) {
        deps.cache.replica.unmark(sha);
        remoteStat = null;
      }
    } catch (error) {
      remoteAvailable = false;
      remoteError = error instanceof Error ? error.message : String(error);
    }
  }
  const evidencedSize = deps.local.statSync(sha)?.size ?? replica?.byte_size ?? hint.byteSize;
  if (remoteStat && evidencedSize !== undefined) deps.cache.replica.mark(sha, evidencedSize);
  if (custody !== 'pending-offsite') {
    custody =
      local && remoteStat
        ? 'replicated'
        : remoteStat
          ? 'remote-only'
          : local
            ? 'local-only'
            : 'missing';
  }
  if (custody === 'missing') {
    return {
      exists: false,
      custody,
      staged: false,
      remoteAvailable,
      ...(remoteError ? { remoteError } : {}),
    };
  }
  const content = deps.vault
    .prepare(
      `SELECT content_id, byte_size, media_type FROM core_content_item
        WHERE sha256 = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
    )
    .get(sha) as { content_id: string; byte_size: number; media_type: string } | undefined;
  if (content) {
    return {
      exists: true,
      custody,
      staged: false,
      byteSize: content.byte_size,
      mediaType: content.media_type,
      contentId: content.content_id,
      remoteAvailable,
      ...(remoteError ? { remoteError } : {}),
    };
  }
  const staged = deps.vault
    .prepare(
      'SELECT byte_size, media_type FROM blob_staging WHERE sha256 = ? AND variant IS NULL LIMIT 1',
    )
    .get(sha) as { byte_size: number; media_type: string } | undefined;
  if (staged) {
    return {
      exists: true,
      custody,
      staged: true,
      byteSize: staged.byte_size,
      mediaType: staged.media_type,
      remoteAvailable,
      ...(remoteError ? { remoteError } : {}),
    };
  }
  const byteSize = hint.byteSize ?? deps.local.statSync(sha)?.size ?? replica?.byte_size;
  if (byteSize === undefined) {
    return {
      exists: true,
      custody,
      staged: false,
      remoteAvailable,
      ...(remoteError ? { remoteError } : {}),
    };
  }
  const receipt = recordKnownStagedBlob(deps.vault, {
    sha256: sha,
    byteSize,
    ...(hint.mediaType ? { mediaType: hint.mediaType } : {}),
    ...(hint.filename ? { filename: hint.filename } : {}),
    ...(hint.stagedBy ? { stagedBy: hint.stagedBy } : {}),
  });
  return {
    exists: true,
    custody,
    staged: true,
    byteSize: receipt.byteSize,
    mediaType: receipt.mediaType,
    ...(receipt.existingContentId ? { contentId: receipt.existingContentId } : {}),
    remoteAvailable,
    ...(remoteError ? { remoteError } : {}),
  };
}
