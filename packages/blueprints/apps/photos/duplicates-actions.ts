// The duplicates surfaces' one write: trash the redundant copies through the
// SAME media.delete_asset the grid/lightbox/selection-bar use
// (selection-actions.ts's runBatchDelete) — a "duplicate" is not a distinct
// kind of delete, just a different way of arriving at the asset id. Both the
// shelf (select copies, trash the batch) and the review (keep one copy, trash
// the rest) land here, so the two cannot mean two different things.
//
// NARRATION GOES THROUGH outcomes.ts, NOT kit.ts's `statusLine`. The ONE
// status line is the frame's (`frame.setStatus`, via `notice`) — this module
// used to write to the kit's own DOM status-line host instead, which put a
// second status surface on screen for exactly one of this app's writes, and
// dropped the Undo the same delete offers everywhere else. Trashing IS
// undoable: `restore` puts the asset back, which is what runBatchRestore
// fires, so the summary carries Undo rather than implying a finality that is
// not true.
import { assetRefKey } from "./asset-key.ts";
import { act, narrate, notice } from "./outcomes.ts";
import { runBatchRestore } from "./selection-actions.ts";

export async function trashDuplicateAssets(
  ids: string[],
  { refresh, scope }: { refresh: () => Promise<void>; scope?: string | null }
): Promise<number> {
  let parked = 0;
  let queued = 0;
  let failed = 0;
  let lastBad: VaultOutcome | undefined = undefined;
  // What actually landed in the trash — Undo's manifest, as composite keys,
  // because that is what the restore batch is addressed by (asset-key.ts).
  const trashedKeys: string[] = [];
  const total = ids.length;
  const trashNext = async (index: number): Promise<void> => {
    const id = ids[index];
    if (id === undefined) return;
    // Determinate progress, exact counts, never a spinner (v4 §14) — the
    // frame's ONE status line carries `done`/`total` while the batch runs,
    // and the final tally below replaces it in place.
    notice("Trashing duplicates", undefined, { done: index, total });
    const outcome = await act("delete-asset", { asset_id: id }, scope);
    if (outcome?.status === "executed")
      trashedKeys.push(assetRefKey(scope, id));
    else if (outcome?.status === "parked") parked += 1;
    else if (outcome?.status === "queued" || outcome?.status === "in-flight")
      queued += 1;
    else {
      failed += 1;
      lastBad = outcome;
    }
    return trashNext(index + 1);
  };
  await trashNext(0);
  await refresh();
  const ok = trashedKeys.length;
  const parts: string[] = [];
  if (ok > 0)
    parts.push(`Moved ${ok} duplicate${ok === 1 ? "" : "s"} to trash`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (failed > 0) parts.push(`${failed} failed`);
  const summary = parts.join(" · ") || "Nothing to do";
  if (ok > 0)
    notice(summary, () => void runBatchRestore(trashedKeys, { refresh }));
  else notice(summary);
  if (lastBad) narrate(lastBad);
  return ok;
}
