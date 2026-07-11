// What the grid/lightbox consider "currently visible" (issue #352's search
// augment lives here): the album filter, then the search filter, plus the
// asset lookup the lightbox needs to reach an off-window search hit.
// app.jsx still owns the underlying `assets`/`trash`/`searchResults` arrays
// and passes them in as getters — same split toolbar.jsx/picker.jsx use for
// their own regions — so this stays pure, DOM-free, and easy to reason about
// on its own.
import { TRASH } from './constants.js';
import { dayKey, fmtDay, fmtMonth } from './format.js';

export function createVisibility({
  getAssets,
  getTrash,
  getAlbumAssets,
  getSearchResults,
  getSearchQuery,
  getSelectedAlbum,
}) {
  // Client-side fallback/extras: day/month labels, kind, and album NAMES stay
  // a cheap local match (queries/search.js's own doc comment explains why
  // album-name matching isn't worth a vault round trip). `asset.title` still
  // rides along here too — that keeps search over the loaded window working
  // even while the server call (title/caption FTS) is in flight, has failed,
  // or was denied.
  function matchesSearchLocal(asset) {
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
      .join(' ')
      .toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .every((token) => hay.includes(token));
  }

  // Trashed content falls out of the FTS index entirely (a soft-deleted row
  // never matches), so the trash shelf keeps the old client-only match. For
  // the live shelves, server hits (queries/search.js, issue #352) are merged
  // with the local match: for "All" (no album selected) server hits reach
  // the WHOLE live library, not just this window; for a selected
  // album/Favorites, an off-window server hit is scoped to what's already
  // loaded here (its album membership isn't known otherwise) — the same
  // reach search had before.
  function visibleAssets() {
    const query = getSearchQuery();
    const selectedAlbum = getSelectedAlbum();
    if (!query) return getAlbumAssets();
    if (selectedAlbum === TRASH) return getTrash().filter(matchesSearchLocal);
    const scoped = getAlbumAssets();
    const scopedIds = selectedAlbum ? new Set(scoped.map((a) => a.asset_id)) : null;
    const merged = new Map();
    for (const a of scoped.filter(matchesSearchLocal)) merged.set(a.asset_id, a);
    for (const a of getSearchResults() ?? []) {
      if (scopedIds && !scopedIds.has(a.asset_id)) continue;
      merged.set(a.asset_id, a);
    }
    return [...merged.values()];
  }

  // An asset wherever it might currently live: the loaded window, trash, or
  // an off-window server search hit (queries/search.js can surface a photo
  // this session never loaded into `assets`) — the lightbox needs this reach
  // too, to open a tile that a search surfaced from outside the window.
  function findAsset(assetId) {
    return (
      getAssets().find((a) => a.asset_id === assetId) ??
      getTrash().find((a) => a.asset_id === assetId) ??
      (getSearchResults() ?? []).find((a) => a.asset_id === assetId)
    );
  }

  return { visibleAssets, findAsset };
}
