// The LOCAL orphan reclaim (#599 decision 11 / #439 R4).
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
import { liveBlobShasCached } from "./read.js";

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
   * snapshot manifests (#436). A sha named here is never an orphan.
   */
  extraLiveRoots?: ReadonlySet<string>;
  /**
   * Entries this pass may examine (#659). A CAS with 100k objects
   * should not turn one hourly tick into 100k membership tests and up to
   * 100k unlinks; the pass walks a bounded window and hands back a cursor.
   * Unset = the whole directory, the pre-#659 behaviour.
   */
  maxEntries?: number;
  /**
   * Resume point: the pass starts at the first sha strictly greater than
   * this. Pass the previous result's `nextCursor` back to continue.
   */
  cursor?: string;
}

export interface LocalOrphanSweepResult {
  /** Local directory entries unlinked on this pass. */
  deleted: string[];
  /** Orphans the grace window held back; they delete on a later pass. */
  graceHeld: string[];
  /** Entries this pass examined. */
  examined: number;
  /**
   * Where the next pass should resume, or `null` when this pass reached the
   * end of the directory (the next pass starts over from the beginning).
   */
  nextCursor: string | null;
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
  // The live set is shared and read-only (#659): the other root sets
  // are consulted beside it rather than unioned into it, so the memo can be
  // handed to the backup tick unchanged instead of being rebuilt per caller.
  const live = liveBlobShasCached(db.vault);
  const archived = archivedSegmentShas(db.journal);
  const conversation = conversationArchiveShas(db.journal);
  const isClaimed = (sha: string): boolean =>
    live.has(sha) ||
    archived.has(sha) ||
    conversation.has(sha) ||
    options.extraLiveRoots?.has(sha) === true;

  if (options.maxEntries !== undefined && options.maxEntries <= 0)
    throw new Error("local orphan sweep maxEntries must be > 0");
  // Sorted so a cursor is a stable resume point across passes even if the
  // store's own listing order is not specified.
  const all = [...db.blobs.local.listSync()].sort();
  const cursor = options.cursor;
  const found = cursor === undefined ? 0 : all.findIndex((sha) => sha > cursor);
  const from = found < 0 ? all.length : found;
  const window =
    options.maxEntries === undefined
      ? all.slice(from)
      : all.slice(from, from + options.maxEntries);

  const tombstones = new OrphanTombstoneIndex(db.vault);
  const deleted: string[] = [];
  const graceHeld: string[] = [];
  for (const sha of window) {
    if (isClaimed(sha)) {
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
  const reachedEnd = from + window.length >= all.length;
  return {
    deleted,
    graceHeld,
    examined: window.length,
    nextCursor: reachedEnd ? null : (window[window.length - 1] as string),
  };
}
