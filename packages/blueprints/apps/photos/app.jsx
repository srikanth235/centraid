// governance: allow-repo-hygiene file-size-limit the app-root orchestrator owns module-level state + the render wiring for every region (v2's justified timeline/sidebar/memories/lightbox redesign grew this alongside the pre-existing #352 tag filter + face-proposer mount); splitting further would scatter one cohesive boot sequence across files for no reader benefit.
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
// v2 rebuilds the chrome (sidebar, justified timeline, memories, redesigned
// lightbox) around that SAME contract — same `library`/`search`/
// `duplicates`/`enrichment-status`/`faces` queries, same action set. This
// file is the entry/orchestrator only: module-level state, refresh(), the
// sidebar/toolbar/main/selection-bar render orchestrators, the React roots,
// and the raw DOM event wiring (header icon buttons, keyboard, search,
// upload). The album nav/tools region now lives in sidebar.jsx (replacing
// toolbar.jsx); the lightbox, slideshow and duplicates-shelf regions stay
// self-contained with their own render orchestrator — see createSidebar()/
// createPicker()/createLightbox()/createSlideshow()/createDuplicates() in
// sidebar.jsx/picker.jsx/lightbox.jsx/slideshow.jsx/duplicates.jsx,
// constructed once at boot below. `visibility.js` holds the pure
// "what's visible right now" computation (album × search filter) both the
// timeline and lightbox need; `layout.js` holds the justified-row math.
// Every pure view lives in components/*.jsx; the pure helpers live in
// format.js/media.js/constants.js/activity.js; the vault-write flows too
// large to keep inline live in outcomes.js/assets-actions.js/
// albums-actions.js/selection-actions.js/picker-actions.js/upload.js/
// faces.js/duplicates-actions.js.

import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from './constants.js';
import { $ } from './dom.js';
import { createDuplicates } from './duplicates.jsx';
import { debounce, readFailed } from './kit.js';
import { DEFAULT_ZOOM, gridWidthFallback, ZOOM_LEVELS } from './layout.js';
import { createLightbox } from './lightbox.jsx';
import { notice } from './outcomes.js';
import { createPicker } from './picker.jsx';
import { createSearch } from './search.js';
import { createSidebar } from './sidebar.jsx';
import { createSlideshow } from './slideshow.jsx';
import { runUpload, wireUpload } from './upload.js';
import { createVisibility } from './visibility.js';
// React owns several containers — one root per dynamic region of the static
// index.html body. Each region's render orchestrator calls that root's
// `.render()` with the current external state on every change.
import { createRoot } from './react-core.min.js';
import { AlbumGridView } from './components/AlbumGrid.jsx';
import { EnrichmentPanel } from './components/Enrichment.jsx';
import { MemoriesStrip } from './components/Memories.jsx';
import { SelectionBarView } from './components/SelectionBar.jsx';
import { TimelineBody } from './components/Timeline.jsx';
import { ToolbarView } from './components/Toolbar.jsx';

let assets = [];
let albums = [];
let places = []; // issue #352: the full known core.place list, for the lightbox picker
let trash = [];
// null = All; an album_id; FAVORITES / TRASH / DUPLICATES / ALBUMS; or
// `tag:<label>` (issue #352's tag filter — see albumAssets() below).
let selectedAlbum = null;
let uploading = false;
let readErrorShown = false;
let searchQuery = '';
let searchResults = null; // server FTS hits (title/caption, issue #352); null = no active search
let selectMode = false;
let batchBusy = false;
let selectAnchor = null; // last toggled asset_id, for shift-click ranges
const selectedIds = new Set();
let zoomIndex = DEFAULT_ZOOM;
// The scroll pane's real content width, kept fresh by a ResizeObserver (Boot,
// below) — the justified timeline's `justify()` needs real pixels, not a
// CSS-breakpoint guess.
let paneWidth = gridWidthFallback(typeof window !== 'undefined' ? window.innerWidth : 1280);

// ---------- Data ----------

// The browse window: the library query reads only this many recent live
// assets (trash rides beside it, capped server-side). "Show more" grows it —
// photos has no search plane, so the window is the only way back in time.
let libraryWindow = 500;
let libraryTruncated = false;

// Focus-refresh staleness gate (issue #404): switching back to Photos must not
// refetch the whole library on every app switch. A write elsewhere already
// arrives via onChange (Boot, below); focus only needs to cover a change
// missed while the SSE was disconnected, so a granted load within this window
// is skipped. `lastFreshLoadAt` records only focus/change/action loads, never
// the initial boot load — so the boot's granted → denied → granted consent
// walk (driven purely by focus in the boot harness) always re-reads.
const FOCUS_STALE_MS = 30_000;
let lastFreshLoadAt = 0;

// The vault tables the library projection actually reads (queries/library.js +
// queries/_shared.js). A `centraid:datachange` touching none of these can't
// change what this app shows, so onChange skips the refetch (issue #404).
const PHOTOS_READ_TABLES = new Set([
  'media.media_asset',
  'core.content_item',
  'core.collection',
  'core.collection_entry',
  'core.place',
  'core.concept_scheme',
  'core.concept',
  'core.tag',
  'blob.custody_state',
]);

async function refresh(opts) {
  const record = opts?.record !== false;
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
  $('sidebarMount').hidden = Boolean(denied);
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    return;
  }
  assets = data?.assets ?? [];
  albums = data?.albums ?? [];
  places = data?.places ?? [];
  trash = data?.trash ?? [];
  libraryTruncated = Boolean(data?.truncated);
  // The trash shelf folds away when it empties; Favorites is always a place.
  if (selectedAlbum === TRASH && trash.length === 0) selectedAlbum = null;
  if (
    selectedAlbum &&
    selectedAlbum !== FAVORITES &&
    selectedAlbum !== TRASH &&
    selectedAlbum !== DUPLICATES &&
    selectedAlbum !== ALBUMS &&
    !(typeof selectedAlbum === 'string' && selectedAlbum.startsWith('tag:')) &&
    !albums.some((a) => a.album_id === selectedAlbum)
  ) {
    selectedAlbum = null;
  }
  for (const id of [...selectedIds]) {
    if (!assets.some((a) => a.asset_id === id)) selectedIds.delete(id);
  }
  if (record) lastFreshLoadAt = Date.now();
  sidebar.renderSidebar();
  renderToolbarBar();
  renderMain();
  renderSelectionBar();
  lightbox.renderIfOpen();
}

function albumAssets() {
  if (!selectedAlbum) return assets;
  if (selectedAlbum === FAVORITES) return assets.filter((a) => a.favorite);
  if (selectedAlbum === TRASH) return trash;
  // Tag filter (issue #352): a `tag:<label>` shelf, the same prefixed-value
  // trick TRASH/FAVORITES/DUPLICATES/ALBUMS use to ride the one
  // selectedAlbum slot without a second piece of state.
  if (typeof selectedAlbum === 'string' && selectedAlbum.startsWith('tag:')) {
    const label = selectedAlbum.slice(4);
    return assets.filter((a) => a.tags?.some((t) => t.label === label));
  }
  return assets.filter((a) => a.album_ids?.includes(selectedAlbum));
}

// visibility.js owns the pure "what's visible right now" computation
// (album filter × search filter, plus the off-window asset lookup the
// lightbox needs) — app.jsx stays the one holder of the actual
// assets/trash/searchResults arrays and hands them over as getters.
const { visibleAssets, findAsset } = createVisibility({
  getAssets: () => assets,
  getTrash: () => trash,
  getAlbumAssets: albumAssets,
  getSearchResults: () => searchResults,
  getSearchQuery: () => searchQuery,
  getSelectedAlbum: () => selectedAlbum,
});

// ---------- Memories (v2) ----------
// Real data has no built-in "memories" concept — this is derived, honestly,
// from what's already loaded: Favorites (if non-empty) + up to 6 albums with
// at least one photo, newest-active-first (by their newest member's
// captured_at). No fabricated "smart" ML memories, no "this month last
// year" bucket (not cheaply derivable from the loaded window alone without
// a second query this app doesn't have).
function buildMemories() {
  if (document.documentElement.getAttribute('data-show-memories') === 'hide') return [];
  const cards = [];
  const favs = assets.filter((a) => a.favorite);
  if (favs.length > 0) {
    cards.push({
      key: 'built-in:favorites',
      title: 'Favorites',
      sub: `${favs.length} photo${favs.length === 1 ? '' : 's'}`,
      coverUri: favs[0].thumb_uri ?? favs[0].content_uri ?? null,
      newestAt: favs[0].taken_at ?? '',
      onOpen: () => navigateTo(FAVORITES),
    });
  }
  const albumCards = albums
    .map((album) => {
      const members = assets.filter((a) => (a.album_ids ?? []).includes(album.album_id));
      if (members.length === 0) return null;
      const newest = members.reduce((a, b) =>
        String(a.taken_at ?? '') > String(b.taken_at ?? '') ? a : b,
      );
      return {
        key: album.album_id,
        title: album.title ?? 'Album',
        sub: `${members.length} photo${members.length === 1 ? '' : 's'}`,
        coverUri: newest.thumb_uri ?? newest.content_uri ?? null,
        newestAt: newest.taken_at ?? '',
        onOpen: () => navigateTo(album.album_id),
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.newestAt).localeCompare(String(a.newestAt)));
  return [...cards, ...albumCards].slice(0, 6);
}

// ---------- Navigation ----------

function navigateTo(id) {
  if (selectedAlbum === DUPLICATES && id !== DUPLICATES) duplicates.invalidate();
  selectedAlbum = id;
  if (selectMode) {
    exitSelectMode(); // exitSelectMode already re-renders the toolbar/main/selection-bar
  } else {
    renderToolbarBar();
    renderMain();
  }
  sidebar.renderSidebar();
}

// ---------- Toolbar (title/subtitle/back/new-album/select) ----------

const toolbarRoot = createRoot($('toolbarMount'));

function toolbarTitleSub() {
  const n = visibleAssets().length;
  const q = searchQuery.trim();
  if (selectedAlbum === ALBUMS) {
    return {
      title: 'Albums',
      sub: `${albums.length} album${albums.length === 1 ? '' : 's'} · covers pulled from your library`,
    };
  }
  if (selectedAlbum === DUPLICATES) {
    return { title: 'Duplicates', sub: 'Near-duplicate clusters in your library' };
  }
  const countSub = q
    ? `${n} match${n === 1 ? '' : 'es'} “${q}”`
    : `${n} photo${n === 1 ? '' : 's'}`;
  if (selectedAlbum === TRASH) {
    return { title: 'Trash', sub: q ? countSub : `${n} in trash · auto-purge after 30 days` };
  }
  if (selectedAlbum === FAVORITES) return { title: 'Favorites', sub: countSub };
  if (typeof selectedAlbum === 'string' && selectedAlbum.startsWith('tag:')) {
    return { title: `#${selectedAlbum.slice(4)}`, sub: countSub };
  }
  const album = albums.find((a) => a.album_id === selectedAlbum);
  if (album) return { title: album.title ?? 'Album', sub: countSub };
  return { title: 'Photos', sub: countSub };
}

function renderToolbarBar() {
  const { title, sub } = toolbarTitleSub();
  const inAlbum = albums.some((a) => a.album_id === selectedAlbum);
  toolbarRoot.render(
    <ToolbarView
      title={title}
      subtitle={sub}
      showBack={inAlbum}
      onBack={() => navigateTo(ALBUMS)}
      showNewAlbum={selectedAlbum === ALBUMS}
      onNewAlbum={() => sidebar.openNewAlbum()}
      showAddPhotos={inAlbum}
      onAddPhotos={openPicker}
      showSelect={
        selectedAlbum !== TRASH && selectedAlbum !== DUPLICATES && selectedAlbum !== ALBUMS
      }
      selectMode={selectMode}
      onToggleSelect={() => (selectMode ? exitSelectMode() : enterSelectMode())}
    />,
  );
}

// ---------- Main content (timeline / memories / albums grid / duplicates / empty) ----------

const mainRoot = createRoot($('grid'));

function renderMain() {
  const empty = $('empty');
  if (selectedAlbum === DUPLICATES) {
    empty.hidden = true;
    duplicates.ensureLoaded();
    duplicates.renderDuplicates();
    return;
  }
  if (selectedAlbum === ALBUMS) {
    empty.hidden = true;
    const enriched = albums.map((album) => {
      const members = assets.filter((a) => (a.album_ids ?? []).includes(album.album_id));
      return {
        ...album,
        count: members.length,
        coverUri: members[0]?.thumb_uri ?? members[0]?.content_uri ?? null,
      };
    });
    mainRoot.render(
      <AlbumGridView
        albums={enriched}
        onOpen={navigateTo}
        onNewAlbum={() => sidebar.openNewAlbum()}
      />,
    );
    return;
  }

  const shown = visibleAssets();
  empty.hidden = shown.length > 0;
  if (shown.length === 0) {
    const searching = searchQuery !== '';
    $('emptyText').textContent = searching
      ? `No matches for “${searchQuery}”.`
      : selectedAlbum === FAVORITES
        ? 'No favorites yet — tap the heart on any photo.'
        : selectedAlbum === TRASH
          ? 'Trash is empty.'
          : typeof selectedAlbum === 'string' && selectedAlbum.startsWith('tag:')
            ? `No photos tagged “${selectedAlbum.slice(4)}”.`
            : selectedAlbum
              ? 'Nothing in this album yet.'
              : 'No photos yet — your library starts with the first upload.';
    $('emptyUpload').hidden =
      searching ||
      selectedAlbum === FAVORITES ||
      selectedAlbum === TRASH ||
      (typeof selectedAlbum === 'string' && selectedAlbum.startsWith('tag:'));
  }

  const inAlbum = albums.some((a) => a.album_id === selectedAlbum);
  const showMemories = selectedAlbum === null && searchQuery.trim() === '' && !selectMode;
  mainRoot.render(
    <>
      {showMemories ? <MemoriesStrip memories={buildMemories()} /> : null}
      <TimelineBody
        assets={shown}
        containerWidth={paneWidth}
        targetHeight={ZOOM_LEVELS[zoomIndex]}
        inAlbum={inAlbum}
        albumId={selectedAlbum}
        isTrash={selectedAlbum === TRASH}
        refresh={refresh}
        selectedAlbum={selectedAlbum}
        searchQuery={searchQuery}
        libraryWindow={libraryWindow}
        truncated={libraryTruncated}
        selectMode={selectMode}
        selectedIds={selectedIds}
        onEnterSelectMode={enterSelectMode}
        onToggleSelect={toggleSelect}
        onOpen={lightbox.openLightbox}
        onShowMore={async (e) => {
          e.target.disabled = true;
          libraryWindow += 500;
          await refresh();
        }}
      />
    </>,
  );
}

// ---------- Multi-select ----------

function enterSelectMode() {
  selectMode = true;
  selectAnchor = null;
  document.body.classList.add('has-selection');
  renderToolbarBar();
  renderMain();
  renderSelectionBar();
}

function exitSelectMode() {
  selectMode = false;
  selectedIds.clear();
  selectAnchor = null;
  document.body.classList.remove('has-selection');
  closeAlbumMenu();
  renderToolbarBar();
  renderMain();
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
      renderMain();
      renderSelectionBar();
      return;
    }
  }
  if (selectedIds.has(assetId)) selectedIds.delete(assetId);
  else selectedIds.add(assetId);
  selectAnchor = assetId;
  renderMain();
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

const selectionBarRoot = createRoot($('selectionBar'));

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

// ---------- Lightbox / slideshow / duplicates / picker ----------
// Each owns its own render orchestrator (see their header comments) — wired
// up in Boot below.

// ---------- Keyboard ----------

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('picker').hidden) {
    closePicker();
    return;
  }
  if ($('lightbox').hidden) {
    if (e.key === 'Escape' && selectMode && !batchBusy) exitSelectMode();
    else if (e.key === 'Escape' && sidebar.isSidebarOpen()) sidebar.closeSidebar();
    return;
  }
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key === 'Escape') lightbox.closeLightbox();
  else if (e.key === 'ArrowLeft') lightbox.step(-1);
  else if (e.key === 'ArrowRight') lightbox.step(1);
});

// ---------- Search ----------
// Server FTS (queries/search.js, issue #352) is debounced via search.js's
// createSearch; the immediate renderMain() call below keeps the existing
// client-side match (day/month/album-name/loaded-title) responsive at zero
// latency while that request is in flight.

const { run: runSearch, invalidate: invalidateSearch } = createSearch({
  getQuery: () => searchQuery,
  setResults: (r) => {
    searchResults = r;
  },
  renderGrid: renderMain,
});

// The local match (day/month/album-name/loaded-title) re-sorts, re-buckets and
// re-justifies the whole loaded window — up to 2,000 tiles. Debounced so a
// burst of keystrokes rebuilds the grid once, not once per key; the <input> is
// uncontrolled, so its text still echoes instantly (issue #404). The server
// FTS round trip (runSearch) is already debounced in search.js.
const debouncedLocalRender = debounce(() => {
  renderToolbarBar();
  renderMain();
}, 180);

$('searchInput').addEventListener('input', () => {
  searchQuery = $('searchInput').value.trim();
  $('searchClear').hidden = searchQuery === '';
  debouncedLocalRender();
  runSearch();
});

function clearSearch() {
  $('searchInput').value = '';
  $('searchClear').hidden = true;
  invalidateSearch();
  if (searchQuery !== '' || searchResults !== null) {
    searchQuery = '';
    searchResults = null;
    renderToolbarBar();
    renderMain();
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

// ---------- Zoom / hamburger ----------

function renderZoomButtons() {
  $('zoomOutBtn').disabled = zoomIndex === 0;
  $('zoomInBtn').disabled = zoomIndex === ZOOM_LEVELS.length - 1;
}

$('zoomOutBtn').addEventListener('click', () => {
  zoomIndex = Math.max(0, zoomIndex - 1);
  renderZoomButtons();
  renderMain();
});
$('zoomInBtn').addEventListener('click', () => {
  zoomIndex = Math.min(ZOOM_LEVELS.length - 1, zoomIndex + 1);
  renderZoomButtons();
  renderMain();
});
renderZoomButtons();

$('hamburgerBtn').addEventListener('click', () => sidebar.openSidebar());

// The grid's real width drives the justified timeline — read off #grid
// itself, not its #scrollPane parent, since scrollPane's clientWidth
// includes the pane's own left+right padding (app.css's `.ph-scroll`) that
// #grid's tiles never get to use. ResizeObserver isn't implemented under
// jsdom (the app-boot test's environment) — the `resize` listener fallback
// keeps boot safe there while still tracking the real thing in a real
// browser.
function measurePane() {
  const el = $('grid');
  const w = el?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
  if (w > 0 && Math.abs(w - paneWidth) > 1) {
    paneWidth = w;
    renderMain();
  }
}
if (typeof ResizeObserver !== 'undefined' && $('grid')) {
  new ResizeObserver(measurePane).observe($('grid'));
} else if (typeof window !== 'undefined') {
  window.addEventListener('resize', measurePane);
}

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

const sidebarRoot = createRoot($('sidebarMount'));
const lightboxRoot = createRoot($('lightbox'));
const pickerRoot = createRoot($('picker'));
const slideshowRoot = createRoot($('slideshow'));
// The face-proposer toggle (issue #352) is fully self-contained (own status/
// open state via hooks — components/Enrichment.jsx) and never touches this
// module's assets/albums state, so it renders once here and is never
// re-rendered by refresh().
createRoot($('enrichmentMount')).render(<EnrichmentPanel />);

// Duplicates (issue #352) renders into the SAME mainRoot the library/trash
// views use — selecting its shelf swaps `#grid`'s content exactly the way
// selecting Trash already does. Slideshow gets its own root/container since
// it can open from the lightbox too, independent of whatever the grid is
// currently showing.
const duplicates = createDuplicates({ gridRoot: mainRoot, refresh });
const slideshow = createSlideshow({ slideshowRoot });
const lightbox = createLightbox({
  lightboxRoot,
  findAsset,
  visibleAssets,
  getAlbums: () => albums,
  getPlaces: () => places,
  refresh,
  slideshow,
});

// The album picker is constructed before the sidebar, since the sidebar's
// per-album rows and the toolbar's "Add photos" button both need a live
// `openPicker`.
const { openPicker, closePicker } = createPicker({
  pickerRoot,
  getAlbums: () => albums,
  getAssets: () => assets,
  getSelectedAlbum: () => selectedAlbum,
  refresh,
});

const sidebar = createSidebar({
  sidebarRoot,
  getAlbums: () => albums,
  getAssets: () => assets,
  getTrash: () => trash,
  getSelectedAlbum: () => selectedAlbum,
  setSelectedAlbum: (id) => {
    // Leaving the shelf: the next visit re-fetches rather than showing a
    // list that a trash/upload done elsewhere has since gone stale.
    if (selectedAlbum === DUPLICATES && id !== DUPLICATES) duplicates.invalidate();
    selectedAlbum = id;
  },
  refresh,
  renderMain: () => {
    renderToolbarBar();
    renderMain();
  },
  exitSelectModeIfActive: () => {
    if (selectMode) exitSelectMode();
  },
});

wireUpload({
  uploadFiles,
  isAlbumSelected: () => albums.some((a) => a.album_id === selectedAlbum),
  openPicker,
});

// Desktop-only toolbar entry point (CSS-gated at >=720px — see app.css); the
// lightbox's own Slideshow icon covers every width.
$('slideshowBtn').addEventListener('click', () => lightbox.startSlideshow(null));

// Refocusing Photos re-reads only if the last library load is stale (issue
// #404) — a fresh load within FOCUS_STALE_MS is skipped, so hopping between
// apps doesn't reship the whole library each time. Real changes elsewhere
// arrive via onChange below, independent of focus.
window.addEventListener('focus', () => {
  if (lastFreshLoadAt && Date.now() - lastFreshLoadAt < FOCUS_STALE_MS) return;
  refresh();
});

// Reactive data (SKILL.md "Reactive data"): a write elsewhere (chat agent, a
// second window) fires this. Debounced so a burst of writes coalesces into one
// refetch, and skipped entirely when the change touches no table this app
// reads — a note/task/expense write must not reship the photo library.
const onDataChange = debounce(() => refresh(), 200);
window.centraid.onChange?.((detail) => {
  const tables = detail?.tables;
  // Unknown/empty table set: refetch to stay honest. Otherwise only when the
  // change intersects the library projection's tables.
  if (!Array.isArray(tables) || tables.length === 0) {
    onDataChange();
    return;
  }
  if (tables.some((t) => PHOTOS_READ_TABLES.has(t))) onDataChange();
});

// Shimmer rows while the first read is in flight — the genuine
// `<kit-skeleton>` custom element, rendered as ordinary JSX (not the
// `showSkeleton()` DOM-mutating helper, which must never target a
// React-owned node); `renderMain` replaces it with real content once
// `refresh()` resolves.
mainRoot.render(<kit-skeleton rows={6}></kit-skeleton>);
// The initial load doesn't arm the focus gate — the first refocus after boot
// still verifies (the user may have been away since the page mounted), then
// the gate suppresses rapid subsequent app switches.
refresh({ record: false });
