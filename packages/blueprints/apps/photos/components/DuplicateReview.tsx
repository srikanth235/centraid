import { armConfirm, fmtBytes } from "@centraid/design/elements";

import { parseAssetKey } from "../asset-key.ts";
import { decideCluster } from "../duplicate-decision.ts";
import { assetBytes } from "../format.ts";
import { justify, rungHeight } from "../layout.ts";
import type { Rung } from "../layout.ts";
import type { Asset, DuplicateCluster } from "../types.ts";
import { fmtClusterWindow } from "./Duplicates.tsx";
import { Tile } from "./Tile.tsx";

import styles from "./DuplicateReview.module.css";

const UNBOUNDED_WIDTH = 100_000;

function copyFacts(asset: Asset): string | null {
  const parts: string[] = [];
  const { width, height } = asset;
  if (typeof width === "number" && typeof height === "number")
    parts.push(`${width} × ${height}`);
  const size = fmtBytes(assetBytes(asset));
  if (size) parts.push(size);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function copyName(asset: Asset, index: number): string {
  const title = asset.title;
  return title != null && title !== "" ? title : `Copy ${index + 1}`;
}

function CopyRow({
  asset,
  index,
  kept,
  onKeep,
}: {
  asset: Asset;
  index: number;
  kept: boolean;
  onKeep: () => void;
}) {
  const facts = copyFacts(asset);
  return (
    <button
      type="button"
      className={styles.copyRow}
      data-kept={kept ? "true" : "false"}
      disabled={kept}
      onClick={onKeep}
    >
      <span className={styles.copyName}>{copyName(asset, index)}</span>
      {facts ? <span className={styles.copyFacts}>{facts}</span> : null}
      <span className={styles.copyVerdict}>{kept ? "keep" : "trash"}</span>
    </button>
  );
}

export function DuplicateReviewView({
  cluster,
  index,
  total,
  rung,
  keptId,
  busy = false,
  onKeep,
  onTrashRest,
  onKeepAll,
}: {
  cluster: DuplicateCluster;
  index: number;
  total: number;
  rung: Rung;
  keptId: string | null;
  busy?: boolean;
  onKeep: (assetId: string) => void;
  onTrashRest: (assetIds: string[]) => void;
  onKeepAll: () => void;
}) {
  const decision = decideCluster(cluster.assets, keptId);
  if (!decision) {
    throw new Error("DuplicateReviewView: cluster has no copies to review");
  }
  const { keptId: kept, reason, trashIds } = decision;
  const [tiles] = justify(cluster.assets, UNBOUNDED_WIDTH, rungHeight(rung));
  const span = fmtClusterWindow(cluster.assets);
  const n = trashIds.length;
  const copies = cluster.assets.length;
  const after = total - index - 1;
  const keptNote = reason === null ? "keep" : `keep · ${reason}`;
  return (
    <div className={styles.review}>
      {/* head */}
      <p className={styles.sectionLabel}>
        <span
          className={styles.sectionName}
        >{`Cluster ${index + 1} of ${total}`}</span>
        <span className={styles.sectionMeta}>
          {span
            ? `${copies} near-identical · ${span}`
            : `${copies} near-identical`}
        </span>
      </p>

      <div className={styles.copies}>
        {(tiles ?? []).map((t) => {
          const isKept = t.asset.asset_id === kept;
          return (
            <Tile
              key={`${t.asset.scope_id ?? ""}:${t.asset.asset_id}`}
              asset={t.asset}
              width={t.width}
              height={t.height}
              rung={rung}
              selected={!isKept}
              selectMode
              vaultMark={null}
              note={isKept ? keptNote : "trash"}
              onOpen={(key) => onKeep(parseAssetKey(key).assetId)}
              onToggleSelect={(key) => onKeep(parseAssetKey(key).assetId)}
              onEnterSelectMode={() => undefined}
            />
          );
        })}
      </div>

      <div className={styles.rows}>
        {cluster.assets.map((asset, i) => (
          <CopyRow
            key={`${asset.scope_id ?? ""}:${asset.asset_id}`}
            asset={asset}
            index={i}
            kept={asset.asset_id === kept}
            onKeep={() => onKeep(asset.asset_id)}
          />
        ))}
      </div>

      {/* Consequence first. Destructive act is an outlined `--net` that arms
          before it fires, never a fill (§18). */}
      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>
          {n === 1 ? "One copy to trash" : `${n} copies to trash`}
        </h3>
        <p className={styles.panelBody}>
          {`The copy you keep stays in every album it is already in, and keeps its caption. ${
            n === 1 ? "The other copy goes" : `The other ${n} go`
          } to trash for 30 days.`}
        </p>
        <div className={styles.panelActions}>
          <button
            type="button"
            className="kit-btn"
            disabled={busy}
            onClick={onKeepAll}
          >
            {`Keep all ${copies}`}
          </button>
          <button
            type="button"
            className={`kit-btn ${styles.destructive}`}
            disabled={busy}
            onClick={(e) => {
              if (busy) return;
              if (
                !armConfirm(e.currentTarget, {
                  armedLabel: n === 1 ? "Trash 1 copy?" : `Trash ${n} copies?`,
                })
              )
                return;
              onTrashRest(trashIds);
            }}
          >
            {n === 1 ? "Trash 1 copy" : `Trash ${n} copies`}
          </button>
        </div>
      </div>

      {/* No trailing clause on the last cluster, never "0". */}
      <p className={styles.foot}>
        {after > 0
          ? `cluster ${index + 1} of ${total} · ${after} ${after === 1 ? "cluster" : "clusters"} after this one`
          : `cluster ${index + 1} of ${total}`}
      </p>
    </div>
  );
}
