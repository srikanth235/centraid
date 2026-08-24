// Emptying the trash, on the phone (v4 handoff §4.5, proto:4800-4803).
//
// The two facts worth their own module, both pure and both tested:
//
//  1. ORDER. `media_asset.source_asset_id` (#711) is a real FK, so
//     the vault REFUSES to delete a photograph forever while an edited copy
//     still names it as its source — NULLing the copy's lineage would forge
//     "camera original", and cascading would destroy something the member
//     never trashed. A trash holding both must therefore send the copy first.
//     Without this the member would press `Empty trash` and be left with the
//     originals, for no reason they could see.
//  2. THE SUMMARY SENTENCE, which must never offer an undo. There is nothing
//     on the other side of this write.
//
// The web has the same two facts in `packages/blueprints/apps/photos/
// trash-actions.ts`. They are stated twice on purpose: the two clients have
// genuinely different asset models (`PhotoAsset` here, the query's `Asset`
// there) and no shared module between them, and a fake shared layer over two
// different shapes would cost more than the fifteen lines it saved.

import type { VaultAsset } from "./photos-selection-writes";

/**
 * The trash, ordered so an edited copy always precedes the source it names.
 * `sourceOf` answers "which asset were these bytes derived from?" — read off
 * the replica's own `media.asset` rows, since the timeline model does
 * not carry lineage.
 *
 * Stable for everything with no lineage in the set, and total: a two-row
 * lineage cycle (which the schema's self-CHECK cannot rule out) yields some
 * order rather than an unbounded walk. One of that pair is then unpurgeable
 * and the vault says so — but the control must not hang.
 */
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

/** How an empty-trash run went. */
export interface EmptyTrashTally {
  purged: number;
  /** Refused or queued — anything that is still in the trash afterwards. */
  kept: number;
}

/** The sentence the run reports. Never the word Undo: there is no undo. */
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

/**
 * The confirmation, in words — shown BEFORE anything is destroyed, naming the
 * exact number, what leaves with them, and that it cannot be undone. Split
 * into title and body because that is the shape a native alert takes.
 */
export const EMPTY_TRASH_CONFIRM = {
  title: (count: number) =>
    `Delete ${count} ${count === 1 ? "photograph" : "photographs"} forever?`,
  body: (count: number) =>
    `This cannot be undone. ${count === 1 ? "It leaves" : "They leave"} your library now — with ${count === 1 ? "its" : "their"} captions, faces, tags and album membership — and the space ${count === 1 ? "it holds is" : "they hold is"} freed shortly afterwards. Restore will not bring ${count === 1 ? "it" : "them"} back.`,
  confirm: (count: number) => `Delete ${count} forever`,
  cancel: "Keep them",
} as const;
