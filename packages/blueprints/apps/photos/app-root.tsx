// governance: allow-repo-hygiene file-size-limit — this file holds the app's whole orchestration as one React tree by design (#505); it is smaller than the served app.tsx + app-inline.tsx it replaces. Splitting it belongs to the app's own code evolution, not this migration.
// Photos — query-free React tree (issue #505). Holds the `Root` component and
// every constant, helper and type it needs that does NOT depend on the
// node-side `./queries/*` handler modules. Both the served shim (app.tsx, for
// mobile WebViews) and the shell's inline route mount this `Root`; keeping it
// free of `./queries/*` imports is what lets the gateway's whole-graph bundler
// serve app.tsx to the browser without dragging node-only handler code into the
// client graph. The InlineAppModule descriptor (app-inline.tsx) imports `Root`
// and `PHOTOS_READ_TABLES_LIST` from here and adds the query wiring.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type FC,
  type ReactElement,
  type ReactNode,
} from './react-core.min.js';
import { debounce, observeWidth, readFailed, subscribeReadUpdates } from './kit.js';
import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from './constants.ts';
import { $ } from './dom.ts';
import { createDuplicates } from './duplicates.tsx';
import { DEFAULT_ZOOM, gridWidthFallback, ZOOM_LEVELS } from './layout.ts';
import { createLightbox } from './lightbox.tsx';
import { notice } from './outcomes.ts';
import { createPicker } from './picker.tsx';
import { createSearch } from './search.ts';
import { createSidebar } from './sidebar.tsx';
import { createSlideshow } from './slideshow.tsx';
import { runUpload, wireUpload } from './upload.ts';
import { createVisibility } from './visibility.ts';
import { AlbumGridView } from './components/AlbumGrid.tsx';
import { EnrichmentPanel } from './components/Enrichment.tsx';
import { MemoriesStrip } from './components/Memories.tsx';
import { SelectionBarView } from './components/SelectionBar.tsx';
import { TimelineBody } from './components/Timeline.tsx';
import { ToolbarView } from './components/Toolbar.tsx';
import { Chrome, type ChromeSlots } from './Chrome.tsx';
import type { Album, Asset, LibraryData, MemoryCard, Place } from './types.ts';
import type { InlineAppProps } from '../inline-types.ts';
import styles from './Chrome.module.css';

// The vault tables the library projection reads — the change-subscription filter
// AND the onChange refetch gate (issue #404): a change touching none of these
// can't alter what this app shows.
export const PHOTOS_READ_TABLES_LIST = [
  'media.media_asset',
  'core.content_item',
  'core.collection',
  'core.collection_entry',
  'core.place',
  'core.concept_scheme',
  'core.concept',
  'core.tag',
  'blob.custody_state',
];
const PHOTOS_READ_TABLES = new Set<string>(PHOTOS_READ_TABLES_LIST);
const FOCUS_STALE_MS = 30_000;

// The genuine <kit-skeleton> custom element as ordinary JSX (pilot pattern —
// the runtime value stays the string, so the emitted DOM is identical).
const KitSkeleton = 'kit-skeleton' as unknown as FC<{ rows?: number }>;

type SlotKey = keyof ChromeSlots;

export function Root({ rootRef }: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [narrow, setNarrow] = useState(false);
  const [ready, setReady] = useState(false);
  const rootElRef = useRef<HTMLDivElement | null>(null);
  const slots = useRef<ChromeSlots>({
    sidebar: null,
    toolbar: null,
    main: null,
    selectionBar: null,
    lightbox: null,
    slideshow: null,
    picker: null,
    enrichment: null,
  });

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
    },
    [rootRef],
  );

  // Seed the narrow layout BEFORE the first paint (the served app relies on a
  // viewport @media; inline the app pane can be narrower than the viewport, so
  // measure the real element). Without this the sidebar renders as a full-width
  // column for one frame and then slides away — the drawer-flash docs/locker hit
  // (#505). The `.side` transition stays gated on `ready` (set one frame later)
  // so this mount-time snap is instant and only user-driven open/close animate.
  useLayoutEffect(() => {
    const el = rootElRef.current;
    if (el) {
      const forced = el.getAttribute('data-app-width') === 'narrow';
      setNarrow(forced || el.clientWidth < 860);
    }
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  // The entire orchestration — a faithful port of app.tsx's module body, with
  // every `createRoot($('…'))` replaced by a slot root and its module-level
  // `let` state hoisted into this closure. Runs once, after Chrome has mounted
  // the static skeleton (so the `$('…')` nodes the factories read exist).
  useEffect(() => {
    // ---- slot roots ----
    const setSlot = (key: SlotKey, node: ReactNode): void => {
      slots.current[key] = node;
      bump();
    };
    const mk = (key: SlotKey) => ({ render: (node: ReactNode) => setSlot(key, node) });
    const toolbarRoot = mk('toolbar');
    const mainRoot = mk('main');
    const selectionBarRoot = mk('selectionBar');
    const sidebarRoot = mk('sidebar');
    const lightboxRoot = mk('lightbox');
    const pickerRoot = mk('picker');
    const slideshowRoot = mk('slideshow');

    // ---- module state (was app.tsx top-level `let`) ----
    let assets: Asset[] = [];
    let albums: Album[] = [];
    let places: Place[] = [];
    let trash: Asset[] = [];
    let selectedAlbum: string | null = null;
    let uploading = false;
    let readErrorShown = false;
    let searchQuery = '';
    let searchResults: Asset[] | null = null;
    let selectMode = false;
    let batchBusy = false;
    let selectAnchor: string | null = null;
    const selectedIds = new Set<string>();
    let zoomIndex = DEFAULT_ZOOM;
    let paneWidth = gridWidthFallback(typeof window !== 'undefined' ? window.innerWidth : 1280);
    let libraryWindow = 500;
    let libraryTruncated = false;
    let lastFreshLoadAt = 0;
    let libraryLiveUnsubscribe: () => void = () => {};
    let libraryLiveOwnsData = false;
    let libraryRefreshSeq = 0;
    let albumMenuOpen = false;

    // ---- data ----
    function applyLibraryData(
      data: LibraryData | undefined,
      { record = true }: { record?: boolean } = {},
    ): void {
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

    async function refresh(opts?: { record?: boolean }): Promise<void> {
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
        libraryLiveUnsubscribe();
        libraryLiveUnsubscribe = () => {};
        libraryLiveOwnsData = false;
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
      if (typeof selectedAlbum === 'string' && selectedAlbum.startsWith('tag:')) {
        const label = selectedAlbum.slice(4);
        return assets.filter((a) => a.tags?.some((t) => t.label === label));
      }
      return assets.filter((a) => a.album_ids?.includes(selectedAlbum!));
    }

    const { visibleAssets, findAsset } = createVisibility({
      getAssets: () => assets,
      getTrash: () => trash,
      getAlbumAssets: albumAssets,
      getSearchResults: () => searchResults,
      getSearchQuery: () => searchQuery,
      getSelectedAlbum: () => selectedAlbum,
    });

    // ---- memories ----
    function buildMemories(): MemoryCard[] {
      if (rootElRef.current?.getAttribute('data-show-memories') === 'hide') return [];
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

    // ---- navigation ----
    function navigateTo(id: string | null): void {
      if (selectedAlbum === DUPLICATES && id !== DUPLICATES) duplicates.invalidate();
      selectedAlbum = id;
      if (selectMode) {
        exitSelectMode();
      } else {
        renderToolbarBar();
        renderMain();
      }
      sidebar.renderSidebar();
    }

    // ---- toolbar ----
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

    function renderToolbarBar(): void {
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

    // ---- main content ----
    function renderMain(): void {
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

    // ---- multi-select ----
    function enterSelectMode(): void {
      selectMode = true;
      selectAnchor = null;
      document.body.classList.add('has-selection');
      renderToolbarBar();
      renderMain();
      renderSelectionBar();
    }
    function exitSelectMode(): void {
      selectMode = false;
      selectedIds.clear();
      selectAnchor = null;
      document.body.classList.remove('has-selection');
      closeAlbumMenu();
      renderToolbarBar();
      renderMain();
      renderSelectionBar();
    }
    function toggleSelect(assetId: string, shiftKey?: boolean): void {
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

    // ---- selection bar ----
    function closeAlbumMenu(): void {
      if (!albumMenuOpen) return;
      albumMenuOpen = false;
      document.removeEventListener('click', onAlbumMenuAway, true);
    }
    function onAlbumMenuAway(e: globalThis.MouseEvent): void {
      const wrap = $('selectionBar').querySelector('.bar-menu-wrap');
      if (wrap && !wrap.contains(e.target as Node)) {
        closeAlbumMenu();
        renderSelectionBar();
      }
    }
    function toggleAlbumMenu(): void {
      if (albumMenuOpen) {
        closeAlbumMenu();
        renderSelectionBar();
        return;
      }
      albumMenuOpen = true;
      renderSelectionBar();
      document.addEventListener('click', onAlbumMenuAway, true);
    }
    function closeAlbumMenuAndRerender(): void {
      closeAlbumMenu();
      renderSelectionBar();
    }
    function setBarBusy(on: boolean): void {
      batchBusy = on;
      for (const btn of $('selectionBar').querySelectorAll('button')) btn.disabled = on;
    }
    function renderSelectionBar(): void {
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

    // ---- zoom ----
    function renderZoomButtons(): void {
      $<HTMLButtonElement>('zoomOutBtn').disabled = zoomIndex === 0;
      $<HTMLButtonElement>('zoomInBtn').disabled = zoomIndex === ZOOM_LEVELS.length - 1;
    }

    // ---- search ----
    const { run: runSearch, invalidate: invalidateSearch } = createSearch({
      getQuery: () => searchQuery,
      setResults: (r) => {
        searchResults = r;
      },
      renderGrid: renderMain,
    });
    const debouncedLocalRender = debounce(() => {
      renderToolbarBar();
      renderMain();
    }, 180);
    function clearSearch(): void {
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

    // ---- upload ----
    async function uploadFiles(files: File[]): Promise<void> {
      if (uploading || files.length === 0) return;
      await runUpload(files, {
        refresh,
        setUploading: (v) => {
          uploading = v;
        },
      });
    }

    // ---- region factories (constructed once, exactly like app.tsx Boot) ----
    setSlot('enrichment', <EnrichmentPanel />);

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

    // ---- raw DOM + global wiring (was app.tsx's imperative listeners) ----
    const onSearchInput = (): void => {
      searchQuery = $<HTMLInputElement>('searchInput').value.trim();
      $('searchClear').hidden = searchQuery === '';
      debouncedLocalRender();
      runSearch();
    };
    const onSearchKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if ($<HTMLInputElement>('searchInput').value) clearSearch();
      else $('searchInput').blur();
    };
    const onSearchClear = (): void => {
      clearSearch();
      $('searchInput').focus();
    };
    const onZoomOut = (): void => {
      zoomIndex = Math.max(0, zoomIndex - 1);
      renderZoomButtons();
      renderMain();
    };
    const onZoomIn = (): void => {
      zoomIndex = Math.min(ZOOM_LEVELS.length - 1, zoomIndex + 1);
      renderZoomButtons();
      renderMain();
    };
    const onHamburger = (): void => sidebar.openSidebar();
    const onSlideshowBtn = (): void => lightbox.startSlideshow(null);
    const onKeydown = (e: globalThis.KeyboardEvent): void => {
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
    };
    const onFocus = (): void => {
      if (lastFreshLoadAt && Date.now() - lastFreshLoadAt < FOCUS_STALE_MS) return;
      void refresh();
    };
    const onDataChangeDebounced = debounce(() => void refresh(), 200);

    // Capture the element references at wire-time. Cleanup runs on unmount AFTER
    // React has already removed these nodes, so a fresh `$(…)` (getElementById)
    // would return null and `removeEventListener` would throw (#505 — the
    // Photos→app→Photos remount crash). `removeEventListener` on a now-detached
    // node is a harmless no-op.
    const searchInput = $<HTMLInputElement>('searchInput');
    const searchClearBtn = $('searchClear');
    const zoomOutBtn = $('zoomOutBtn');
    const zoomInBtn = $('zoomInBtn');
    const hamburgerBtn = $('hamburgerBtn');
    const slideshowBtn = $('slideshowBtn');
    searchInput.addEventListener('input', onSearchInput);
    searchInput.addEventListener('keydown', onSearchKeyDown);
    searchClearBtn.addEventListener('click', onSearchClear);
    zoomOutBtn.addEventListener('click', onZoomOut);
    zoomInBtn.addEventListener('click', onZoomIn);
    hamburgerBtn.addEventListener('click', onHamburger);
    slideshowBtn.addEventListener('click', onSlideshowBtn);
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('focus', onFocus);
    const stopChange = window.centraid.onChange?.((detail) => {
      if (libraryLiveOwnsData) return;
      const tables = detail?.tables;
      if (!Array.isArray(tables) || tables.length === 0) {
        onDataChangeDebounced();
        return;
      }
      if (tables.some((t) => PHOTOS_READ_TABLES.has(t))) onDataChangeDebounced();
    });

    // The grid's real width drives the justified timeline (read off #grid, not
    // #scrollPane whose clientWidth includes its own padding).
    function measurePane(): void {
      const el = $('grid');
      const w = el?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 0);
      if (w > 0 && Math.abs(w - paneWidth) > 1) {
        paneWidth = w;
        renderMain();
      }
    }
    let paneObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined' && $('grid')) {
      paneObserver = new ResizeObserver(measurePane);
      paneObserver.observe($('grid'));
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', measurePane);
    }

    // Component-width narrow observer (#505 trap 1): the served path leans on
    // viewport `@media` widths, wrong for an app pane narrower than the viewport.
    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 860, (isNarrow: boolean) => {
          setNarrow(isNarrow);
          if (!isNarrow) sidebar.closeSidebar();
        })
      : () => {};

    // ---- first paint ----
    renderZoomButtons();
    mainRoot.render(<KitSkeleton rows={6} />);
    void refresh({ record: false });

    return () => {
      searchInput.removeEventListener('input', onSearchInput);
      searchInput.removeEventListener('keydown', onSearchKeyDown);
      searchClearBtn.removeEventListener('click', onSearchClear);
      zoomOutBtn.removeEventListener('click', onZoomOut);
      zoomInBtn.removeEventListener('click', onZoomIn);
      hamburgerBtn.removeEventListener('click', onHamburger);
      slideshowBtn.removeEventListener('click', onSlideshowBtn);
      window.removeEventListener('keydown', onKeydown);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('resize', measurePane);
      document.removeEventListener('click', onAlbumMenuAway, true);
      document.body.classList.remove('has-selection');
      stopChange?.();
      stopWidth();
      paneObserver?.disconnect();
      libraryLiveUnsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once boot, stable via refs (#505)
  }, []);

  return (
    // Fill the app pane (a flex child of the route body) so the inline chrome
    // gets real width — otherwise it collapses to content width and the
    // component-width narrow observer wrongly flips to the phone drawer layout
    // (#505 trap 1). The Photos token layer (Chrome.module.css `.appRoot`) rides
    // this same element, which the host also stamps `.centraid-inline-scope`.
    <div
      ref={setRoot}
      className={styles.appRoot}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}
    >
      <Chrome narrow={narrow} ready={ready} slots={slots.current} />
    </div>
  );
}
