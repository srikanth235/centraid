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

/**
 * SANITY BEFORE A DESTRUCTIVE DIFF (#1014, B23).
 *
 * Reconcile deletes every listed key the live model does not claim. The
 * listing was taken entirely on trust: a provider mid-outage returning a short
 * page, a misconfigured endpoint answering for a DIFFERENT prefix, or a
 * truncated pagination all produced a listing that looked authoritative, and
 * the sweep deleted against it. `blob_replica` is this host's own durable
 * evidence of what it pushed, so it is the floor a listing has to clear.
 *
 * Below this fraction of that evidence the destructive half is SKIPPED for
 * that store class — nothing is deleted, the reason rides the result, and the
 * healing/re-push half still runs (it only ever adds).
 */
export const DEFAULT_MIN_LISTING_COVERAGE = 0.5;

/** A content address, and nothing else, is deletable as an orphan. */
const SHA256_KEY = /^[0-9a-f]{64}$/u;

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
    listingsRefused: [],
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
    const coverage = options.minListingCoverage ?? DEFAULT_MIN_LISTING_COVERAGE;
    const reconcileTier = async (tierIndex: number): Promise<void> => {
      const tier = stores[tierIndex];
      if (tier === undefined) return;
      // NOT A CONTENT ADDRESS, NOT AN ORPHAN. A key that is not a sha256 was
      // not written by this vault's CAS, whatever the endpoint says it holds.
      const foreign = [...tier.listed].filter((key) => !SHA256_KEY.test(key));
      if (foreign.length > 0) {
        // Out of BOTH sets: `surviving` feeds `replica.heal`, and a key that
        // is not a content address must not enter this host's index either.
        for (const key of foreign) {
          tier.listed.delete(key);
          tier.surviving.delete(key);
        }
        result.listingsRefused.push({
          store: tier.class,
          reason:
            `${foreign.length} listed key(s) are not content addresses ` +
            `(first: ${foreign[0]}); they were left alone`,
        });
      }
      // The size sanity bound. `blob_replica` is what this host PROVED it
      // pushed, so a listing far below it is a listing to distrust, not a
      // deletion order.
      const evidence = ctx.cache?.replica.all(tier.class).size ?? 0;
      if (
        coverage > 0 &&
        evidence > 0 &&
        tier.listed.size < evidence * coverage
      ) {
        result.listingsRefused.push({
          store: tier.class,
          reason:
            `listing returned ${tier.listed.size} object(s) where this host has ` +
            `evidence of ${evidence}; the orphan delete was skipped`,
        });
        // Every unclaimed key is SPARED, and reported as spared — the same
        // shape `skipOrphanDelete` produces, because it is the same decision.
        for (const sha of tier.listed)
          if (!liveShas.has(sha)) result.orphansSkipped.push(sha);
        return reconcileTier(tierIndex + 1);
      }
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
