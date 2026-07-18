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
// upload). The album nav/tools region now lives in sidebar.tsx (replacing
// toolbar.jsx); the lightbox, slideshow and duplicates-shelf regions stay
// self-contained with their own render orchestrator — see createSidebar()/
// createPicker()/createLightbox()/createSlideshow()/createDuplicates() in
// sidebar.tsx/picker.tsx/lightbox.tsx/slideshow.tsx/duplicates.tsx,
// constructed once at boot below. `visibility.ts` holds the pure
// "what's visible right now" computation (album × search filter) both the
// timeline and lightbox need; `layout.ts` holds the justified-row math.
// Every pure view lives in components/*.tsx; the pure helpers live in
// format.ts/media.ts/constants.ts/activity.ts; the vault-write flows too
// large to keep inline live in outcomes.ts/assets-actions.ts/
// albums-actions.ts/selection-actions.ts/picker-actions.ts/upload.ts/
// faces.ts/duplicates-actions.ts.
//
// TS + CSS-modules split: this file's own strings are the static-shell/kit
// globals that stay in app.css; every JSX-only `ph-*` view class moved into a
// co-located components/*.module.css (the tile's imperatively-injected media
// guts + faces host stay global — see those modules' headers).

import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from './constants.ts';
import { $ } from './dom.ts';
import { createDuplicates } from './duplicates.tsx';
import { debounce, readFailed, subscribeReadUpdates } from './kit.js';
import { DEFAULT_ZOOM, gridWidthFallback, ZOOM_LEVELS } from './layout.ts';
import { createLightbox } from './lightbox.tsx';
import { notice } from './outcomes.ts';
import { createPicker } from './picker.tsx';
import { createSearch } from './search.ts';
import { createSidebar } from './sidebar.tsx';
import { createSlideshow } from './slideshow.tsx';
import { runUpload, wireUpload } from './upload.ts';
import { createVisibility } from './visibility.ts';
// React owns several containers — one root per dynamic region of the static
// index.html body. Each region's render orchestrator calls that root's
// `.render()` with the current external state on every change.
import { createRoot } from './react-core.min.js';
import type { FC } from './react-core.min.js';
import { AlbumGridView } from './components/AlbumGrid.tsx';
import { EnrichmentPanel } from './components/Enrichment.tsx';
import { MemoriesStrip } from './components/Memories.tsx';
import { SelectionBarView } from './components/SelectionBar.tsx';
import { TimelineBody } from './components/Timeline.tsx';
import { ToolbarView } from './components/Toolbar.tsx';
import type { Album, Asset, LibraryData, MemoryCard, Place } from './types.ts';

// The genuine <kit-skeleton> custom element, rendered as ordinary JSX — the
// runtime value stays the string 'kit-skeleton', so the emitted DOM is
// identical (pilot custom-element pattern).
const KitSkeleton = 'kit-skeleton' as unknown as FC<{ rows?: number }>;

let assets: Asset[] = [];
let albums: Album[] = [];
let places: Place[] = []; // issue #352: the full known core.place list, for the lightbox picker
let trash: Asset[] = [];
// null = All; an album_id; FAVORITES / TRASH / DUPLICATES / ALBUMS; or
// `tag:<label>` (issue #352's tag filter — see albumAssets() below).
let selectedAlbum: string | null = null;
let uploading = false;
let readErrorShown = false;
let searchQuery = '';
let searchResults: Asset[] | null = null; // server FTS hits (title/caption, issue #352); null = no active search
let selectMode = false;
let batchBusy = false;
let selectAnchor: string | null = null; // last toggled asset_id, for shift-click ranges
const selectedIds = new Set<string>();
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
let libraryLiveUnsubscribe: () => void = () => {};
let libraryLiveOwnsData = false;
let libraryRefreshSeq = 0;

// The vault tables the library projection actually reads (queries/library.ts +
// queries/_shared.ts). A `centraid:datachange` touching none of these can't
// change what this app shows, so onChange skips the refetch (issue #404).
const PHOTOS_READ_TABLES = new Set<string>([
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

function applyLibraryData(
  data: LibraryData | undefined,
  { record = true }: { record?: boolean } = {},
) {
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
  // The read resolved but the vault could not answer — same "a broken vault
  // must not look like an empty one" rule as the rejected-read path below.
  if (data?.error) {
    readFailed($('noticeBanner'));
    readErrorShown = true;
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

async function refresh(opts?: { record?: boolean }) {
  const seq = ++libraryRefreshSeq;
  const record = opts?.record !== false;
  let data: LibraryData;
  try {
    const read = window.centraid.read<LibraryData>({
      query: 'library',
      input: { limit: libraryWindow },
    });
    libraryLiveUnsubscribe();
    const subscription = subscribeReadUpdates<LibraryData>(read, (value) => {
      if (seq === libraryRefreshSeq) applyLibraryData(value, { record: true });
    });
    libraryLiveOwnsData = subscription.managed;
    libraryLiveUnsubscribe = subscription.unsubscribe;
    data = await read;
  } catch {
    if (seq !== libraryRefreshSeq) return;
    // A rejected initial live read has no dependency registered upstream.
    // Release it and restore the legacy change/focus retry path.
    libraryLiveUnsubscribe();
    libraryLiveUnsubscribe = () => {};
    libraryLiveOwnsData = false;
    // A broken vault must not look like an empty one.
    readFailed($('noticeBanner'));
    readErrorShown = true;
    return;
  }
  if (seq !== libraryRefreshSeq) return;
  applyLibraryData(data, { record });
}

function albumAssets(): Asset[] {
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
  return assets.filter((a) => a.album_ids?.includes(selectedAlbum!));
}

// visibility.ts owns the pure "what's visible right now" computation
// (album filter × search filter, plus the off-window asset lookup the
// lightbox needs) — app.tsx stays the one holder of the actual
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
function buildMemories(): MemoryCard[] {
  if (document.documentElement.getAttribute('data-show-memories') === 'hide') return [];
  const cards: MemoryCard[] = [];
  const favs = assets.filter((a) => a.favorite);
  if (favs.length > 0) {
    const first = favs[0]!;
    cards.push({
      key: 'built-in:favorites',
      title: 'Favorites',
      sub: `${favs.length} photo${favs.length === 1 ? '' : 's'}`,
      coverUri: first.thumb_uri ?? first.content_uri ?? null,
      newestAt: first.taken_at ?? '',
      onOpen: () => navigateTo(FAVORITES),
    });
  }
  const albumCards = albums
    .map((album): MemoryCard | null => {
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
    .filter((c): c is MemoryCard => c !== null)
    .sort((a, b) => String(b.newestAt).localeCompare(String(a.newestAt)));
  return [...cards, ...albumCards].slice(0, 6);
}

// ---------- Navigation ----------

function navigateTo(id: string | null) {
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

function toolbarTitleSub(): { title: string; sub: string } {
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
        targetHeight={ZOOM_LEVELS[zoomIndex]!}
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
          e.currentTarget.disabled = true;
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

function toggleSelect(assetId: string, shiftKey?: boolean) {
  if (batchBusy) return;
  const list = visibleAssets();
  if (shiftKey && selectAnchor && selectAnchor !== assetId) {
    const a = list.findIndex((x) => x.asset_id === selectAnchor);
    const b = list.findIndex((x) => x.asset_id === assetId);
    if (a >= 0 && b >= 0) {
      const on = !selectedIds.has(assetId);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) {
        const id = list[i]!.asset_id;
        if (on) selectedIds.add(id);
        else selectedIds.delete(id);
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

function onAlbumMenuAway(e: globalThis.MouseEvent) {
  const wrap = $('selectionBar').querySelector('.bar-menu-wrap');
  if (wrap && !wrap.contains(e.target as Node)) {
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

function setBarBusy(on: boolean) {
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
  const target = e.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    if (e.key === 'Escape') target!.blur();
    return;
  }
  if (e.key === 'Escape') lightbox.closeLightbox();
  else if (e.key === 'ArrowLeft') lightbox.step(-1);
  else if (e.key === 'ArrowRight') lightbox.step(1);
});

// ---------- Search ----------
// Server FTS (queries/search.ts, issue #352) is debounced via search.ts's
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
// FTS round trip (runSearch) is already debounced in search.ts.
const debouncedLocalRender = debounce(() => {
  renderToolbarBar();
  renderMain();
}, 180);

$<HTMLInputElement>('searchInput').addEventListener('input', () => {
  searchQuery = $<HTMLInputElement>('searchInput').value.trim();
  $('searchClear').hidden = searchQuery === '';
  debouncedLocalRender();
  runSearch();
});

function clearSearch() {
  $<HTMLInputElement>('searchInput').value = '';
  $('searchClear').hidden = true;
  invalidateSearch();
  if (searchQuery !== '' || searchResults !== null) {
    searchQuery = '';
    searchResults = null;
    renderToolbarBar();
    renderMain();
  }
}

$<HTMLInputElement>('searchInput').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  if ($<HTMLInputElement>('searchInput').value) clearSearch();
  else $('searchInput').blur();
});

$('searchClear').addEventListener('click', () => {
  clearSearch();
  $('searchInput').focus();
});

// ---------- Zoom / hamburger ----------

function renderZoomButtons() {
  $<HTMLButtonElement>('zoomOutBtn').disabled = zoomIndex === 0;
  $<HTMLButtonElement>('zoomInBtn').disabled = zoomIndex === ZOOM_LEVELS.length - 1;
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

async function uploadFiles(files: File[]) {
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
// open state via hooks — components/Enrichment.tsx) and never touches this
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
  // A live read reruns itself for replica/server invalidations. The legacy
  // doorbell remains only for older hosts that return a plain Promise.
  if (libraryLiveOwnsData) return;
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
mainRoot.render(<KitSkeleton rows={6} />);
// The initial load doesn't arm the focus gate — the first refocus after boot
// still verifies (the user may have been away since the page mounted), then
// the gate suppresses rapid subsequent app switches.
refresh({ record: false });
