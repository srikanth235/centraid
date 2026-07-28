// The duplicates shelf's one write: trash the selected redundant copies
// through the SAME media.delete_asset the grid/lightbox/selection-bar use
// (selection-actions.ts's runBatchDelete) — a "duplicate" is not a distinct
// kind of delete, just a different way of arriving at the asset id.
import { toast } from './kit.ts';
import { act, narrate } from './outcomes.ts';

export async function trashDuplicateAssets(
  ids: string[],
  { refresh, scope }: { refresh: () => Promise<void>; scope?: string | null },
): Promise<number> {
  let ok = 0;
  let parked = 0;
  let queued = 0;
  let failed = 0;
  let lastBad: VaultOutcome | undefined = undefined;
  const trashNext = async (index: number): Promise<void> => {
    const id = ids[index];
    if (id === undefined) return;
    const outcome = await act('delete-asset', { asset_id: id }, scope);
    if (outcome?.status === 'executed') ok += 1;
    else if (outcome?.status === 'parked') parked += 1;
    else if (outcome?.status === 'queued' || outcome?.status === 'in-flight') queued += 1;
    else {
      failed += 1;
      lastBad = outcome;
    }
    return trashNext(index + 1);
  };
  await trashNext(0);
  await refresh();
  const parts: string[] = [];
  if (ok > 0) parts.push(`Moved ${ok} duplicate${ok === 1 ? '' : 's'} to trash`);
  if (parked > 0) parts.push(`${parked} awaiting approval`);
  if (queued > 0) parts.push(`${queued} saved offline`);
  if (failed > 0) parts.push(`${failed} failed`);
  toast(parts.join(' · ') || 'Nothing to do');
  if (lastBad) narrate(lastBad);
  return ok;
}
