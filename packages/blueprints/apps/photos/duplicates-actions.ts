// Duplicates' one write: the same media.delete_asset/runBatchDelete path as grid+lightbox+selection.
// Narration ONLY via outcomes.ts — frame's one status line, with Undo.
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
  // Undo's manifest, keyed like the restore batch.
  const trashedKeys: string[] = [];
  const total = ids.length;
  const trashNext = async (index: number): Promise<void> => {
    const id = ids[index];
    if (id === undefined) return;
    // Never a spinner (v4 §14).
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
