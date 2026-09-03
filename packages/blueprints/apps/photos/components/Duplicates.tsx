import { armConfirm, fmtBytes } from "@centraid/design/elements";

import { Skeleton } from "../../_shared/LoadingSkeleton.tsx";
import { parseAssetKey } from "../asset-key.ts";
import { DUPLICATES } from "../constants.ts";
import { assetBytes } from "../format.ts";
import { justify, rungHeight } from "../layout.ts";
import type { Rung } from "../layout.ts";
import type { Asset, DuplicateCluster } from "../types.ts";
import { duplicatesLede, emptyCopy } from "../view-copy.ts";
import { Tile } from "./Tile.tsx";

import styles from "./Duplicates.module.css";

function noop(): void {}

const CLUSTER_RUNG = 1; // S — shows the kind slot (duration / live)
const UNBOUNDED_WIDTH = 100_000;

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

function fmtClusterSize(assets: readonly Asset[]): string | null {
  const sizes = assets
    .map((a) => assetBytes(a))
    .filter((n): n is number => n != null);
  if (sizes.length < assets.length) return null;
  const total = sizes.reduce((sum, n) => sum + n, 0);
  const formatted = fmtBytes(total / sizes.length);
  return formatted ? `${formatted} each` : null;
}

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
  index: number;
  rung: Rung;
  selected: Set<string>;
  onToggle: (assetId: string) => void;
}) {
  const [tiles] = justify(cluster.assets, UNBOUNDED_WIDTH, rungHeight(rung));
  const meta = clusterMeta(cluster);
  return (
    <div className={styles.cluster}>
      {/* Timeline day-block header, mirrored not imported: ordinal + count,
          honest meta, omit when the rows don't carry it. */}
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
