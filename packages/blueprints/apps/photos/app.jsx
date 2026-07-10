// Photos — a pure projection over the personal vault. Every tile rendered
// here is a media.media_asset joined to its core.content_item; the bytes
// themselves are rented, addressed by content_uri, never copied into the
// app. Every write is a typed media command — add_asset, update_asset
// (captions, capture times, favorites), delete_asset (a trash with a
// ~30-day purge), restore_asset and the album set — all risk low,
// consent-checked and receipted, with identical bytes deduping onto one
// asset. The app stores nothing: revoke the grant and this page goes dark
// while the library remains the owner's.
//
// This file is the entry/orchestrator only: module-level state, refresh(),
// the grid/selection-bar/lightbox render orchestrators, the React roots, and
// the raw DOM event wiring. The album-chips/album-tools and album-picker
// regions are self-contained enough (their own small slice of state, one
// root each) to carry their own render orchestrator too — see
// createToolbar()/createPicker() in toolbar.jsx/picker.jsx, constructed once
// at boot below. Every pure view lives in components/*.jsx; the pure helpers
// live in format.js/media.js/constants.js; the vault-write flows too large to
// keep inline live in outcomes.js/assets-actions.js/albums-actions.js/
// selection-actions.js/picker-actions.js/upload.js/faces.js.

import { FAVORITES, TRASH } from './constants.js';
import { $ } from './dom.js';
import { dayKey, fmtDay, fmtMonth } from './format.js';
import { debounce, readFailed } from './kit.js';
import { notice } from './outcomes.js';
import { createPicker } from './picker.jsx';
import { createToolbar } from './toolbar.jsx';
import { runUpload, wireUpload } from './upload.js';
// React owns six containers — one root per dynamic region of the static
// index.html body (chips, album tools, grid, selection bar, lightbox,
// picker). Each region's render orchestrator (renderGrid, renderLightbox, …)
// calls that root's `.render()` with the current external state on every
// change — the same "re-render the whole region from scratch" shape the Lit
// port used, just with React's reconciler doing the DOM diffing instead of
// lit-html's.
import { createRoot } from './react-core.min.js';
import { GridBody, TrashGridBody } from './components/Grid.jsx';
import { SelectionBarView } from './components/SelectionBar.jsx';
import { LightboxShell } from './components/Lightbox.jsx';

let assets = [];
let albums = [];
let trash = [];
let selectedAlbum = null; // null = All; an album_id; or FAVORITES / TRASH
let lightboxAssetId = null; // non-null while the lightbox is open
let uploading = false;
let readErrorShown = false;
let searchQuery = '';
let selectMode = false;
let batchBusy = false;
let selectAnchor = null; // last toggled asset_id, for shift-click ranges
const selectedIds = new Set();

// ---------- Data ----------

// The browse window: the library query reads only this many recent live
// assets (trash rides beside it, capped server-side). "Show more" grows it —
// photos has no search plane, so the window is the only way back in time.
let libraryWindow = 500;
let libraryTruncated = false;

async function refresh() {
  let data;
  try {
    data = await window.centraid.read({ query: 'library', input: { limit: libraryWindow } });
  } catch {
    // A broken vault must not look like an empty one.
    readFailed($('noticeBanner'));
    readErrorShown = true;
    return;
  }
  if (readErrorShown) {
    notice('');
    readErrorShown = false;
  }
  const denied = data?.vaultDenied;
  $('consentBanner').hidden = !denied;
  $('live').hidden = Boolean(denied);
  // The sidebar wrapper only opens once a read lands — until then (and
  // while consent is denied) the grid pane keeps the full width.
  $('sideNav').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  assets = data?.assets ?? [];
  albums = data?.albums ?? [];
  trash = data?.trash ?? [];
  libraryTruncated = Boolean(data?.truncated);
  // The trash shelf folds away when it empties; Favorites is always a place.
  if (selectedAlbum === TRASH && trash.length === 0) selectedAlbum = null;
  if (
    selectedAlbum &&
    selectedAlbum !== FAVORITES &&
    selectedAlbum !== TRASH &&
    !albums.some((a) => a.album_id === selectedAlbum)
  ) {
    selectedAlbum = null;
  }
  for (const id of [...selectedIds]) {
    if (!assets.some((a) => a.asset_id === id)) selectedIds.delete(id);
  }
  renderToolbar();
  renderGrid();
  renderSelectionBar();
  if (lightboxAssetId != null) renderLightbox();
}

function albumAssets() {
  if (!selectedAlbum) return assets;
  if (selectedAlbum === FAVORITES) return assets.filter((a) => a.favorite);
  if (selectedAlbum === TRASH) return trash;
  return assets.filter((a) => a.album_ids?.includes(selectedAlbum));
}

function matchesSearch(asset) {
  if (!searchQuery) return true;
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
  return searchQuery
    .toLowerCase()
    .split(/\s+/)
    .every((token) => hay.includes(token));
}

// What the grid shows right now: the album filter, then the search filter.
function visibleAssets() {
  return albumAssets().filter(matchesSearch);
}

// ---------- Grid ----------

function renderGrid() {
  const grid = $('grid');
  grid.classList.toggle('selecting', selectMode);
  const shown = visibleAssets();
  const empty = $('empty');
  empty.hidden = shown.length > 0;
  if (shown.length === 0) {
    const searching = searchQuery !== '';
    $('emptyText').textContent = searching
      ? `No matches for “${searchQuery}”.`
      : selectedAlbum === FAVORITES
        ? 'No favorites yet — tap the heart on any photo.'
        : selectedAlbum === TRASH
          ? 'Trash is empty.'
          : selectedAlbum
            ? 'Nothing in this album yet.'
            : 'No photos yet — your library starts with the first upload.';
    // `#emptyUpload` is a stable node wired once at boot (wireUpload, in
    // upload.js) — kit.js's own `emptyState()` helper replaces its
    // container's children on every call, which would silently drop that
    // listener. The kit-empty markup stays static in index.html instead;
    // this orchestrator only ever flips text/hidden on existing nodes.
    $('emptyUpload').hidden = searching || selectedAlbum === FAVORITES || selectedAlbum === TRASH;
  }
  // Trash forgoes the timeline: newest-trashed first, purge labels on tiles.
  if (selectedAlbum === TRASH) {
    gridRoot.render(<TrashGridBody assets={shown} refresh={refresh} />);
    return;
  }
  // Google-Photos-style timeline: sticky month headers, day labels inside
  // (bucketed inside GridBody itself, off the flat `shown` list).
  const inAlbum = albums.some((a) => a.album_id === selectedAlbum);
  // The window is honest about its edge: All, Favorites, albums and the
  // client-side search all filter the same loaded slice, so any of them can
  // silently miss photos older than the window. "Show more" grows it — with
  // no search plane, that is the only road back in time.
  gridRoot.render(
    <GridBody
      assets={shown}
      inAlbum={inAlbum}
      albumId={selectedAlbum}
      refresh={refresh}
      libraryTruncated={libraryTruncated}
      selectedAlbum={selectedAlbum}
      searchQuery={searchQuery}
      libraryWindow={libraryWindow}
      selectMode={selectMode}
      selectedIds={selectedIds}
      onEnterSelectMode={enterSelectMode}
      onToggleSelect={toggleSelect}
      onOpen={openLightbox}
      onShowMore={async (e) => {
        e.target.disabled = true;
        libraryWindow += 500;
        await refresh();
      }}
    />,
  );
}

// ---------- Multi-select ----------

function enterSelectMode() {
  selectMode = true;
  selectAnchor = null;
  $('selectBtn').textContent = 'Cancel';
  $('selectBtn').dataset.active = 'true';
  document.body.classList.add('has-selection');
  renderGrid();
  renderSelectionBar();
}

function exitSelectMode() {
  selectMode = false;
  selectedIds.clear();
  selectAnchor = null;
  $('selectBtn').textContent = 'Select';
  delete $('selectBtn').dataset.active;
  document.body.classList.remove('has-selection');
  closeAlbumMenu();
  renderGrid();
  renderSelectionBar();
}

function toggleSelect(assetId, shiftKey) {
  if (batchBusy) return;
  const list = visibleAssets();
  if (shiftKey && selectAnchor && selectAnchor !== assetId) {
    const a = list.findIndex((x) => x.asset_id === selectAnchor);
    const b = list.findIndex((x) => x.asset_id === assetId);
    if (a >= 0 && b >= 0) {
      const on = !selectedIds.has(assetId);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) {
        if (on) selectedIds.add(list[i].asset_id);
        else selectedIds.delete(list[i].asset_id);
      }
      selectAnchor = assetId;
      renderGrid();
      renderSelectionBar();
      return;
    }
  }
  if (selectedIds.has(assetId)) selectedIds.delete(assetId);
  else selectedIds.add(assetId);
  selectAnchor = assetId;
  renderGrid();
  renderSelectionBar();
}

// ---------- Selection bar ----------

// The "Add to album ▾" menu is a small, transient popover that only this app
// owns (it isn't a kit popover) — a plain open/closed flag, kept deliberately
// imperative like the old code: an away-click listener is added/removed in
// lockstep with it, which is more fragile to reason about as reactive state
// than as a plain boolean.
let albumMenuOpen = false;

function closeAlbumMenu() {
  if (!albumMenuOpen) return;
  albumMenuOpen = false;
  document.removeEventListener('click', onAlbumMenuAway, true);
}

function onAlbumMenuAway(e) {
  const wrap = $('selectionBar').querySelector('.bar-menu-wrap');
  if (wrap && !wrap.contains(e.target)) {
    closeAlbumMenu();
    renderSelectionBar();
  }
}

function toggleAlbumMenu() {
  if (albumMenuOpen) {
    closeAlbumMenu();
    renderSelectionBar();
    return;
  }
  albumMenuOpen = true;
  renderSelectionBar();
  document.addEventListener('click', onAlbumMenuAway, true);
}

function closeAlbumMenuAndRerender() {
  closeAlbumMenu();
  renderSelectionBar();
}

function setBarBusy(on) {
  batchBusy = on;
  for (const btn of $('selectionBar').querySelectorAll('button')) btn.disabled = on;
}

function renderSelectionBar() {
  const bar = $('selectionBar');
  bar.hidden = !selectMode;
  if (!selectMode) {
    selectionBarRoot.render(null);
    return;
  }
  selectionBarRoot.render(
    <SelectionBarView
      selectedIds={selectedIds}
      albums={albums}
      menuOpen={albumMenuOpen}
      busy={batchBusy}
      refresh={refresh}
      setBarBusy={setBarBusy}
      onToggleMenu={toggleAlbumMenu}
      onCloseMenu={closeAlbumMenuAndRerender}
      onExit={exitSelectMode}
    />,
  );
}

// ---------- Lightbox ----------

function openLightbox(assetId) {
  lightboxAssetId = assetId;
  renderLightbox();
}

function closeLightbox() {
  lightboxAssetId = null;
  const box = $('lightbox');
  box.hidden = true;
  lightboxRoot.render(null);
}

function step(delta) {
  const list = visibleAssets();
  const idx = list.findIndex((a) => a.asset_id === lightboxAssetId);
  const next = idx < 0 ? undefined : list[idx + delta];
  if (!next) return;
  lightboxAssetId = next.asset_id;
  renderLightbox();
}

let lightboxRenderSeq = 0;

function renderLightbox() {
  const box = $('lightbox');
  const asset = assets.find((a) => a.asset_id === lightboxAssetId);
  if (!asset) {
    closeLightbox();
    return;
  }
  lightboxRenderSeq += 1;
  const list = visibleAssets();
  const idx = list.findIndex((a) => a.asset_id === asset.asset_id);
  lightboxRoot.render(
    <LightboxShell
      asset={asset}
      idx={idx}
      list={list}
      albums={albums}
      renderSeq={lightboxRenderSeq}
      onStep={step}
      refresh={refresh}
      onClose={closeLightbox}
    />,
  );
  box.hidden = false;
}

$('lightbox').addEventListener('click', closeLightbox);

// ---------- Keyboard ----------

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('picker').hidden) {
    closePicker();
    return;
  }
  if ($('lightbox').hidden) {
    if (e.key === 'Escape' && selectMode && !batchBusy) exitSelectMode();
    return;
  }
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') step(-1);
  else if (e.key === 'ArrowRight') step(1);
});

// ---------- Search ----------

const applySearch = debounce(() => renderGrid(), 120);

$('searchInput').addEventListener('input', () => {
  searchQuery = $('searchInput').value.trim();
  $('searchClear').hidden = searchQuery === '';
  applySearch();
});

function clearSearch() {
  $('searchInput').value = '';
  $('searchClear').hidden = true;
  if (searchQuery !== '') {
    searchQuery = '';
    renderGrid();
  }
}

$('searchInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  if ($('searchInput').value) clearSearch();
  else $('searchInput').blur();
});

$('searchClear').addEventListener('click', () => {
  clearSearch();
  $('searchInput').focus();
});

// ---------- Upload ----------

async function uploadFiles(files) {
  if (uploading || files.length === 0) return;
  await runUpload(files, {
    refresh,
    setUploading: (v) => {
      uploading = v;
    },
  });
}

// ---------- Boot ----------

// One React root per dynamic container, created once at module scope (Form
// 1: external mutable state above + a render orchestrator per region, same
// shape the Lit port used with `litRender`). Unlike Lit's standalone
// `render()`, `createRoot(...).render()` fully owns its container from the
// first call, so no manual "clear the pre-existing skeleton" step is needed
// the way the Lit port's `mountGrid` guard was.
const chipsRoot = createRoot($('albumChips'));
const albumToolsRoot = createRoot($('albumTools'));
const gridRoot = createRoot($('grid'));
const selectionBarRoot = createRoot($('selectionBar'));
const lightboxRoot = createRoot($('lightbox'));
const pickerRoot = createRoot($('picker'));

// The album picker is constructed before the toolbar, since the toolbar's
// "Add photos" button needs a live `openPicker` to hand `<AlbumToolsView>`.
const { openPicker, closePicker } = createPicker({
  pickerRoot,
  getAlbums: () => albums,
  getAssets: () => assets,
  getSelectedAlbum: () => selectedAlbum,
  refresh,
});

const { renderToolbar } = createToolbar({
  chipsRoot,
  albumToolsRoot,
  getAlbums: () => albums,
  getTrash: () => trash,
  getAlbumAssets: albumAssets,
  getSelectedAlbum: () => selectedAlbum,
  setSelectedAlbum: (id) => {
    selectedAlbum = id;
  },
  refresh,
  renderGrid,
  exitSelectModeIfActive: () => {
    if (selectMode) exitSelectMode();
  },
  openPicker,
});

wireUpload({
  uploadFiles,
  isAlbumSelected: () => albums.some((a) => a.album_id === selectedAlbum),
  openPicker,
});

$('selectBtn').addEventListener('click', () => {
  if (selectMode) exitSelectMode();
  else enterSelectMode();
});

window.addEventListener('focus', refresh);
// Shimmer rows while the first read is in flight — the genuine
// `<kit-skeleton>` custom element, rendered as ordinary JSX (not the
// `showSkeleton()` DOM-mutating helper, which must never target a
// React-owned node); `renderGrid` replaces it with real content once
// `refresh()` resolves.
gridRoot.render(<kit-skeleton rows={6}></kit-skeleton>);
refresh();
