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
