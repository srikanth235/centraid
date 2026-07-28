// Byte placement for share-by-placement (issue #599 decision 11).
//
// Sharing an item into an audience vault must put its bytes in that vault's
// own CAS, because each vault directory stays self-contained and portable —
// backup, restore and vault-erase are untouched by sharing. Copying the bytes
// would be correct but wasteful, so the primary path is a HARDLINK: all vaults
// sit under one gateway rootDir on one filesystem, and CAS files are immutable
// write-once, so a second directory entry onto the same inode is safe and
// copies zero bytes.
//
// That also settles refcounting: the filesystem's link count IS the cross-vault
// refcount. Each vault's orphan sweep unlinks only its own directory entry and
// the inode survives until the last vault lets go — no shared pin table, no
// cross-vault bookkeeping.

import { VaultShareError } from '../errors.js';
import type { LocalBlobStore } from '../blob/local.js';

/**
 * How a content address came to be in the audience vault's CAS.
 *   - `present` it was already there (dedup — CAS is content-addressed).
 *   - `linked`  a hardlink onto the origin's inode: zero bytes copied.
 *   - `copied`  the filesystem refused the link (EXDEV/EPERM), so the bytes
 *               were written through the store's own write-once temp+rename
 *               path. Identical semantics, costs bytes.
 */
export type BlobPlacementMode = 'present' | 'linked' | 'copied';

/** One content address placed into the audience vault, and how. */
export interface BlobPlacement {
  sha256: string;
  mode: BlobPlacementMode;
}

/**
 * Put `sha` into the audience CAS, preferring a hardlink from the origin CAS.
 *
 * Runs BEFORE the audience-vault transaction: a link is idempotent (it exists
 * or it doesn't), and a failure after it leaves at most an orphaned link that
 * the audience vault's own orphan sweep reclaims. The reverse order would risk
 * a committed row with no bytes behind it.
 */
export function placeBlob(
  origin: LocalBlobStore,
  audience: LocalBlobStore,
  sha: string,
): BlobPlacementMode {
  if (audience.hasSync(sha)) return 'present';
  const source = origin.localPathSync?.(sha) ?? null;
  if (source !== null && audience.linkFromSync) {
    const outcome = audience.linkFromSync(sha, source);
    if (outcome === 'linked') return 'linked';
    if (outcome === 'exists') return 'present';
    // 'unsupported' — the filesystem will not link these two paths. Fall
    // through to the byte copy below rather than failing the share.
  }
  // Copy path: either a store with no link seam (the in-memory tier), or a
  // filesystem that refused. Reading through the origin store keeps this
  // honest for both tiers.
  const bytes = origin.getSync(sha);
  if (bytes === null) {
    throw new VaultShareError(
      `cannot share ${sha}: the origin vault holds no local bytes for it (bytes must be resident to be placed)`,
    );
  }
  audience.putSync(sha, bytes);
  return 'copied';
}
