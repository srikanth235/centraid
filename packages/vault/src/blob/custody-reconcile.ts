// The deep reconciliation sweep (issue #296 §6), lifted out of custody.ts so
// the facade stays under the governance line-cap and so the two-store diff lives
// in one place. Made store-aware in issue #425 Wave 2: the sweep now lists EVERY
// granted store class (cas, and derived when the tier has a derived store),
// deletes orphans out of each store, heals the replica index per store, and
// re-pushes a missing live sha to the store class it BELONGS in (so a derivative
// re-lands under the derived prefix, an original under cas).

import type { BlobCache } from './cache.js';
import type { ReconcileOptions, ReconcileResult, RemoteTier } from './custody-types.js';
import type { LocalBlobStore } from './local.js';
import type { OrphanTombstoneIndex } from './orphan-tombstone.js';
import type { ReplicaStore } from './replica-index.js';

export interface ReconcileContext {
  remote: RemoteTier | null;
  local: LocalBlobStore;
  cache?: BlobCache;
  /** The store class a live sha's bytes belong in (issue #425 Wave 2). */
  desiredStore: (sha: string) => ReplicaStore;
  /** Re-cache a remote-only sha into the local tier (custody.open). */
  open: (sha: string) => Promise<unknown>;
  /** Re-push local shas the remote is missing (custody.replicate). */
  replicate: (shas: string[]) => Promise<string[]>;
  /**
   * The orphan-grace tombstone store (issue #439 R4) — where the sweep records
   * WHEN each sha was first observed orphaned so the delete can be deferred by
   * `options.graceWindowMs`. Absent (legacy / cache-less) ⇒ grace cannot be
   * evaluated: when a grace window IS requested but this is missing, the sweep
   * fails safe (holds, never deletes).
   */
  orphans?: OrphanTombstoneIndex;
}

/**
 * Deep pass: list each store, delete orphans, heal the index per store, then
 * re-cache/re-push each live sha against the store class it belongs in. Orphan
 * deletion targets the store the object was actually found in; a live sha is
 * never an orphan in any store, so a derivative kept under the derived prefix
 * survives the cas orphan scan and vice-versa.
 */
export async function reconcileCustody(
  ctx: ReconcileContext,
  liveShas: Set<string>,
  options: ReconcileOptions,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    orphansDeleted: [],
    replicated: [],
    missing: [],
    orphansSkipped: [],
    orphansGraceHeld: [],
  };
  const { remote, local, cache } = ctx;
  const now = options.now ?? Date.now;
  const casShas = remote ? new Set(await remote.store.list()) : new Set<string>();
  const derivedShas = remote?.derivedStore
    ? new Set(await remote.derivedStore.list())
    : new Set<string>();
  const survivingCas = new Set(casShas);
  const survivingDerived = new Set(derivedShas);

  if (remote) {
    const stores: {
      class: ReplicaStore;
      listed: Set<string>;
      surviving: Set<string>;
      store: NonNullable<RemoteTier['derivedStore']>;
    }[] = [{ class: 'cas', listed: casShas, surviving: survivingCas, store: remote.store }];
    if (remote.derivedStore) {
      stores.push({
        class: 'derived',
        listed: derivedShas,
        surviving: survivingDerived,
        store: remote.derivedStore,
      });
    }
    for (const tier of stores) {
      for (const sha of tier.listed) {
        // A live sha is re-referenced: it can carry no orphan tombstone. Clear
        // any stale one (issue #439 R4 — a sha that becomes live again before
        // its grace elapses must lose its tombstone) and skip.
        if (liveShas.has(sha)) {
          ctx.orphans?.clear(sha);
          continue;
        }
        // GC-pins-snapshots invariant (issue #436 §6): a blob referenced by any
        // retained snapshot manifest is a live GC root and MUST NOT be deleted,
        // even though the live vault model no longer claims it. CAS has no
        // history — the retained snapshot's reference is the attachment history,
        // and this object is what a recovery-to-N would restore. Pinned here, at
        // the one place a client-owned CAS delete can happen. A pinned root is by
        // definition not orphaned, so it never earns a tombstone — the check
        // precedes the grace gate, keeping pinned objects out of blob_orphan.
        if (options.extraLiveRoots?.has(sha)) continue;
        if (options.skipOrphanDelete) {
          result.orphansSkipped.push(sha);
          continue;
        }
        // Orphan-grace gate (issue #439 R4). With a grace window in force, a
        // freshly-found orphan is tombstoned and HELD, not deleted: PITR makes
        // every instant inside the recovery window restorable, and a blob
        // referenced only BETWEEN two snapshots — named by no retained manifest —
        // is exactly the byte such a restore replays. Delete only once the
        // first-observed-orphaned instant is older than the window. A grace
        // window with no tombstone store to evaluate it fails safe (holds).
        if (options.graceWindowMs !== undefined) {
          if (!ctx.orphans) {
            result.orphansGraceHeld.push(sha);
            continue;
          }
          const firstOrphanedAt = ctx.orphans.markFirstSeen(sha, now());
          if (now() - firstOrphanedAt <= options.graceWindowMs) {
            result.orphansGraceHeld.push(sha);
            continue;
          }
          // Grace elapsed — fall through to delete and forget the tombstone.
        }
        await tier.store.delete(sha);
        ctx.orphans?.clear(sha);
        tier.surviving.delete(sha);
        cache?.replica.unmark(sha);
        result.orphansDeleted.push(sha);
      }
    }
  }

  // Heal each store's rows against ITS listing (issue #425 Wave 2) — the
  // listing is truth, the index a cache of evidence.
  if (cache && remote) {
    const sizeOf = (sha: string): number => local.statSync(sha)?.size ?? 0;
    cache.replica.heal('cas', survivingCas, sizeOf);
    if (remote.derivedStore) cache.replica.heal('derived', survivingDerived, sizeOf);
  }

  for (const sha of liveShas) {
    const localHas = local.hasSync(sha);
    const belongs = ctx.desiredStore(sha);
    const listing = belongs === 'derived' && remote?.derivedStore ? survivingDerived : survivingCas;
    const remoteHas = remote ? listing.has(sha) : false;
    if (!localHas && remoteHas) {
      await ctx.open(sha); // re-cache from the store it belongs in
      result.replicated.push(sha);
      continue;
    }
    if (localHas && remote && !remoteHas) {
      result.replicated.push(...(await ctx.replicate([sha])));
      continue;
    }
    if (!localHas && !remoteHas) result.missing.push(sha);
  }
  return result;
}
