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
        if (liveShas.has(sha)) {
          ctx.orphans?.clear(sha);
          return reconcileSha(shaIndex + 1);
        }
        if (options.extraLiveRoots?.has(sha)) return reconcileSha(shaIndex + 1);
        if (options.skipOrphanDelete) {
          result.orphansSkipped.push(sha);
          return reconcileSha(shaIndex + 1);
        }
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
