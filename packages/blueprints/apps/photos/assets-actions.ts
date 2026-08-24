// Single-asset commands reused from more than one region (the grid tile's
// heart, the lightbox's favorite button). `refresh` is the one piece of
// app.tsx state these need — passed in by the caller on every invocation
// rather than imported, since only app.tsx owns the module-level asset list
// refresh() re-reads.
//
// Every command here is ABOUT an existing asset, so it goes to the scope that
// asset is shown from (#599) — never to the chip selection. Favoriting a
// photo in a shared audience edits it there; the member's own library has no
// copy of it to edit.
//
// There is no single-asset `restoreAsset` here. Trash allows selection (§6),
// so restoring goes through the bar's Trash → Restore swap, batched —
// `runBatchRestore` in selection-actions.ts — even for a selection of one.
import { act, narrate } from "./outcomes.ts";
import type { Asset } from "./types.ts";

export async function toggleFavorite(
  asset: Asset,
  refresh: () => Promise<void>,
  noteEl?: HTMLElement | null
): Promise<void> {
  const outcome = await act(
    "update-asset",
    { asset_id: asset.asset_id, favorite: asset.favorite ? 0 : 1 },
    asset.scope_id
  );
  if (narrate(outcome, noteEl)) await refresh();
}
