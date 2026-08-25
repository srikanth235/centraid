// Emptying trash on the phone (v4 §4.5). `source_asset_id` is a real FK
// (#711): copies must leave before the originals they name. The summary
// must never offer undo.

import type { VaultAsset } from "./photos-selection-writes";

/** Copies before sources. A lineage cycle must terminate, not hang. */
export function emptyTrashOrder(
  targets: readonly VaultAsset[],
  sourceOf: (assetId: string) => string | undefined
): VaultAsset[] {
  const done = new Set<string>();
  const visiting = new Set<string>();
  const ordered: VaultAsset[] = [];
  const visit = (asset: VaultAsset): void => {
    if (done.has(asset.assetId) || visiting.has(asset.assetId)) return;
    visiting.add(asset.assetId);
    for (const candidate of targets) {
      if (sourceOf(candidate.assetId) === asset.assetId) visit(candidate);
    }
    visiting.delete(asset.assetId);
    done.add(asset.assetId);
    ordered.push(asset);
  };
  for (const asset of targets) visit(asset);
  return ordered;
}

export interface EmptyTrashTally {
  purged: number;
  kept: number;
}

export function emptyTrashSummary({ purged, kept }: EmptyTrashTally): string {
  const parts: string[] = [];
  if (purged > 0) {
    parts.push(
      `Deleted ${purged} ${purged === 1 ? "photograph" : "photographs"} forever`
    );
  }
  if (kept > 0) parts.push(`${kept} kept`);
  return parts.join(" · ") || "Nothing to delete";
}

export const EMPTY_TRASH_CONFIRM = {
  title: (count: number) =>
    `Delete ${count} ${count === 1 ? "photograph" : "photographs"} forever?`,
  body: (count: number) =>
    `This cannot be undone. ${count === 1 ? "It leaves" : "They leave"} your library now — with ${count === 1 ? "its" : "their"} captions, faces, tags and album membership — and the space ${count === 1 ? "it holds is" : "they hold is"} freed shortly afterwards. Restore will not bring ${count === 1 ? "it" : "them"} back.`,
  confirm: (count: number) => `Delete ${count} forever`,
  cancel: "Keep them",
} as const;
