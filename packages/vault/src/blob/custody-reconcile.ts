// Deep reconciliation sweep (#296). Store-aware (#425): list every granted
// store class (cas, and derived when the tier has one), delete orphans out of
// each, heal the replica index per store, and re-push a missing live sha to
// the store class it BELONGS in.

import type { BlobCache } from "./cache.js";
import type {
  ReconcileOptions,
  ReconcileResult,
  RemoteTier,
} from "./custody-types.js";
import type { LocalBlobStore } from "./local.js";
import type { OrphanTombstoneIndex } from "./orphan-tombstone.js";
import type { ReplicaStore } from "./replica-index.js";

export interface ReconcileContext {
  remote: RemoteTier | null;
  local: LocalBlobStore;
  cache?: BlobCache;
  desiredStore: (sha: string) => ReplicaStore;
  open: (sha: string) => Promise<unknown>;
  replicate: (shas: string[]) => Promise<string[]>;
  /**
   * Orphan-grace tombstones (#439). Absent ⇒ a requested window fails safe
   * (holds, never deletes).
   */
  orphans?: OrphanTombstoneIndex;
}

export async function reconcileCustody(
  ctx: ReconcileContext,
  liveShas: Set<string>,
  options: ReconcileOptions
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
  const casShas = remote
    ? new Set(await remote.store.list())
    : new Set<string>();
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
      store: NonNullable<RemoteTier["derivedStore"]>;
    }[] = [
      {
        class: "cas",
        listed: casShas,
        surviving: survivingCas,
        store: remote.store,
      },
    ];
    if (remote.derivedStore) {
      stores.push({
        class: "derived",
        listed: derivedShas,
        surviving: survivingDerived,
        store: remote.derivedStore,
      });
    }
    const reconcileTier = async (tierIndex: number): Promise<void> => {
      const tier = stores[tierIndex];
      if (tier === undefined) return;
      const listed = [...tier.listed];
      const reconcileSha = async (shaIndex: number): Promise<void> => {
        const sha = listed[shaIndex];
        if (sha === undefined) return reconcileTier(tierIndex + 1);
        // Live sha is re-referenced: it can carry no orphan tombstone. Clear
        // any stale one (#439 R4 — live again before grace elapses loses its
        // tombstone) and skip.
        if (liveShas.has(sha)) {
          ctx.orphans?.clear(sha);
          return reconcileSha(shaIndex + 1);
        }
        // GC-pins-snapshots (#436): a blob referenced by any retained snapshot
        // manifest is a live GC root and MUST NOT be deleted, even though the
        // live vault model no longer claims it. CAS has no history — the
        // retained snapshot's reference is the attachment history. Pinned
        // here, the one place a client-owned CAS delete can happen. A pinned
        // root is not orphaned, so it never earns a tombstone — check precedes
        // the grace gate, keeping pinned objects out of blob_orphan.
        if (options.extraLiveRoots?.has(sha)) return reconcileSha(shaIndex + 1);
        if (options.skipOrphanDelete) {
          result.orphansSkipped.push(sha);
          return reconcileSha(shaIndex + 1);
        }
        // Orphan-grace (#439). With a window in force, a freshly-found orphan
        // is tombstoned and HELD, not deleted: PITR makes every instant inside
        // the recovery window restorable, and a blob referenced only BETWEEN
        // two snapshots is exactly the byte such a restore replays. Delete only
        // once first-observed-orphaned is older than the window. A window with
        // no tombstone store fails safe (holds).
        if (options.graceWindowMs !== undefined) {
          if (!ctx.orphans) {
            result.orphansGraceHeld.push(sha);
            return reconcileSha(shaIndex + 1);
          }
          const firstOrphanedAt = ctx.orphans.markFirstSeen(sha, now());
          if (now() - firstOrphanedAt <= options.graceWindowMs) {
            result.orphansGraceHeld.push(sha);
            return reconcileSha(shaIndex + 1);
          }
        }
        await tier.store.delete(sha);
        ctx.orphans?.clear(sha);
        tier.surviving.delete(sha);
        cache?.replica.unmark(sha);
        result.orphansDeleted.push(sha);
        return reconcileSha(shaIndex + 1);
      };
      return reconcileSha(0);
    };
    await reconcileTier(0);
  }

  // Heal each store's rows against ITS listing (#425) — listing is truth.
  if (cache && remote) {
    const sizeOf = (sha: string): number => local.statSync(sha)?.size ?? 0;
    cache.replica.heal("cas", survivingCas, sizeOf);
    if (remote.derivedStore)
      cache.replica.heal("derived", survivingDerived, sizeOf);
  }

  const reconcileLiveSha = async (
    shas: readonly string[],
    index: number
  ): Promise<void> => {
    const sha = shas[index];
    if (sha === undefined) return;
    const localHas = local.hasSync(sha);
    const belongs = ctx.desiredStore(sha);
    const listing =
      belongs === "derived" && remote?.derivedStore
        ? survivingDerived
        : survivingCas;
    const remoteHas = remote ? listing.has(sha) : false;
    if (!localHas && remoteHas) {
      await ctx.open(sha);
      result.replicated.push(sha);
      return reconcileLiveSha(shas, index + 1);
    }
    if (localHas && remote && !remoteHas) {
      result.replicated.push(...(await ctx.replicate([sha])));
      return reconcileLiveSha(shas, index + 1);
    }
    if (!localHas && !remoteHas) result.missing.push(sha);
    return reconcileLiveSha(shas, index + 1);
  };
  await reconcileLiveSha([...liveShas], 0);
  return result;
}
