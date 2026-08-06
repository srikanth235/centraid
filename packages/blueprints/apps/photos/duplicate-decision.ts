// WHICH COPY IS KEPT — the one piece of real logic behind the duplicate
// review (v4 handoff proto :4291-:4303, the `dupereview` tab). Pure, so it is
// tested directly and the view stays a view.
//
// The prototype proposes a copy and labels it `keep · largest`. "Largest" is a
// claim about the rows, so this module only makes it when the rows support it:
// the proposal is `largest` ONLY when exactly one copy in the cluster recorded
// a byte size strictly greater than every other's. A cluster where the sizes
// tie, or where any copy recorded none, gets a proposal with NO reason word
// rather than a word that would be describing something it did not measure
// (§14: omit rather than invent).
//
// Every fallback below is still DETERMINISTIC. Two members opening the same
// cluster, and the same member opening it twice, must be offered the same
// proposal — an order-of-arrival default would silently move which photograph
// a `Trash` press destroys.
import { assetBytes } from "./format.ts";
import type { Asset } from "./types.ts";

/** Why this copy is the proposed keeper, when the rows can say. `null` means
 *  the rows carry no fact that would justify a word, so the view prints none. */
export type KeepReason = "largest" | null;

export interface ClusterDecision {
  /** The copy that survives. Nothing is written about it — keeping is the
   *  absence of a write, which is why it stays in every album it is in. */
  keptId: string;
  reason: KeepReason;
  /** The copies a `Trash` press would move to trash, in cluster order. */
  trashIds: string[];
}

/** Pixel area, or null when either dimension is missing — a partial area is
 *  not a smaller area, it is an unknown one. */
function pixelArea(asset: Asset): number | null {
  const { width, height } = asset;
  if (typeof width !== "number" || typeof height !== "number") return null;
  return width * height;
}

/** Capture time as a comparable number, or null when the row carries none. */
function takenAt(asset: Asset): number | null {
  const raw = asset.taken_at ?? asset.captured_at ?? asset.created_at ?? null;
  if (raw == null) return null;
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The deterministic order the proposal reads off: biggest first.
 *
 * Byte size, then pixel area, then the EARLIEST capture time (of two identical
 * copies the first one taken is the original, and the later ones are the
 * re-imports), then the asset id — which is arbitrary but total, so the
 * comparator never leaves two copies genuinely equal and never depends on the
 * order the query happened to return them in.
 */
function biggerFirst(a: Asset, b: Asset): number {
  const bytes = (assetBytes(b) ?? -1) - (assetBytes(a) ?? -1);
  if (bytes !== 0) return bytes;
  const area = (pixelArea(b) ?? -1) - (pixelArea(a) ?? -1);
  if (area !== 0) return area;
  const time =
    (takenAt(a) ?? Number.MAX_SAFE_INTEGER) -
    (takenAt(b) ?? Number.MAX_SAFE_INTEGER);
  if (time !== 0) return time;
  return a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0;
}

/** Is `keptId`'s byte size strictly the largest in the cluster? Only then may
 *  the view say `largest`. */
function isStrictlyLargest(assets: readonly Asset[], keptId: string): boolean {
  const kept = assets.find((asset) => asset.asset_id === keptId);
  if (!kept) return false;
  const keptBytes = assetBytes(kept);
  if (keptBytes == null) return false;
  return assets.every((asset) => {
    if (asset.asset_id === keptId) return true;
    const other = assetBytes(asset);
    return other != null && other < keptBytes;
  });
}

/**
 * The proposal for one cluster, or the member's own override.
 *
 * `override` is the copy the member picked in the review; it wins whenever it
 * names a copy that is actually in this cluster. A stale override (the member
 * kept a copy, then the cluster reloaded without it) falls back to the
 * proposal rather than silently keeping nothing.
 */
export function decideCluster(
  assets: readonly Asset[],
  override?: string | null
): ClusterDecision | null {
  if (assets.length === 0) return null;
  const overridden =
    override != null && assets.some((asset) => asset.asset_id === override);
  const proposed = [...assets].sort(biggerFirst)[0]!;
  const keptId = overridden ? override! : proposed.asset_id;
  return {
    keptId,
    reason: isStrictlyLargest(assets, keptId) ? "largest" : null,
    trashIds: assets
      .filter((asset) => asset.asset_id !== keptId)
      .map((asset) => asset.asset_id),
  };
}
