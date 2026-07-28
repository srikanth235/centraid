// Single-asset commands reused from more than one region (the grid tile's
// heart, the lightbox's favorite button, the trash tile's Restore, the
// lightbox delete's Undo). `refresh` is the one piece of app.tsx state these
// need — passed in by the caller on every invocation rather than imported,
// since only app.tsx owns the module-level asset list refresh() re-reads.
//
// Every command here is ABOUT an existing asset, so it goes to the scope that
// asset is shown from (issue #599) — never to the chip selection. Favoriting a
// photo in a shared audience edits it there; the member's own library has no
// copy of it to edit.
import { toast } from './kit.ts';
import { act, narrate } from './outcomes.ts';
import type { Asset } from './types.ts';

export async function toggleFavorite(
  asset: Asset,
  refresh: () => Promise<void>,
  noteEl?: HTMLElement | null,
): Promise<void> {
  const outcome = await act(
    'update-asset',
    { asset_id: asset.asset_id, favorite: asset.favorite ? 0 : 1 },
    asset.scope_id,
  );
  if (narrate(outcome, noteEl)) await refresh();
}

// Restore one trashed asset; shared by the trash tile, the delete-toast
// Undo, and the batch Undo-all. Album membership does not come back.
export async function restoreAsset(
  assetId: string,
  refresh: () => Promise<void>,
  { quiet = false, scope }: { quiet?: boolean; scope?: string | null } = {},
): Promise<boolean> {
  const outcome = await act('restore', { asset_id: assetId }, scope);
  if (!narrate(outcome)) return false;
  if (!quiet) toast('Photo restored to your library.');
  await refresh();
  return true;
}
