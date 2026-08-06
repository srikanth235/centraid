import type { ReactNode } from "react";

// The duplicates surfaces' render orchestrator (issue #352 phase 3) — same
// shape as toolbar.jsx: owns its own private state (the loaded clusters, which
// asset ids are checked, where the review has got to) and renders into the
// SAME `gridRoot` the library/trash views use, since selecting the Duplicates
// chip swaps what `#grid` shows exactly the way selecting Trash already does
// (app.tsx's renderGrid()). Loaded lazily — the query walks up to 4000 live
// assets, so it only runs once the owner actually opens this shelf, not on
// every refresh() the way the (bounded, cheap) library window does.
//
// TWO SURFACES, ONE STATE (v4 handoff proto :4291, the `dupereview` tab).
// The SHELF lists the clusters; the REVIEW steps through them one at a time
// and resolves each. Both render into the same slot and both trash through
// `trashDuplicateAssets`, so there is one loaded list, one scope, and one
// write — the review is a mode over the shelf's data, not a second copy of it.
import { DuplicateReviewView } from "./components/DuplicateReview.tsx";
import { DuplicatesView } from "./components/Duplicates.tsx";
import { trashDuplicateAssets } from "./duplicates-actions.ts";
import type { Rung } from "./layout.ts";
import type { DuplicateCluster } from "./types.ts";

type Root = { render: (node: ReactNode) => void };

// Duplicates stay OWN-SCOPE (issue #599): near-duplicate clusters are computed
// by a query that walks one scope's assets, and "which copy do I keep?" is only
// a meaningful question inside the space the member controls. The shelf's one
// write therefore lands in the member's own scope, which `ownScope` resolves.
// TILE SIZE IS ONE MEMBER PREFERENCE (§4.2), so this shelf reads the same one
// the timeline does rather than pinning itself to a size the member never
// chose. It is a getter, not a value: the preference can change (the stepper,
// a pinch) between one render of this shelf and the next.
export function createDuplicates({
  gridRoot,
  refresh,
  ownScope,
  rung,
}: {
  gridRoot: Root;
  refresh: () => Promise<void>;
  ownScope: () => string | null;
  rung: () => Rung;
}) {
  let clusters: DuplicateCluster[] | null = null; // null = not yet loaded
  let loading = false;
  const selected = new Set<string>();

  // ---- the review queue ----
  //
  // A SNAPSHOT, taken when the review opens, and NOT the live `clusters` list.
  // The queue's length is the denominator the member reads on every step
  // ("cluster 2 of 6 · 4 clusters after this one"); resolving a cluster
  // shortens the live list, and a denominator that shrank under the member
  // between two steps would be telling them the queue got shorter than the one
  // they agreed to walk.
  let queue: DuplicateCluster[] = [];
  let at = -1; // -1 = not reviewing
  let busy = false;
  /** The copy the member chose to keep, per cluster key. A cluster with no
   *  entry takes `decideCluster`'s own proposal. */
  const keptByCluster = new Map<string, string>();

  function renderDuplicates() {
    const cluster = at >= 0 ? queue[at] : undefined;
    if (cluster) {
      gridRoot.render(
        <DuplicateReviewView
          cluster={cluster}
          index={at}
          total={queue.length}
          rung={rung()}
          keptId={keptByCluster.get(cluster.key) ?? null}
          busy={busy}
          onKeep={(assetId) => {
            keptByCluster.set(cluster.key, assetId);
            renderDuplicates();
          }}
          onKeepAll={() => {
            if (busy) return;
            advance();
          }}
          onTrashRest={(assetIds) => void resolveCluster(cluster, assetIds)}
        />
      );
      return;
    }
    gridRoot.render(
      <DuplicatesView
        clusters={clusters}
        loading={loading}
        rung={rung()}
        selected={selected}
        onToggle={(assetId) => {
          if (selected.has(assetId)) selected.delete(assetId);
          else selected.add(assetId);
          renderDuplicates();
        }}
        onTrashSelected={async () => {
          const ids = [...selected];
          await trashDuplicateAssets(ids, { refresh, scope: ownScope() });
          dropTrashed(ids);
          selected.clear();
          renderDuplicates();
        }}
      />
    );
  }

  /** Take the trashed ids out of the loaded list, and drop any cluster left
   *  with fewer than two live copies — a cluster of one is not a question. */
  function dropTrashed(ids: readonly string[]): void {
    const trashedIds = new Set(ids);
    clusters = (clusters ?? [])
      .map((c) => ({
        ...c,
        assets: c.assets.filter((a) => !trashedIds.has(a.asset_id)),
      }))
      .filter((c) => c.assets.length >= 2);
  }

  /** Step to the next cluster in the queue, or leave the review when the queue
   *  is done — the member is returned to the shelf they came from rather than
   *  left on a cluster that no longer exists. */
  function advance(): void {
    at = at + 1 < queue.length ? at + 1 : -1;
    if (at === -1) queue = [];
    renderDuplicates();
  }

  /** Trash this cluster's redundant copies, then step on. The panel stays put
   *  and goes inert while the batch runs (§14) — the counts ride the frame's
   *  one status line, and a second press cannot start a second pass. */
  async function resolveCluster(
    cluster: DuplicateCluster,
    assetIds: string[]
  ): Promise<void> {
    if (busy) return;
    busy = true;
    renderDuplicates();
    try {
      await trashDuplicateAssets(assetIds, { refresh, scope: ownScope() });
      dropTrashed(assetIds);
      keptByCluster.delete(cluster.key);
    } finally {
      busy = false;
    }
    advance();
  }

  // Called from renderGrid() every time the Duplicates chip is showing —
  // a no-op once loaded (or while a load is already in flight).
  async function ensureLoaded() {
    if (clusters != null || loading) return;
    loading = true;
    renderDuplicates();
    let data: { clusters?: DuplicateCluster[] } | undefined;
    try {
      data = await window.centraid.read<{ clusters?: DuplicateCluster[] }>({
        query: "duplicates",
        input: {},
      });
    } catch {
      data = undefined;
    }
    clusters = data?.clusters ?? [];
    loading = false;
    renderDuplicates();
  }

  /** Open the review on the first loaded cluster (proto :4803 — the shelf's
   *  own app-bar primary, `Review duplicates`). A no-op with nothing loaded
   *  to review, which is why the control that calls it is only offered once
   *  `count()` has answered with a positive number. */
  function openReview(): void {
    const loaded = clusters ?? [];
    if (loaded.length === 0) return;
    queue = loaded;
    at = 0;
    busy = false;
    keptByCluster.clear();
    renderDuplicates();
  }

  /** Leave the review without resolving anything, back to the shelf. */
  function exitReview(): void {
    if (at === -1) return;
    at = -1;
    queue = [];
    keptByCluster.clear();
    renderDuplicates();
  }

  /** Is the review the surface on screen? The app bar's title reads off this
   *  (proto :3964 — `Duplicate review`). */
  function reviewing(): boolean {
    return at >= 0;
  }

  // Forces the next visit to re-fetch — called when leaving the shelf, so a
  // trash/upload done elsewhere doesn't leave a stale cluster list behind.
  function invalidate() {
    clusters = null;
    selected.clear();
    at = -1;
    queue = [];
    keptByCluster.clear();
  }

  // The app bar's count (§3, proto 3943 `Duplicates · 6 clusters`) — `null`
  // until the first load lands, same "not yet answered" contract the rest of
  // the shelves' counts follow (app-root.tsx's `countFor`).
  function count(): number | null {
    return clusters?.length ?? null;
  }

  return {
    ensureLoaded,
    renderDuplicates,
    invalidate,
    count,
    openReview,
    exitReview,
    reviewing,
  };
}
