import { armConfirm, fmtBytes } from "@centraid/design/elements";

import { Skeleton } from "../../_shared/LoadingSkeleton.tsx";
// The duplicates shelf (issue #352 / #299's deferred duplicates shelf): one
// row per cluster, its assets laid out side by side so the owner can eyeball
// which copy to keep, checkbox-select the redundant ones, and trash them in
// one batch. Pure view — `duplicates.tsx` (the app-root orchestrator) owns
// the load/selection state and passes it down, same split as toolbar.jsx/
// Chips.jsx.
//
// SAME TILE, SAME SELECTION (v4 handoff CHANGELOG §"a shelf is the same
// timeline under a filter"): a cluster row is `justify()`'d exactly like a
// Timeline day-row, and each photograph is the shared `Tile` — the SAME
// --skel ground, the SAME state slot (`on the gateway` / `could not decode`),
// the SAME selection affordance. This shelf's own-scope-only write (§599)
// means every tile is unmarked (no vault slot) and there is nothing to open —
// a cluster is a decision, not a browse — so `onOpen`/`onEnterSelectMode` are
// no-ops and selection is always on.
import { parseAssetKey } from "../asset-key.ts";
import { DUPLICATES } from "../constants.ts";
import { assetBytes } from "../format.ts";
import { justify, rungHeight } from "../layout.ts";
import type { Rung } from "../layout.ts";
import type { Asset, DuplicateCluster } from "../types.ts";
import { duplicatesLede, emptyCopy } from "../view-copy.ts";
import { Tile } from "./Tile.tsx";

import styles from "./Duplicates.module.css";

// A cluster is a decision, not a browse: nothing here opens, and every tile
// starts inside select mode, so these two Tile callbacks never actually fire.
function noop(): void {
  // intentionally empty
}

// THE MEMBER'S RUNG, not a fixed one. Tile size is a member preference with
// four rungs (§4.2), remembered per MEMBER and not per surface — and a shelf
// that pinned itself to S would be a fifth, surface-specific size the member
// never chose. It arrives as a prop because this shelf's own orchestrator
// (duplicates.tsx) has no preference state of its own; `S` remains the
// fallback for a caller that has none to give. `justify()` is handed a
// container far wider than any cluster could fill, so every row stays a single
// trailing (never-stretched) row — same packer, same math as a Timeline row
// that never fills, just deliberately provoked here.
const CLUSTER_RUNG = 1; // S — shows the kind slot (duration / live)
const UNBOUNDED_WIDTH = 100_000;

/**
 * The time window a cluster's copies were taken across (v4 handoff :4439,
 * `within 2 seconds`). Only printed when EVERY copy in the cluster carries a
 * real timestamp — a window computed from a partial set would understate
 * the true span, which is a wrong number, not a rounded one. `null` says
 * honestly that this cluster has nothing to report here (§14: omit rather
 * than invent).
 *
 * Exported because the duplicate REVIEW (DuplicateReview.tsx) states the same
 * fact in its own section head, and the shelf and the review may not derive
 * "within 2 seconds" two ways.
 */
export function fmtClusterWindow(assets: readonly Asset[]): string | null {
  const times = assets
    .map((a) => a.taken_at ?? a.captured_at ?? a.created_at ?? null)
    .map((t) => (t ? new Date(t).getTime() : Number.NaN));
  if (times.some((t) => !Number.isFinite(t)) || times.length < 2) return null;
  const spanS = Math.round((Math.max(...times) - Math.min(...times)) / 1000);
  if (spanS <= 1) return "within 1 second";
  if (spanS < 60) return `within ${spanS} seconds`;
  const spanMin = Math.round(spanS / 60);
  if (spanMin < 60)
    return `within ${spanMin} ${spanMin === 1 ? "minute" : "minutes"}`;
  const spanH = Math.round(spanMin / 60);
  return `within ${spanH} ${spanH === 1 ? "hour" : "hours"}`;
}

/**
 * The per-copy size (v4 handoff :4439, `4.1 MB each`) — the average of the
 * cluster's own recorded byte sizes, read off the rows exactly the way
 * Storage.tsx reads every other size on the app (`assetBytes`). Printed only
 * when every copy in the cluster recorded one; a size averaged over a
 * partial set would claim to describe copies it never measured.
 */
function fmtClusterSize(assets: readonly Asset[]): string | null {
  const sizes = assets
    .map((a) => assetBytes(a))
    .filter((n): n is number => n != null);
  if (sizes.length < assets.length) return null;
  const total = sizes.reduce((sum, n) => sum + n, 0);
  const formatted = fmtBytes(total / sizes.length);
  return formatted ? `${formatted} each` : null;
}

/** The cluster header's meta line — the window, then the size, joined only
 *  where both (or either) are known; `null` when neither is. */
function clusterMeta(cluster: DuplicateCluster): string | null {
  const parts = [
    fmtClusterWindow(cluster.assets),
    fmtClusterSize(cluster.assets),
  ].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function ClusterRow({
  cluster,
  index,
  rung,
  selected,
  onToggle,
}: {
  cluster: DuplicateCluster;
  /** This cluster's position among the loaded clusters — the ordinal the
   *  header reads (`Cluster 1`), not a stable id (§14, proto 4439). */
  index: number;
  rung: Rung;
  selected: Set<string>;
  onToggle: (assetId: string) => void;
}) {
  const [tiles] = justify(cluster.assets, UNBOUNDED_WIDTH, rungHeight(rung));
  const meta = clusterMeta(cluster);
  return (
    <div className={styles.cluster}>
      {/* The same day-block header the Timeline uses (Timeline.module.css's
          `.dayLabel`/`.dayName`/`.dayMeta`, mirrored here rather than
          imported, same as this file's own `.clusterRow` gutter): an
          ordinal + count on the left, the honest "why we think so" meta on
          the right, never invented when the rows don't carry it. */}
      <p className={styles.clusterLabel}>
        <span className={styles.clusterName}>
          {`Cluster ${index + 1} · ${cluster.assets.length} near-identical`}
        </span>
        {meta ? <span className={styles.clusterMeta}>{meta}</span> : null}
      </p>
      <div className={styles.clusterRow}>
        {(tiles ?? []).map((t) => (
          <Tile
            key={`${t.asset.scope_id ?? ""}:${t.asset.asset_id}`}
            asset={t.asset}
            width={t.width}
            height={t.height}
            rung={rung}
            selected={selected.has(t.asset.asset_id)}
            selectMode
            vaultMark={null}
            onOpen={noop}
            onEnterSelectMode={noop}
            onToggleSelect={(key) => onToggle(parseAssetKey(key).assetId)}
          />
        ))}
      </div>
    </div>
  );
}

export function DuplicatesView({
  clusters,
  loading,
  rung = CLUSTER_RUNG,
  selected,
  onToggle,
  onTrashSelected,
}: {
  clusters: DuplicateCluster[] | null;
  loading: boolean;
  /** The member's tile-size rung, 0-3 = XS/S/M/L (§4.2). */
  rung?: Rung;
  selected: Set<string>;
  onToggle: (assetId: string) => void;
  onTrashSelected: () => void;
}) {
  if (clusters == null || loading) {
    return <Skeleton rows={4} />;
  }
  return (
    <div className={styles.shelf}>
      <div className={styles.shelfHead}>
        <p className="kit-muted">
          {clusters.length === 0
            ? emptyCopy(DUPLICATES)
            : duplicatesLede(clusters.length)}
        </p>
      </div>
      {clusters.length > 0 ? (
        <>
          <div className={styles.actions}>
            <span className={styles.count}>
              {selected.size === 0
                ? "Select copies to trash"
                : `${selected.size} selected`}
            </span>
            <button
              type="button"
              className={`kit-btn ${styles.destructive}`}
              disabled={selected.size === 0}
              onClick={(e) => {
                if (selected.size === 0) return;
                if (
                  !armConfirm(e.currentTarget, {
                    armedLabel: `Trash ${selected.size}?`,
                  })
                )
                  return;
                onTrashSelected();
              }}
            >
              Trash selected
            </button>
          </div>
          {clusters.map((cluster, index) => (
            <ClusterRow
              key={cluster.key}
              cluster={cluster}
              index={index}
              rung={rung}
              selected={selected}
              onToggle={onToggle}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}
