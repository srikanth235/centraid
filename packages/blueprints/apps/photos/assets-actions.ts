// Single-asset commands reused from more than one region (the grid tile's
// heart, the lightbox's favorite button, the trash tile's Restore, the
// lightbox delete's Undo). `refresh` is the one piece of app.tsx state these
// need — passed in by the caller on every invocation rather than imported,
// since only app.tsx owns the module-level asset list refresh() re-reads.
import { toast } from './kit.js';
import { act, narrate } from './outcomes.ts';
import type { Asset } from './types.ts';

export async function toggleFavorite(
  asset: Asset,
  refresh: () => Promise<void>,
  noteEl?: HTMLElement | null,
): Promise<void> {
  const outcome = await act('update-asset', {
    asset_id: asset.asset_id,
    favorite: asset.favorite ? 0 : 1,
  });
  if (narrate(outcome, noteEl)) await refresh();
}

// Restore one trashed asset; shared by the trash tile, the delete-toast
// Undo, and the batch Undo-all. Album membership does not come back.
export async function restoreAsset(
  assetId: string,
  refresh: () => Promise<void>,
  { quiet = false }: { quiet?: boolean } = {},
): Promise<boolean> {
  const outcome = await act('restore', { asset_id: assetId });
  if (!narrate(outcome)) return false;
  if (!quiet) toast('Photo restored to your library.');
  await refresh();
  return true;
}
