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
  };
  const { remote, local, cache } = ctx;
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
        if (liveShas.has(sha)) continue;
        // GC-pins-snapshots invariant (issue #436 §6): a blob referenced by any
        // retained snapshot manifest is a live GC root and MUST NOT be deleted,
        // even though the live vault model no longer claims it. CAS has no
        // history — the retained snapshot's reference is the attachment history,
        // and this object is what a recovery-to-N would restore. Pinned here, at
        // the one place a client-owned CAS delete can happen.
        if (options.extraLiveRoots?.has(sha)) continue;
        if (options.skipOrphanDelete) {
          result.orphansSkipped.push(sha);
          continue;
        }
        await tier.store.delete(sha);
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
