// governance: allow-repo-hygiene file-size-limit — the app's orchestration is one React tree by design (#505). The v4 frame rewrite pulled the shelf model (shelves.ts), the filters (filters.ts), the copy (view-copy.ts), the member preferences (member-prefs.ts) and the frame contribution (frame.tsx) out of it; what is left is the wiring those five modules are wired BY, and splitting it further would split one closure across files.
// Photos — query-free React tree (#505), a route inside the frame (v4 §3).
// Multi-scope (#599, §H): N scopes as one timeline; albums/places/trash stay
// own-scope (ids collide). Timeline merges, then filters by `vaultsOn`.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { ReactElement, ReactNode } from "react";

import { debounce, observeWidth } from "@centraid/design/elements";

import { publishOutcome } from "../_shared/app-frame.tsx";
import { Skeleton } from "../_shared/LoadingSkeleton.tsx";
import { navSeat } from "../_shared/nav-seat.ts";
import { NavRail } from "../_shared/NavRail.tsx";
import {
  mountedScopes,
  ownScopeId,
  photoWriteTarget,
} from "../_shared/scope-kit.ts";
import type { WriteTarget } from "../_shared/write-target.ts";
import type { InlineScope, InlineAppProps } from "../inline-types.ts";
import {
  deleteAlbumConfirmed,
  submitNewAlbum,
  submitRenameAlbum,
} from "./albums-actions.ts";
import { assetKey } from "./asset-key.ts";
import { Chrome } from "./Chrome.tsx";
import type { ChromeSlots } from "./Chrome.tsx";
import { AlbumBar } from "./components/AlbumBar.tsx";
import { AlbumGridView } from "./components/AlbumGrid.tsx";
import { EmptyTrash } from "./components/EmptyTrash.tsx";
import { FaceReview } from "./components/FaceReview.tsx";
import { ImportPanels } from "./components/Import.tsx";
import type { ImportResult } from "./components/Import.tsx";
import { InlineInput } from "./components/InlineInput.tsx";
import { LoadingGrid } from "./components/LoadingGrid.tsx";
import { MemoriesStrip } from "./components/Memories.tsx";
import { MoreSheet } from "./components/MoreSheet.tsx";
import { OfflineBanner } from "./components/OfflineBanner.tsx";
import { PeopleShelf } from "./components/People.tsx";
import { PermissionScreen } from "./components/Permission.tsx";
import {
  PlacesShelf,
  placeSectionsWithNoLocation,
} from "./components/Places.tsx";
import type { placeSections } from "./components/Places.tsx";
import { SearchShelf } from "./components/SearchShelf.tsx";
import { ShelfStrip } from "./components/ShelfStrip.tsx";
import { StorageView, storageFacts } from "./components/Storage.tsx";
import { MEMORIES_MAX_RUNG, TimelineBody } from "./components/Timeline.tsx";
import { ToolbarView } from "./components/Toolbar.tsx";
import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from "./constants.ts";
import { createCustody } from "./custody-store.ts";
import { $ } from "./dom.ts";
import { createDuplicates } from "./duplicates.tsx";
import { createEnrichmentGate } from "./enrichment-gate.ts";
import { filterByKind, scopeIsOn, writeScopeFor } from "./filters.ts";
import type { KindFilter } from "./filters.ts";
import { appBar, bandClaim } from "./frame.tsx";
import { gridWidthFallback, RAIL_WIDTH, rungHeight } from "./layout.ts";
import {
  createRefetchScheduler,
  readLibraryScopes,
  stopLiveReads,
} from "./library-reads.ts";
import { createLibraryStore } from "./library-store.ts";
import { createLightbox, viewerKeyAction } from "./lightbox.tsx";
import { createMemberPrefs, stepTileSize } from "./member-prefs.ts";
import { buildMemories, enrichAlbums } from "./memories.ts";
import { photosNavRail, railDrawnOn } from "./nav-rail.ts";
import { notice, setStatusSink, setWriteTargetResolver } from "./outcomes.ts";
import { createPeople } from "./people.ts";
import { createPicker } from "./picker.tsx";
import { searchGroups } from "./search-groups.ts";
import { createSearch } from "./search.ts";
import type { SearchStatus } from "./search.ts";
import { runBatchDownload } from "./selection-actions.ts";
import { createSelection } from "./selection.tsx";
import {
  allowsSelection,
  countKey,
  PEOPLE,
  personIdFrom,
  personShelf,
  PLACES,
  SEARCH,
  shelfFromSegment,
  shelfKindFor,
  showsTileSize,
  STORAGE,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import { createSlideshow } from "./slideshow.tsx";
import type { Album, Asset, MemoryCard, Place } from "./types.ts";
import { applyUploadTarget, runUpload, wireUpload } from "./upload.ts";
import {
  DOWNLOAD_PRIMARY,
  downloadPrimaryTitle,
  OFFLINE_COPY,
  shelfCopy,
} from "./view-copy.ts";
import {
  emptyStateView,
  libraryReachability,
  NO_EMPTY_STATE,
  shelfAfterRead,
} from "./view-state.ts";
import type { EmptyStateView } from "./view-state.ts";
import { createVisibility } from "./visibility.ts";

import styles from "./Chrome.module.css";

// The change-subscription filter AND the onChange refetch gate (#404).
export const PHOTOS_READ_TABLES_LIST = [
  "media.asset",
  "core.content_item",
  "core.collection",
  "core.collection_entry",
  "core.place",
  "core.concept_scheme",
  "core.concept",
  "core.tag",
  "blob.custody_state",
  // A sweep rewrites the Storage rollup (#711); repaint when it does.
  "blob.custody_rollup",
];
const PHOTOS_READ_TABLES = new Set<string>(PHOTOS_READ_TABLES_LIST);
const FOCUS_STALE_MS = 30_000;

type SlotKey = keyof ChromeSlots;

export function Root({
  rootRef,
  frame,
  compact = false,
}: InlineAppProps): ReactElement {
  const rootElRef = useRef<HTMLDivElement | null>(null);
  // Boot closure reads `frame` via this ref — never written during render.
  const frameRef = useRef(frame);
  const compactRef = useRef(compact);
  const narrowRef = useRef(false);
  const [slots, setSlots] = useState<ChromeSlots>({
    shelfStrip: null,
    navRail: null,
    toolbar: null,
    banner: null,
    main: null,
    selectionBottomBar: null,
    lightbox: null,
    slideshow: null,
    picker: null,
    permission: null,
    moreSheet: null,
  });

  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);

  useEffect(() => {
    compactRef.current = compact;
  }, [compact]);

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
    },
    [rootRef]
  );

  // Seed narrow BEFORE first paint, measuring the real element (#505 trap 1).
  useLayoutEffect(() => {
    const el = rootElRef.current;
    if (el) {
      const forced = el.dataset.appWidth === "narrow";
      const isNarrow = forced || el.clientWidth < 860;
      narrowRef.current = isNarrow;
    }
  }, []);

  useEffect(() => {
    let disposed = false;

    const setSlot = (key: SlotKey, node: ReactNode): void => {
      setSlots((prev) => ({ ...prev, [key]: node }));
    };
    const mk = (key: SlotKey) => ({
      render: (node: ReactNode) => setSlot(key, node),
    });
    const shelfStripRoot = mk("shelfStrip");
    // Its own slot: the strip stands above the scroll pane, the rail beside it (v16).
    const navRailRoot = mk("navRail");
    const toolbarRoot = mk("toolbar");
    const bannerRoot = mk("banner");
    const mainRoot = mk("main");
    const selectionBottomBarRoot = mk("selectionBottomBar");
    const lightboxRoot = mk("lightbox");
    const pickerRoot = mk("picker");
    const slideshowRoot = mk("slideshow");
    const permissionRoot = mk("permission");
    const moreSheetRoot = mk("moreSheet");

    let assets: Asset[] = [];
    let albums: Album[] = [];
    let places: Place[] = [];
    let trash: Asset[] = [];
    /** Built-in ids from shelves.ts; an album's own id means album detail. */
    let shelf: ShelfId = null;
    let uploading = false;
    /** Set by the first successful read; later failure does not un-know (§14). */
    let loaded = false;
    let readFailed = false;
    let offlineShown = false;
    let searchQuery = "";
    let searchResults: Asset[] | null = null;
    let searchStatus: SearchStatus = "resting";
    /** Per-scope miss, named beside hits other scopes still have (#726 D10/D11). */
    let searchReachFacts: readonly { label: string; value: string }[] = [];
    let moreOpen = false;
    let kind: KindFilter = "all";
    let newAlbumOpen = false;
    let renamingAlbum = false;
    /** Last import with something to explain (§11); null after an all-new run; member-cleared. */
    let lastImport: ImportResult | null = null;
    // People-shelf mode, not a ninth tab: any navigation returns to the roster.
    let faceReviewOpen = false;
    let faceReviewFocusRegionId: string | null = null;
    let paneWidth = gridWidthFallback(
      typeof window === "undefined" ? 1280 : window.innerWidth
    );
    let libraryTruncated = false;
    /** App bar drops Import while denied (§13): an import that cannot land is not an offer. */
    let accessDenied = false;
    let lastFreshLoadAt = 0;
    let recordNextLoad = false;

    // The two member-record preferences (§16); see member-prefs.ts.
    const prefs = createMemberPrefs(() => {
      renderNavigation();
      renderToolbarRow();
      renderMain();
      contributeAppBar();
    });

    // Scopes (issue #599)
    const scopesNow = (): InlineScope[] => mountedScopes();
    const ownId = (): string => ownScopeId(scopesNow());
    let ownAssets: Asset[] = [];
    /** Tile marker from `personal`, never the renameable label (§H). */
    const vaultOf = (
      scopeId: string | null | undefined
    ): InlineScope | undefined =>
      scopesNow().find((scope) => scope.id === (scopeId ?? ""));
    // One vault on is an unambiguous target; several falls back to own.
    setWriteTargetResolver((kindOfWrite) =>
      photoWriteTarget(
        kindOfWrite,
        writeScopeFor(prefs.read().vaultsOn),
        scopesNow()
      )
    );

    // The frame's ONE status line (§3, §14): every write outcome announces
    // itself here, Undo where possible. No toast/badge/spinner/dot. `progress`
    // rides through untouched — a caller that does not know says nothing.
    setStatusSink((note) =>
      publishOutcome(
        frameRef.current,
        note === null
          ? null
          : {
              text: note.text,
              ...(note.undo ? { undo: note.undo } : {}),
              ...(note.progress ? { progress: note.progress } : {}),
            }
      )
    );

    const store = createLibraryStore({
      readScopes: (scopeIds, input) =>
        readLibraryScopes(scopeIds, input, (scopeId, data) =>
          store.applyScopeData(scopeId, data)
        ),
      scopeIds: () => scopesNow().map((scope) => scope.id),
      ownScopeId: ownId,
      readTables: PHOTOS_READ_TABLES,
      schedule: createRefetchScheduler(debounce),
      onData: () => applyStore(),
    });

    function applyStore(): void {
      if (disposed) return;
      const own = store.own();
      // Consent denial and read failure are OWN-scope outcomes.
      const denied = own.denied;
      // PERMISSION IS A SCREEN (§13): Chrome HIDES the live region rather than unmounting, so loaded bytes survive a grant.
      accessDenied = Boolean(denied);
      permissionRoot.render(
        denied ? <PermissionScreen reason={denied.message ?? null} /> : null
      );
      if (denied) {
        contributeAppBar();
        return;
      }
      // A FAILED READ IS NOT A DEAD END (§14): record it, let the banner explain,
      // keep rendering the replica's last good pages.
      readFailed = Boolean(own.error);
      renderOfflineBanner();
      const view = store.merged();
      // Same query row from two sides; see library-store.ts's note.
      const merged = view.rows as unknown as Asset[];
      const own_ = ownId();
      const vaultsOn = prefs.read().vaultsOn;
      ownAssets = merged.filter((asset) => (asset.scope_id ?? "") === own_);
      assets = filterByKind(
        merged.filter((asset) => scopeIsOn(vaultsOn, asset.scope_id)),
        kind
      );
      libraryTruncated = view.truncated;
      albums = own.albums;
      places = own.places;
      trash = own.trash;
      // A returned read has landed — THAT is when the empty state may speak.
      if (!readFailed) loaded = true;
      // NO Trash → Library redirect (§14); the one shelf a read can invalidate
      // is a deleted album.
      shelf = shelfAfterRead(
        shelf,
        albums.map((album) => album.album_id)
      );
      selection.prune(assets);
      if (recordNextLoad) lastFreshLoadAt = Date.now();
      recordNextLoad = true;
      renderNavigation();
      renderToolbarRow();
      renderMain();
      selection.renderBar();
      contributeAppBar();
      lightbox.renderIfOpen();
    }

    /** Driven by `libraryReachability`. Do not restyle the frame's `--net` dot. */
    function renderOfflineBanner(): void {
      const offline =
        libraryReachability({
          hostStatus: rootElRef.current?.dataset.gatewayStatus,
          readFailed,
        }) === "unreachable";
      bannerRoot.render(
        offline ? <OfflineBanner onRetry={handleRetryRead} /> : null
      );
      // Transition edge only: re-asserting every repaint would eat a write outcome.
      if (offline && !offlineShown) {
        notice(OFFLINE_COPY.status);
        offlineShown = true;
      } else if (!offline && offlineShown) {
        // A state, not an outcome, so it does not linger.
        notice("");
        offlineShown = false;
      }
    }
    const handleRetryRead = (): void => {
      void refresh();
    };

    function isAlbumId(id: ShelfId): id is string {
      return (
        typeof id === "string" &&
        !id.startsWith("built-in:") &&
        !id.startsWith("tag:")
      );
    }
    function currentAlbum(): Album | undefined {
      return isAlbumId(shelf)
        ? albums.find((a) => a.album_id === shelf)
        : undefined;
    }

    /** One answer for bar Rename/Delete, tile Remove, and app-bar primary. */
    function albumWriteTarget(): WriteTarget {
      return photoWriteTarget("own", null, scopesNow());
    }
    function albumRefusalReason(): string | undefined {
      const target = albumWriteTarget();
      return target.disabled ? target.reason : undefined;
    }
    /** Shell label, never a storage noun (#599). */
    function ownScopeLabel(): string {
      const own = ownId();
      return scopesNow().find((scope) => scope.id === own)?.label ?? "Library";
    }

    /** Read-only primary: same batch path as the selection bar; progress ref null here. */
    const handleDownloadAll = (): void => {
      const shown = visibleAssets();
      void runBatchDownload(
        shown.map((asset) => assetKey(asset)),
        shown,
        { current: null },
        { setBarBusy: () => {} }
      );
    };

    async function refresh(): Promise<void> {
      await store.refreshAll();
    }

    function albumAssets(): Asset[] {
      if (!shelf) return assets;
      // Favorites/tags travel with the row (merged list); album membership is
      // an ID match against own-scope assets only — ids collide across scopes.
      if (shelf === FAVORITES) return assets.filter((a) => a.favorite);
      if (shelf === TRASH) return trash;
      if (typeof shelf === "string" && shelf.startsWith("tag:")) {
        const label = shelf.slice(4);
        return assets.filter((a) => a.tags?.some((t) => t.label === label));
      }
      if (typeof shelf === "string" && shelf.startsWith("memory:")) {
        const memoryId = shelf.slice("memory:".length);
        const memberIds = new Set(
          store
            .own()
            .memoryMembers.filter((member) => member.memory_id === memoryId)
            .map((member) => member.asset_id)
        );
        return ownAssets.filter((asset) => memberIds.has(asset.asset_id));
      }
      // One flat list in DRAWN order, so the lightbox walk agrees with the
      // screen. Places are own-scope, like albums.
      if (shelf === PLACES) return sections().flatMap((s) => s.assets);
      // One person's sub-state: the same timeline under a filter (§5).
      const personId = personIdFrom(shelf);
      if (personId) return people.assetsFor(personId, ownAssets);
      return ownAssets.filter((a) => a.album_ids?.includes(shelf!));
    }

    /** Own-scope, for the same reason albums are. */
    function sections(): ReturnType<typeof placeSections> {
      // The shelf as DRAWN (#816): search and lightbox walk the same list.
      return placeSectionsWithNoLocation(ownAssets);
    }

    const { visibleAssets, findAsset } = createVisibility({
      getAssets: () => assets,
      getTrash: () => trash,
      getAlbumAssets: albumAssets,
      getSearchResults: () => searchResults,
      getSearchQuery: () => searchQuery,
      getSelectedAlbum: () => shelf,
    });

    function memories(): MemoryCard[] {
      if (rootElRef.current?.dataset.showMemories === "hide") return [];
      return buildMemories({
        ownAssets,
        memories: store.own().memories,
        memoryMembers: store.own().memoryMembers,
        onOpen: (id) => navigateTo(id),
      });
    }

    function navigateTo(id: ShelfId): void {
      // The strip is the review's only way back: re-selecting Duplicates
      // returns to the cluster list.
      if (shelf === DUPLICATES) {
        if (id === DUPLICATES) duplicates.exitReview();
        else duplicates.invalidate();
      }
      shelf = id;
      newAlbumOpen = false;
      renamingAlbum = false;
      // Any navigation closes the review queue.
      faceReviewOpen = false;
      faceReviewFocusRegionId = null;
      // Navigating IS the dismissal — never a sheet over the destination just reached.
      if (moreOpen) closeMore();
      // Cleared only when the route leaves Photos (§16), not on shelf change (§6).
      renderNavigation();
      renderToolbarRow();
      renderMain();
      contributeAppBar();
    }

    /** A pure re-projection of data already held: no scope is re-read. */
    function toggleVault(scopeId: string): void {
      const current = prefs.read().vaultsOn;
      const every = scopesNow().map((scope) => scope.id);
      // Resting state "every one" held as an EMPTY set: the first toggle
      // materialises the full set and removes one — never isolates one.
      const base = current.size === 0 ? new Set(every) : new Set(current);
      if (base.has(scopeId)) base.delete(scopeId);
      else base.add(scopeId);
      // Switching the last off would show an unexplainable empty timeline.
      prefs.write({
        vaultsOn:
          base.size === 0 || base.size === every.length ? new Set() : base,
      });
      applyStore();
    }

    function selectKind(next: KindFilter): void {
      kind = next;
      applyStore();
    }

    function contributeAppBar(): void {
      const album = currentAlbum();
      const copy = shelfCopy(shelf);
      const personId = personIdFrom(shelf);
      const person = personId ? people.find(personId) : undefined;
      const memory =
        typeof shelf === "string" && shelf.startsWith("memory:")
          ? store
              .own()
              .memories.find(
                (entry) => entry.memory_id === shelf!.slice("memory:".length)
              )
          : undefined;
      const target = photoWriteTarget(
        "new",
        writeScopeFor(prefs.read().vaultsOn),
        scopesNow()
      );
      const count = countFor();
      // A READ-ONLY SURFACE SWAPS THE PRIMARY, NOT LOSES IT: what replaces
      // Import is what the grant allows.
      const readOnlyAlbum = Boolean(album) && albumWriteTarget().disabled;
      // Phone (§6, §15): Select all/none stays in the head; only the five
      // actions move to the bottom bar.
      const phoneSelectHead =
        narrowRef.current && selection.isActive()
          ? {
              onToggleAll: selection.toggleAll,
              selectedCount: selection.keys.size,
            }
          : {};
      const contribution = appBar({
        // Position ("cluster 2 of 6") NOT here: `{count, unit}` cannot express
        // it, so the review draws it in its own section head.
        title:
          shelf === DUPLICATES && duplicates.reviewing()
            ? "Duplicate review"
            : album
              ? (album.title ?? "Album")
              : (memory?.title_hint ??
                (memory?.kind === "on-this-day"
                  ? "On this day"
                  : memory?.kind === "similar"
                    ? "Similar photographs"
                    : (person?.name ?? (personId ? "Someone" : copy.title)))),
        count,
        unit: album || personId ? "photographs" : copy.unit,
        showSelect: allowsSelection(shelf) || Boolean(album),
        selectMode: selection.isActive(),
        onToggleSelect: () =>
          selection.isActive() ? selection.exit() : selection.enter(),
        // ONE FILLED INK ELEMENT PER VIEW (§18): the empty block's filled
        // Import is where the member looks, so the bar stands down.
        showImport:
          !accessDenied &&
          !readOnlyAlbum &&
          !emptyBlockOffersImport() &&
          shelf !== TRASH &&
          shelf !== DUPLICATES &&
          shelf !== STORAGE &&
          // No primary on Search (§9): the shelf's field is where the member looks.
          shelf !== SEARCH,
        // In an album the natural "add" is from the library — the ONLY picker
        // route while NON-EMPTY; the empty-block entry hides once it has one.
        onImport: () => (album ? openPicker() : $("fileInput").click()),
        // Compact band claims Search, so the bar drops its control there (§9).
        compact: narrowRef.current,
        onSearch: () => navigateTo(SEARCH),
        ...(target.disabled ? { importDisabledReason: target.reason } : {}),
        ...phoneSelectHead,
      });
      frameRef.current.setAppBar(
        readOnlyAlbum
          ? {
              ...contribution,
              // COMPOSED onto the frame's actions, LAST — where the primary lives.
              actions: (
                <>
                  {contribution.actions}
                  <button
                    type="button"
                    className="kit-btn primary"
                    // Help on an ENABLED control, named by the scope's label (#599).
                    title={downloadPrimaryTitle(ownScopeLabel())}
                    onClick={handleDownloadAll}
                  >
                    {DOWNLOAD_PRIMARY}
                  </button>
                </>
              ),
            }
          : shelf === DUPLICATES &&
              !duplicates.reviewing() &&
              (duplicates.count() ?? 0) > 0
            ? {
                ...contribution,
                // Offered only after `count()` answers positively.
                actions: (
                  <>
                    {contribution.actions}
                    <button
                      type="button"
                      className="kit-btn primary"
                      onClick={() => duplicates.openReview()}
                    >
                      Review duplicates
                    </button>
                  </>
                ),
              }
            : contribution
      );
      // Claimed unconditionally; honoured only first-party + compact (§3.1).
      frameRef.current.claimBand(
        bandClaim(
          shelf,
          (segment) => navigateTo(shelfFromSegment(segment)),
          openMore
        )
      );
    }

    /** Null where a count would have to be invented rather than read. */
    function countFor(): number | null {
      if (shelf === ALBUMS) return albums.length;
      // The places LOADED photographs name, not the whole known place list.
      if (shelf === PLACES) return sections().length;
      if (shelf === PEOPLE) return people.list()?.length ?? null;
      // Known once the shelf's load lands; `count()` carries the same
      // "not yet answered" null as every lazy shelf.
      if (shelf === DUPLICATES) return duplicates.count();
      if (shelf === STORAGE) return null;
      if (shelf === SEARCH) return searchResults?.length ?? null;
      return visibleAssets().length;
    }

    // ONE FUNCTION FOR ONE QUESTION (v16, §5): rail and strip are one spine on
    // two axes, re-rendered together so they can never disagree.
    function renderNavigation(): void {
      renderNavRail();
      renderShelfStrip();
    }

    /** Pointer seat only: `narrow`=pane, `compact`=shell; a rail on either withdraws the strip (v16 §4). */
    function renderNavRail(): void {
      const seat = navSeat({
        narrow: narrowRef.current,
        compact: compactRef.current,
      });
      if (seat !== "rail" || accessDenied || !railDrawnOn(shelf)) {
        navRailRoot.render(null);
        return;
      }
      navRailRoot.render(
        <NavRail
          label="Photos"
          items={photosNavRail({
            shelf,
            counts: shelfCounts(),
            onSelect: navigateTo,
          })}
        />
      );
    }

    function renderShelfStrip(): void {
      const album = currentAlbum();
      const refusal = albumRefusalReason();
      if (album) {
        // Album detail drops the strip and puts the way back in its place.
        shelfStripRoot.render(
          <AlbumBar
            albumId={album.album_id}
            title={album.title ?? "Album"}
            renaming={renamingAlbum}
            canWrite={!albumWriteTarget().disabled}
            // A refused control SAYS WHY, inline.
            {...(refusal === undefined ? {} : { reason: refusal })}
            onBack={() => navigateTo(ALBUMS)}
            onStartRename={() => {
              renamingAlbum = true;
              renderNavigation();
            }}
            onRenameSubmit={(title) =>
              submitRenameAlbum(album, title, {
                refresh,
                renderToolbar: renderNavigation,
                setRenamingAlbumForId: (id) => {
                  renamingAlbum = id !== null;
                },
              })
            }
            onRenameCancel={() => {
              renamingAlbum = false;
              renderNavigation();
            }}
            onDelete={() =>
              deleteAlbumConfirmed(album, {
                refresh,
                setSelectedAlbum: (id) => navigateTo(id),
              })
            }
          />
        );
        return;
      }
      // Shelves ride the band's seat, columns the rail's; the strip is what is
      // left. `navSeat` answers all seats at once (v16).
      if (
        navSeat({ narrow: narrowRef.current, compact: compactRef.current }) !==
        "strip"
      ) {
        shelfStripRoot.render(null);
        return;
      }
      // No strip on Search (§9): it reads as its own page, not a filtered timeline.
      if (shelf === SEARCH) {
        shelfStripRoot.render(null);
        return;
      }
      shelfStripRoot.render(
        <ShelfStrip
          shelf={shelf}
          narrow={narrowRef.current}
          onSelect={navigateTo}
        />
      );
    }

    /** One map for More sheet and rail (v16 §3); omit unknown counts — never a zero. */
    function shelfCounts(): ReadonlyMap<string, number> {
      const counts = new Map<string, number>([
        // Library's id is `null`, so it keys on the band's own root name.
        [countKey(null), assets.length],
        [FAVORITES, assets.filter((a) => a.favorite).length],
        [ALBUMS, albums.length],
        [PLACES, sections().length],
        [TRASH, trash.length],
      ]);
      const peopleCount = people.list()?.length;
      if (peopleCount !== undefined) counts.set(PEOPLE, peopleCount);
      const duplicateCount = duplicates.count();
      if (duplicateCount !== null) counts.set(DUPLICATES, duplicateCount);
      return counts;
    }

    // Toolbar row (§3) renders only when it carries something.
    function renderToolbarRow(): void {
      applyUploadTarget();
      if (selection.isActive()) {
        // While a selection is active, selection.tsx owns `#toolbarMount` —
        // do not race it with a null write.
        return;
      }
      const tileSize = prefs.read().tileSize;
      toolbarRoot.render(
        <ToolbarView
          scopes={scopesNow()}
          vaultsOn={prefs.read().vaultsOn}
          onToggleVault={toggleVault}
          kind={kind}
          onSelectKind={selectKind}
          {...(showsTileSize(shelf)
            ? {
                tileSize,
                onStepTileSize: (delta: number) =>
                  prefs.write({ tileSize: stepTileSize(tileSize, delta) }),
              }
            : {})}
        />
      );
    }

    function renderMain(): void {
      if (shelf === DUPLICATES) {
        applyEmptyState(NO_EMPTY_STATE);
        void duplicates.ensureLoaded();
        duplicates.renderDuplicates();
        return;
      }
      if (shelf === SEARCH) {
        applyEmptyState(NO_EMPTY_STATE);
        renderSearchShelf();
        return;
      }
      if (shelf === ALBUMS) {
        applyEmptyState(emptyFor(albums.length, { suppressed: newAlbumOpen }));
        renderAlbumsShelf();
        return;
      }
      if (shelf === STORAGE) {
        applyEmptyState(NO_EMPTY_STATE);
        renderStorage();
        return;
      }
      if (shelf === PLACES) {
        const grouped = sections();
        applyEmptyState(emptyFor(grouped.length));
        renderPlacesShelf(grouped);
        return;
      }
      if (shelf === PEOPLE) {
        // People shelf in review mode (§8); FaceReview fetches and writes itself.
        if (faceReviewOpen) {
          applyEmptyState(emptyFor(1));
          mainRoot.render(
            <FaceReview
              narrow={narrowRef.current}
              focusRegionId={faceReviewFocusRegionId ?? undefined}
            />
          );
          return;
        }
        // Lazy: the roster walks every confirmed face region.
        void people.ensureLoaded();
        const roster = people.list();
        const proposalRoster = people.proposalList() ?? [];
        // Gate = empty body only while there is nothing to browse (#712).
        const rosterEmpty =
          roster !== null && roster.length === 0 && proposalRoster.length === 0;
        if (rosterEmpty) enrichGate.ensurePolicyLoaded();
        const gateProps = rosterEmpty
          ? enrichGate.props(ownAssets.length)
          : null;
        // An unanswered roster is not an empty one; suppress the generic empty
        // block while the gate shows.
        applyEmptyState(
          gateProps
            ? NO_EMPTY_STATE
            : emptyFor(roster?.length ?? 0, { suppressed: roster === null })
        );
        mainRoot.render(
          roster === null ? (
            <Skeleton rows={3} />
          ) : (
            <PeopleShelf
              people={roster}
              proposals={proposalRoster}
              unmatchedCount={people.unmatchedTotal()}
              assets={ownAssets}
              onOpen={(partyId) => navigateTo(personShelf(partyId))}
              onReview={() => {
                faceReviewOpen = true;
                faceReviewFocusRegionId = null;
                renderMain();
              }}
              onNameProposal={(regionId) => {
                faceReviewOpen = true;
                faceReviewFocusRegionId = regionId;
                renderMain();
              }}
              {...(gateProps ? { gate: gateProps } : {})}
            />
          )
        );
        return;
      }

      const shown = visibleAssets();
      applyEmptyState(emptyFor(shown.length));

      // BEFORE THE FIRST READ LANDS THE GRID IS A SHAPE, NOT A VERDICT (§14):
      // `shown` is [] while in flight; --skel at packed geometry means no reflow.
      if (!loaded) {
        const phone = narrowRef.current;
        mainRoot.render(
          <LoadingGrid
            containerWidth={paneWidth - (phone ? 0 : RAIL_WIDTH)}
            targetHeight={rungHeight(
              prefs.read().tileSize,
              phone ? "phone" : "desktop"
            )}
            phone={phone}
          />
        );
        return;
      }

      mainRoot.render(
        timeline(shown, {
          memories: timelineHead(),
          truncated: libraryTruncated,
          handleShowMore: async (e) => {
            e.currentTarget.disabled = true;
            await store.showMore();
          },
        })
      );
    }

    /** Import panels first, then shelf head; memories on Library at rungs XS-M. */
    function timelineHead(): ReactNode {
      const panels = lastImport ? (
        <ImportPanels
          result={lastImport}
          onDismiss={() => {
            lastImport = null;
            renderMain();
          }}
        />
      ) : null;
      const showMemories =
        shelf === null &&
        searchQuery.trim() === "" &&
        !selection.isActive() &&
        prefs.read().tileSize <= MEMORIES_MAX_RUNG;
      const shelfHead =
        shelf === TRASH ? (
          <EmptyTrash trash={trash} refresh={refresh} />
        ) : showMemories ? (
          <MemoriesStrip memories={memories()} />
        ) : null;
      if (!panels) return shelfHead;
      return (
        <>
          {panels}
          {shelfHead}
        </>
      );
    }

    /** Same grid under a different filter (§5) — one props site. */
    function timeline(
      shown: Asset[],
      extra: {
        memories?: ReactNode;
        truncated: boolean;
        handleShowMore: (e: {
          currentTarget: HTMLButtonElement;
        }) => Promise<void>;
      }
    ): ReactNode {
      const album = currentAlbum();
      const albumRefusal = albumRefusalReason();
      const phone = narrowRef.current;
      const rung = prefs.read().tileSize;
      // Named for jsx-handler-names; re-pointing keeps selection.tsx the owner.
      const handleEnterSelect = selection.enter;
      const handleToggleSelect = selection.toggle;
      // Pinch walks the SAME four rungs the stepper does (§4.2).
      const handlePinchRung = (delta: number): void => {
        prefs.write({ tileSize: stepTileSize(prefs.read().tileSize, delta) });
      };
      return (
        <TimelineBody
          assets={shown}
          // Real column on desktop/PWA — packer budget excludes it; overlays on phone.
          containerWidth={paneWidth - (phone ? 0 : RAIL_WIDTH)}
          targetHeight={rungHeight(rung, phone ? "phone" : "desktop")}
          rung={rung}
          phone={phone}
          memories={extra.memories ?? null}
          inAlbum={Boolean(album)}
          albumId={album ? album.album_id : null}
          // Gated by the SAME answer as Rename/Delete; inAlbum alone would
          // refuse two writes and offer a third.
          canWriteAlbum={!albumWriteTarget().disabled}
          {...(albumRefusal === undefined ? {} : { albumReason: albumRefusal })}
          isTrash={shelf === TRASH}
          refresh={refresh}
          selectedAlbum={shelf}
          searchQuery={searchQuery}
          libraryWindow={shown.length}
          truncated={extra.truncated}
          vaultOf={vaultOf}
          selectMode={selection.isActive()}
          selectedIds={selection.keys}
          onEnterSelectMode={handleEnterSelect}
          onToggleSelect={handleToggleSelect}
          onOpen={handleOpenLightbox}
          onPinchRung={handlePinchRung}
          onShowMore={extra.handleShowMore}
        />
      );
    }

    function emptyFor(
      count: number,
      extra: { suppressed?: boolean } = {}
    ): EmptyStateView {
      const personId = personIdFrom(shelf);
      const person = personId ? people.find(personId) : undefined;
      return emptyStateView({
        loaded,
        count,
        shelf,
        query: searchQuery,
        inAlbum: Boolean(currentAlbum()),
        personName: personId ? (person?.name ?? "this person") : null,
        // Compact only (§15): never a camera-named picker on desktop.
        phone: narrowRef.current,
        ...extra,
      });
    }

    /** Imperative nodes bound at boot (`#emptyUpload`) — never unmount. */
    function applyEmptyState(view: EmptyStateView): void {
      $("empty").hidden = !view.visible;
      if (!view.visible) return;
      $("emptyText").textContent = view.title;
      $("emptyBody").textContent = view.body;
      $("emptyUpload").hidden = !view.offersImport;
      $("emptyCamera").hidden = !view.offersCamera;
    }

    /** Read the rendered view, never re-derive (§18). `renderMain` always runs before `contributeAppBar`. */
    function emptyBlockOffersImport(): boolean {
      return !$("empty").hidden && !$("emptyUpload").hidden;
    }

    function renderAlbumsShelf(): void {
      const enriched = enrichAlbums(albums, ownAssets);
      mainRoot.render(
        <>
          {newAlbumOpen ? (
            <InlineInput
              className="kit-input bare"
              placeholder="Album name"
              label="New album name"
              onSubmit={(title) =>
                submitNewAlbum(title, {
                  refresh,
                  renderToolbar: renderMain,
                  setNewAlbumOpen: (v) => {
                    newAlbumOpen = v;
                  },
                  setSelectedAlbum: (id) => navigateTo(id),
                })
              }
              onCancel={() => {
                newAlbumOpen = false;
                renderMain();
              }}
            />
          ) : null}
          <AlbumGridView
            albums={enriched}
            onOpen={navigateTo}
            onNewAlbum={() => {
              newAlbumOpen = true;
              renderMain();
            }}
          />
        </>
      );
    }

    /** Sections, not cartography (§5). */
    function renderPlacesShelf(
      grouped: ReturnType<typeof placeSections>
    ): void {
      const phone = narrowRef.current;
      const rung = prefs.read().tileSize;
      // Named for jsx-handler-names, exactly as `timeline()` does.
      const handleToggleSelect = selection.toggle;
      const handleEnterSelect = selection.enter;
      mainRoot.render(
        <PlacesShelf
          sections={grouped}
          containerWidth={paneWidth - (phone ? 0 : RAIL_WIDTH)}
          targetHeight={rungHeight(rung, phone ? "phone" : "desktop")}
          rung={rung}
          selectMode={selection.isActive()}
          selectedIds={selection.keys}
          vaultOf={vaultOf}
          refresh={refresh}
          onOpen={handleOpenLightbox}
          onToggleSelect={handleToggleSelect}
          onEnterSelectMode={handleEnterSelect}
        />
      );
    }

    /** Every number read off rows this app already holds (§12). */
    function renderStorage(): void {
      // First visit only: the rollup moves when the blob sweep runs.
      void custody.ensureLoaded();
      mainRoot.render(
        <StorageView
          facts={storageFacts(assets, trash, libraryTruncated)}
          custody={custody.facts()}
          onOpenTrash={() => navigateTo(TRASH)}
        />
      );
    }

    function renderSearchShelf(): void {
      const hits = visibleAssets();
      const groups = searchGroups({
        query: searchQuery,
        people: people.list() ?? [],
        placeSections: sections(),
        albums,
        ownAssets,
        hits,
      });
      mainRoot.render(
        <SearchShelf
          query={searchQuery}
          status={searchStatus}
          count={hits.length}
          groups={groups}
          onQuery={onSearchQuery}
          onClear={clearSearch}
          onRetry={runSearch}
          onOpenGroup={navigateTo}
          reachFacts={searchReachFacts}
        >
          {timeline(hits, {
            truncated: false,
            handleShowMore: async () => {},
          })}
        </SearchShelf>
      );
    }

    // Search (a shelf, §9)
    const { run: runSearch, invalidate: invalidateSearch } = createSearch({
      getQuery: () => searchQuery,
      setResults: (r) => {
        searchResults = r;
      },
      setStatus: (status) => {
        searchStatus = status;
      },
      renderGrid: renderMain,
      setReachFacts: (facts) => {
        searchReachFacts = facts;
      },
    });
    const debouncedLocalRender = debounce(() => {
      renderMain();
      contributeAppBar();
    }, 180);
    function onSearchQuery(value: string): void {
      searchQuery = value.trim();
      // `searching` is DETERMINATE, never a spinner (§14): local matches are
      // on screen, counted by the shelf.
      searchStatus = searchQuery === "" ? "resting" : "searching";
      renderMain();
      debouncedLocalRender();
      runSearch();
    }
    function clearSearch(): void {
      invalidateSearch();
      searchStatus = "resting";
      if (searchQuery !== "" || searchResults !== null) {
        searchQuery = "";
        searchResults = null;
      }
      searchReachFacts = [];
      renderMain();
      contributeAppBar();
    }

    // Band overflow sheet (§3.1): dismisses on Esc/Close/navigating — never by itself.
    function renderMoreSheet(): void {
      moreSheetRoot.render(
        moreOpen ? (
          <MoreSheet
            shelf={shelf}
            counts={shelfCounts()}
            onSelect={navigateTo}
            onClose={closeMore}
          />
        ) : null
      );
    }
    function openMore(): void {
      moreOpen = true;
      renderMoreSheet();
    }
    function closeMore(): void {
      moreOpen = false;
      renderMoreSheet();
    }

    // ──── upload ────
    async function uploadFiles(files: File[]): Promise<void> {
      if (uploading || files.length === 0) return;
      // WHAT THE TRASH HELD BEFORE THE RUN, snapshotted NOW: a re-upload that
      // restores bytes reports like an ordinary dedupe, and runUpload's
      // pre-return refresh destroys the evidence.
      const trashedBefore = new Set(trash.map((asset) => asset.asset_id));
      const result = await runUpload(files, {
        refresh,
        setUploading: (v) => {
          uploading = v;
        },
        wasTrashed: (assetId) => trashedBefore.has(assetId),
      });
      // Only a run with an outcome to explain leaves a panel (§11).
      lastImport = result.deduped + result.restored > 0 ? result : null;
      renderMain();
    }

    // selection.tsx owns mode/keys/busy/bar; this closure only reports data movement.
    const selection = createSelection({
      selectionBarRoot: toolbarRoot,
      bottomBarRoot: selectionBottomBarRoot,
      getVisible: visibleAssets,
      getAlbums: () => albums,
      refresh,
      repaint: () => {
        renderToolbarRow();
        renderMain();
        contributeAppBar();
      },
      getShelfKind: () => shelfKindFor(shelf),
      isNarrow: () => narrowRef.current,
    });

    // Own-scope and lazy, like the duplicate clusters.
    const people = createPeople({
      onData: () => {
        if (disposed) return;
        renderMain();
        contributeAppBar();
      },
    });

    // Consent gate lives in the People shelf's empty state (#712).
    const enrichGate = createEnrichmentGate({
      onData: () => {
        if (disposed) return;
        renderMain();
      },
    });

    // Lazy and multi-scope, like the People roster.
    const custody = createCustody({
      onData: () => {
        if (disposed) return;
        renderMain();
      },
    });

    const duplicates = createDuplicates({
      gridRoot: mainRoot,
      // ONE member preference, not a per-shelf size (§4.2).
      rung: () => prefs.read().tileSize,
      refresh,
      ownScope: () => {
        const target = photoWriteTarget("own", null, scopesNow());
        return target.disabled ? null : target.scopeId;
      },
    });
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
    const handleOpenLightbox = lightbox.openLightbox;
    const { openPicker, closePicker } = createPicker({
      pickerRoot,
      getAlbums: () => albums,
      getAssets: () => ownAssets,
      getSelectedAlbum: () => shelf,
      refresh,
    });

    wireUpload({
      uploadFiles,
      isAlbumSelected: () => Boolean(currentAlbum()),
      openPicker,
    });

    // Own input: `capture` on the shared one would steal the file picker from desktop (§14, §15).
    const onCameraClick = (): void => $("cameraInput").click();
    const onCameraChange = async (): Promise<void> => {
      const input = $<HTMLInputElement>("cameraInput");
      const files = [...(input.files ?? [])];
      input.value = "";
      await uploadFiles(files);
    };
    $("emptyCamera").addEventListener("click", onCameraClick);
    $("cameraInput").addEventListener("change", onCameraChange);

    const onKeydown = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape" && moreOpen) {
        closeMore();
        return;
      }
      if (e.key === "Escape" && !$("picker").hidden) {
        closePicker();
        return;
      }
      if ($("lightbox").hidden) {
        if (e.key === "Escape" && selection.isActive() && !selection.isBusy())
          selection.exit();
        return;
      }
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") {
        if (e.key === "Escape") target!.blur();
        return;
      }
      // `viewerKeyAction` owns keys; while editing, ←/→ are refused — stepping remounts and destroys an unwritten crop (§7.4).
      switch (viewerKeyAction(e.key, lightbox.isEditing())) {
        case "cancel-edit":
          lightbox.cancelEdit();
          break;
        case "close":
          lightbox.closeLightbox();
          break;
        case "step-prev":
          lightbox.step(-1);
          break;
        case "step-next":
          lightbox.step(1);
          break;
        case null:
          break;
      }
    };
    const onFocus = (): void => {
      if (lastFreshLoadAt && Date.now() - lastFreshLoadAt < FOCUS_STALE_MS)
        return;
      void refresh();
    };

    window.addEventListener("keydown", onKeydown);
    window.addEventListener("focus", onFocus);
    const stopChange = window.centraid.onChange?.((detail) =>
      store.handleChange(detail)
    );

    // Read off #grid, not #scrollPane, whose clientWidth includes its padding.
    function measurePane(): void {
      const el = $("grid");
      const w =
        el?.clientWidth ||
        (typeof window === "undefined" ? 0 : window.innerWidth);
      if (w > 0 && Math.abs(w - paneWidth) > 1) {
        paneWidth = w;
        renderMain();
      }
    }
    let paneObserver: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined" && $("grid")) {
      paneObserver = new ResizeObserver(measurePane);
      paneObserver.observe($("grid"));
    } else if (typeof window !== "undefined") {
      window.addEventListener("resize", measurePane);
    }

    // Component-width narrow observer (#505 trap 1): width change re-decides which spine draws.
    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 860, (isNarrow: boolean) => {
          narrowRef.current = isNarrow;
          renderNavigation();
          renderMain();
        })
      : () => {};

    renderNavigation();
    renderToolbarRow();
    // Packed --skel grid occupies the photographs' geometry on frame one;
    // placeholder bars guarantee reflow (§14).
    renderMain();
    // Render reachability on frame one, before a read can time out.
    renderOfflineBanner();
    contributeAppBar();
    void store.refreshAll();

    return () => {
      // Fence late-resolving reads before removing listeners, or they mutate detached slots.
      disposed = true;
      store.dispose();
      stopLiveReads();
      // Withdraw every contribution — stale chrome on the next route is theft.
      setStatusSink(null);
      frameRef.current.setAppBar(null);
      frameRef.current.claimBand(null);
      frameRef.current.clearStatus();
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("resize", measurePane);
      selection.dispose();
      stopChange?.();
      stopWidth();
      paneObserver?.disconnect();
    };
    // mount-once boot, stable via refs (#505)
  }, []);

  return (
    // Fill the app pane so inline chrome gets real width (#505 trap 1);
    // the Photos token layer rides this element.
    <div
      ref={setRoot}
      className={styles.appRoot}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <Chrome slots={slots} />
    </div>
  );
}
