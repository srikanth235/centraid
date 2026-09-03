import { assetKey } from "./asset-key.ts";
import { TRASH } from "./constants.ts";
import { dayKey, fmtDay, fmtMonth } from "./format.ts";
import type { Asset } from "./types.ts";

export interface Visibility {
  visibleAssets: () => Asset[];
  findAsset: (key: string) => Asset | undefined;
}

export function createVisibility({
  getAssets,
  getTrash,
  getAlbumAssets,
  getSearchResults,
  getSearchQuery,
  getSelectedAlbum,
}: {
  getAssets: () => Asset[];
  getTrash: () => Asset[];
  getAlbumAssets: () => Asset[];
  getSearchResults: () => Asset[] | null;
  getSearchQuery: () => string;
  getSelectedAlbum: () => string | null;
}): Visibility {
  function matchesSearchLocal(asset: Asset): boolean {
    const query = getSearchQuery();
    const key = dayKey(asset.taken_at);
    const hay = [
      asset.title,
      asset.kind,
      asset.media_type,
      key,
      fmtDay(key),
      fmtMonth(key.slice(0, 7)),
      ...(asset.album_titles ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/u)
      .every((token) => hay.includes(token));
  }

  function visibleAssets(): Asset[] {
    const query = getSearchQuery();
    const selectedAlbum = getSelectedAlbum();
    if (!query) return getAlbumAssets();
    if (selectedAlbum === TRASH) return getTrash().filter(matchesSearchLocal);
    const scoped = getAlbumAssets();
    const scopedKeys = selectedAlbum ? new Set(scoped.map(assetKey)) : null;
    const merged = new Map<string, Asset>();
    for (const a of scoped.filter(matchesSearchLocal))
      merged.set(assetKey(a), a);
    for (const a of getSearchResults() ?? []) {
      if (scopedKeys && !scopedKeys.has(assetKey(a))) continue;
      merged.set(assetKey(a), a);
    }
    return [...merged.values()];
  }

  function findAsset(key: string): Asset | undefined {
    const match = (a: Asset): boolean => assetKey(a) === key;
    return (
      getAssets().find(match) ??
      getTrash().find(match) ??
      (getSearchResults() ?? []).find(match)
    );
  }

  return { visibleAssets, findAsset };
}
