// The LOCAL orphan reclaim (issue #599 decision 11 / issue #439 R4).
//
// Two shipped passes already shed bytes, and neither reclaims a local-only
// orphan:
//
//   * `reconcileCustody` diffs the REMOTE tier against the live set — it
//     deletes remote objects, never local directory entries;
//   * `BlobCache.runEviction` sheds only bytes with replica evidence, so a
//     vault with no remote store can never evict anything.
//
// Share-by-placement makes the gap load-bearing: a share hardlinks bytes into
// the audience CAS *before* the audience transaction commits, so a failed
// share (and every unshare) leaves a directory entry that nothing in the
// audience's model claims. The filesystem link count is the cross-vault
// refcount — unlinking one vault's entry leaves every other vault's copy
// readable — so each vault reclaiming its OWN orphans is exactly right.
//
// The rule is the same orphan-grace invariant the remote sweep obeys: a sha is
// tombstoned on the pass that first observes it orphaned and deleted only once
// `graceWindowMs` has elapsed since that first observation. Because the stamp
// is always ≥ the true dereference instant, the rule can only over-retain.
//
// Reachability is computed the way `Gateway.sweepBlobs` computes it, and for
// the same reason: the live model is NOT the whole root set. Archived journal
// segments and pruned conversation segments are claimed by their manifest
// chains alone, and a retained backup snapshot pins bytes the live model
// dropped. Passing anything narrower here would delete the only durable copy
// of an archived segment.

import type { DatabaseSync } from "node:sqlite";

import { conversationArchiveShas } from "../conversation-archive-roots.js";
import { archivedSegmentShas } from "../journal-archive.js";
import type { LocalBlobStore } from "./local.js";
import { OrphanTombstoneIndex } from "./orphan-tombstone.js";
import { liveBlobShas } from "./read.js";

/**
 * The narrow slice of an open vault the sweep touches. `VaultDb` satisfies it
 * structurally, so callers pass their live handle unchanged.
 */
export interface LocalOrphanSweepTarget {
  vault: DatabaseSync;
  journal: DatabaseSync;
  blobs: {
    local: Pick<LocalBlobStore, "listSync">;
    deleteLocalSync: (sha: string) => void;
  };
}

export interface LocalOrphanSweepOptions {
  /**
   * The recovery window N, in ms. An orphan is held until it has been
   * observed orphaned for LONGER than this. `0` still holds a
   * freshly-discovered orphan for one pass — a byte is never deleted on the
   * same pass that first sees it unclaimed.
   */
  graceWindowMs: number;
  /** Injectable clock, epoch ms. Defaults to `Date.now`. */
  now?: number;
  /**
   * Additional reachability roots the caller authenticated — retained backup
   * snapshot manifests (issue #436 §6). A sha named here is never an orphan.
   */
  extraLiveRoots?: ReadonlySet<string>;
}

export interface LocalOrphanSweepResult {
  /** Local directory entries unlinked on this pass. */
  deleted: string[];
  /** Orphans the grace window held back; they delete on a later pass. */
  graceHeld: string[];
}

/**
 * Reclaim local CAS entries this vault no longer claims, subject to the
 * orphan-grace window. Synchronous and local-only: it never contacts a remote
 * tier and never touches another vault's directory entries.
 */
export function sweepLocalOrphans(
  db: LocalOrphanSweepTarget,
  options: LocalOrphanSweepOptions
): LocalOrphanSweepResult {
  const now = options.now ?? Date.now();
  const live = liveBlobShas(db.vault);
  for (const sha of archivedSegmentShas(db.journal)) live.add(sha);
  for (const sha of conversationArchiveShas(db.journal)) live.add(sha);
  const tombstones = new OrphanTombstoneIndex(db.vault);
  const deleted: string[] = [];
  const graceHeld: string[] = [];
  for (const sha of db.blobs.local.listSync()) {
    if (live.has(sha) || options.extraLiveRoots?.has(sha) === true) {
      tombstones.clear(sha);
      continue;
    }
    const firstOrphanedAt = tombstones.markFirstSeen(sha, now);
    if (now - firstOrphanedAt <= options.graceWindowMs) {
      graceHeld.push(sha);
      continue;
    }
    db.blobs.deleteLocalSync(sha);
    tombstones.clear(sha);
    deleted.push(sha);
  }
  return { deleted, graceHeld };
}
