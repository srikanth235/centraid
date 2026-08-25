import { armConfirm, fmtBytes } from "@centraid/design/elements";

// THE DUPLICATE REVIEW (v4 handoff proto :4291-:4303, the `dupereview` tab).
//
// The shelf lists clusters; this is where one is actually resolved. The
// prototype draws it as four stacked blocks and this file draws the same four,
// in the same order:
//
//   sectionBlock  `Cluster 2 of 6` · `3 near-identical · within 2 seconds`
//   tilesBlock    the copies, each noted `keep · largest` or `trash`
//   rowsBlock     one readout row per copy, with `keep`/`trash` at the end
//   panelBlock    `Two copies to trash`, the consequence, then the two acts
//   noteBlock     `cluster 2 of 6 · 4 clusters after this one`
//
// SAME TILE, SAME MEANING FOR SELECTION as the shelf (Duplicates.tsx): a
// selected copy is a copy marked for trash. The difference is that a review
// resolves exactly one cluster at a time and exactly one copy survives it, so
// the tile is not a free checkbox — clicking a copy makes THAT copy the keeper
// and every other one trash. Clicking the copy that is already kept does
// nothing, because "keep none" is not one of the answers this screen offers.
//
// NOTHING HERE INVENTS A FACT. The prototype's per-copy line reads
// `4032 × 3024 · 4.1 MB · from this phone`; the cluster query
// (queries/duplicates.ts) carries the dimensions and the byte size but no
// provenance column at all, so the third clause is omitted rather than
// guessed.
import { parseAssetKey } from "../asset-key.ts";
import { decideCluster } from "../duplicate-decision.ts";
import { assetBytes } from "../format.ts";
import { justify, rungHeight } from "../layout.ts";
import type { Rung } from "../layout.ts";
import type { Asset, DuplicateCluster } from "../types.ts";
import { fmtClusterWindow } from "./Duplicates.tsx";
import { Tile } from "./Tile.tsx";

import styles from "./DuplicateReview.module.css";

// The review packs at the shelf's own rung so leaving the list for one cluster
// does not resize the photographs the member was just looking at. `justify()`
// gets a width no cluster can fill, which keeps every cluster a single
// never-stretched row — the same deliberate provocation Duplicates.tsx makes.
const UNBOUNDED_WIDTH = 100_000;

/** `4032 × 3024 · 4.1 MB` — each clause only when the row recorded it. */
function copyFacts(asset: Asset): string | null {
  const parts: string[] = [];
  const { width, height } = asset;
  if (typeof width === "number" && typeof height === "number")
    parts.push(`${width} × ${height}`);
  const size = fmtBytes(assetBytes(asset));
  if (size) parts.push(size);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** What a copy is called. The cluster query joins `core.content_item.title`,
 *  which is the filename for anything imported; a row without one is named by
 *  its position rather than by an id the member has never seen. */
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
    // The row is the same control as the tile above it, not a second readout
    // that disagrees with it: pressing either one moves the keep to this copy.
    // The kept row is inert for the same reason the kept tile is.
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
  /** This cluster's zero-based position in the queue — the ordinal the section
   *  head and the foot note both read (`Cluster 2 of 6`). */
  index: number;
  total: number;
  /** The member's tile-size rung, 0-3 = XS/S/M/L (§4.2). */
  rung: Rung;
  /** The copy the member has chosen to keep, or null to take the proposal. */
  keptId: string | null;
  /** True while this cluster's trash batch is running. The panel keeps its
   *  geometry and its controls; the counts ride the frame's ONE status line
   *  (§14), never a spinner drawn here. */
  busy?: boolean;
  onKeep: (assetId: string) => void;
  onTrashRest: (assetIds: string[]) => void;
  onKeepAll: () => void;
}) {
  const decision = decideCluster(cluster.assets, keptId);
  // A cluster with no copies left cannot be reviewed, and a caller that hands
  // one over has a bug worth seeing rather than a blank panel worth hiding.
  if (!decision) {
    throw new Error("DuplicateReviewView: cluster has no copies to review");
  }
  const { keptId: kept, reason, trashIds } = decision;
  const [tiles] = justify(cluster.assets, UNBOUNDED_WIDTH, rungHeight(rung));
  const span = fmtClusterWindow(cluster.assets);
  const n = trashIds.length;
  const copies = cluster.assets.length;
  const after = total - index - 1;
  // The kept copy's own verdict line: the proposal's reason word when the rows
  // earned one (`keep · largest`), otherwise the bare verdict.
  const keptNote = reason === null ? "keep" : `keep · ${reason}`;
  return (
    <div className={styles.review}>
      {/* sectionBlock('Cluster 2 of 6','3 near-identical · within 2 seconds') */}
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
              // Selected means "marked for trash" here, exactly as on the
              // shelf — so the kept copy is the unselected one.
              selected={!isKept}
              selectMode
              // Duplicates are own-scope only (§599), so nothing is marked.
              vaultMark={null}
              // The state slot carries the verdict (proto: `keep · largest`).
              // The tile's own media state still wins over it, because "could
              // not decode" matters more than a verdict about bytes that never
              // arrived.
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

      {/* panelBlock: what will happen, stated BEFORE it happens, then the two
          acts. The destructive one is an outlined `--net` button that arms
          before it fires — never a fill (§18) — and the status line it leaves
          behind carries Undo, because a trashed photograph is restorable
          (selection-actions.ts's `runBatchRestore`). */}
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

      {/* noteBlock('cluster 2 of 6 · 4 clusters after this one') — the second
          clause is dropped on the last cluster rather than reading "0". */}
      <p className={styles.foot}>
        {after > 0
          ? `cluster ${index + 1} of ${total} · ${after} ${after === 1 ? "cluster" : "clusters"} after this one`
          : `cluster ${index + 1} of ${total}`}
      </p>
    </div>
  );
}
