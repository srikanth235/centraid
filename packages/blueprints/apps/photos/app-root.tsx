// governance: allow-repo-hygiene file-size-limit — the app's orchestration is one React tree by design (#505). The v4 frame rewrite pulled the shelf model (shelves.ts), the filters (filters.ts), the copy (view-copy.ts), the member preferences (member-prefs.ts) and the frame contribution (frame.tsx) out of it; what is left is the wiring those five modules are wired BY, and splitting it further would split one closure across files.
// Photos — query-free React tree (#505), a ROUTE INSIDE THE FRAME (v4 §3).
//
// PHOTOS DRAWS NO CHROME OF ITS OWN: the app bar, the ONE status line and the
// compact band are the frame's, contributed to through the `frame` prop. Inside
// its pane this renders only the shelf strip, the toolbar row, the grid and the
// overlays — no hamburger, in-pane search field, zoom pair, slideshow or drawer.
//
// MULTI-SCOPE (#599, §H): mounts over N scopes and paints them as ONE timeline.
// `vaultsOn` says which are in it; "shared" is `personal === false` on the
// scope, never a name. Per-scope pages and the merge live in library-store.ts.
// Two projections are NOT merged:
//
//  * ALBUMS, PLACES and TRASH stay OWN-SCOPE — a collection or place id minted
//    in one scope means nothing in another, or worse means something else, since
//    ids collide across scopes by design. Album MEMBERSHIP is therefore computed
//    against own-scope assets only.
//  * The TIMELINE is merged, deduped and horizon-bounded, then filtered by
//    `vaultsOn` and the kind filter.

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
  // A ref keeps the boot closure's read of `frame` live without re-running boot.
  // Seeded at construction, re-synced in an effect, never written during render.
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

  // Seed narrow BEFORE first paint, measuring the real element: inline, the app
  // pane can be narrower than the viewport (#505 trap 1).
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

    // ──── slot roots ────
    const setSlot = (key: SlotKey, node: ReactNode): void => {
      setSlots((prev) => ({ ...prev, [key]: node }));
    };
    const mk = (key: SlotKey) => ({
      render: (node: ReactNode) => setSlot(key, node),
    });
    const shelfStripRoot = mk("shelfStrip");
    // Its own slot because it stands in a different REGION: the strip is a
    // block above the scroll pane, the rail a column beside it (v16).
    const navRailRoot = mk("navRail");
    // Also where the selection bar renders while a selection is active.
    const toolbarRoot = mk("toolbar");
    const bannerRoot = mk("banner");
    const mainRoot = mk("main");
    const selectionBottomBarRoot = mk("selectionBottomBar");
    const lightboxRoot = mk("lightbox");
    const pickerRoot = mk("picker");
    const slideshowRoot = mk("slideshow");
    const permissionRoot = mk("permission");
    const moreSheetRoot = mk("moreSheet");

    // ──── state ────
    let assets: Asset[] = [];
    let albums: Album[] = [];
    let places: Place[] = [];
    let trash: Asset[] = [];
    /** Built-in ids from shelves.ts; an album's own id means album detail. */
    let shelf: ShelfId = null;
    let uploading = false;
    /**
     * A view that knows nothing may not say it is empty (§14). Set once, by the
     * first read that returns without error; a later failure does not un-know
     * what was read — the offline case, where the last good page still renders.
     */
    let loaded = false;
    /** The only reachability evidence this app can observe. */
    let readFailed = false;
    let offlineShown = false;
    let searchQuery = "";
    let searchResults: Asset[] | null = null;
    /** Which of §9's four states the search shelf is in. */
    let searchStatus: SearchStatus = "resting";
    /** One fact per scope that did not answer, named BESIDE the hits other
     *  scopes still have on screen (#726 D10/D11). */
    let searchReachFacts: readonly { label: string; value: string }[] = [];
    /** Is the band's own overflow sheet open (§3.1)? */
    let moreOpen = false;
    /** Session state, NOT the member record (§16). */
    let kind: KindFilter = "all";
    let newAlbumOpen = false;
    let renamingAlbum = false;
    /**
     * The last import with something to EXPLAIN (§11). Null otherwise, including
     * after an all-new run: that said everything on the one status line, and a
     * panel repeating it is a second surface for one outcome. Cleared by the
     * member alone, because these panels are read AFTER the fact.
     */
    let lastImport: ImportResult | null = null;
    // A mode on the People shelf, not a ninth tab: any navigation, the People
    // tab included, returns to the roster.
    let faceReviewOpen = false;
    // Which face to open ON when the member pressed a specific proposal. Null
    // starts at the head of the queue.
    let faceReviewFocusRegionId: string | null = null;
    let paneWidth = gridWidthFallback(
      typeof window === "undefined" ? 1280 : window.innerWidth
    );
    let libraryTruncated = false;
    /** The app bar drops Import while it is: an import that cannot land is not
     *  an offer (§13). */
    let accessDenied = false;
    let lastFreshLoadAt = 0;
    let recordNextLoad = false;

    // The two preferences the handoff puts on the member record (§16); see
    // member-prefs.ts for what is actually true today.
    const prefs = createMemberPrefs(() => {
      renderNavigation();
      renderToolbarRow();
      renderMain();
      contributeAppBar();
    });

    // ──── scopes (issue #599) ────
    const scopesNow = (): InlineScope[] => mountedScopes();
    const ownId = (): string => ownScopeId(scopesNow());
    /** Merged assets restricted to the member's own scope. */
    let ownAssets: Asset[] = [];
    /** The tile's marker derives from this scope's `personal` marker, NEVER
     *  from its label, which the owner may rename (§H). */
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

    // ──── the frame's ONE status line ────
    // Every write outcome announces itself here with Undo where possible. No
    // toast, badge, spinner or red dot (§3, §14). `progress` rides through
    // untouched — a caller that does not know says nothing, which is why this is
    // a passthrough and never a default.
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

    // ──── data ────
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

    /** Repaint from whatever the store now holds. */
    function applyStore(): void {
      if (disposed) return;
      const own = store.own();
      // Consent denial and read failure are OWN-scope outcomes: they are about
      // the library the screen names.
      const denied = own.denied;
      // PERMISSION IS A SCREEN (§13) in its own slot: Chrome HIDES the live
      // region rather than unmounting it, so loaded bytes survive a grant.
      accessDenied = Boolean(denied);
      permissionRoot.render(
        denied ? <PermissionScreen reason={denied.message ?? null} /> : null
      );
      if (denied) {
        contributeAppBar();
        return;
      }
      // A FAILED READ IS NOT A DEAD END (§14): a `return` here would stop the
      // app repainting and leave whatever was on screen standing under one
      // invented sentence. Record the failure, let the banner explain it, and
      // keep rendering everything known from the replica — the store holds each
      // scope's last good page for exactly this.
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
      // A read that came back landed, even if the library is genuinely empty —
      // THAT is when the empty state may speak.
      if (!readFailed) loaded = true;
      // NO Trash → Library redirect (§14): an empty trash has its own words,
      // and landing the member elsewhere answers a question they did not ask.
      // The one shelf that cannot survive a read is a deleted album.
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

    /**
     * Both driven by `libraryReachability`, the honest answer this app can give
     * — the frame contract carries no reachability channel. The frame owns the
     * `--net` dot from the shell's heartbeat, which this app must not restyle.
     */
    function renderOfflineBanner(): void {
      const offline =
        libraryReachability({
          hostStatus: rootElRef.current?.dataset.gatewayStatus,
          readFailed,
        }) === "unreachable";
      bannerRoot.render(
        offline ? <OfflineBanner onRetry={handleRetryRead} /> : null
      );
      // ON THE TRANSITION only: a write outcome shares this line, and
      // re-asserting the offline sentence every repaint would eat it.
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

    /** Any shelf id that is neither built-in nor a tag. */
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

    /**
     * ONE answer serves the bar's Rename and Delete, the tile's Remove and the
     * app bar's primary. Each deriving its own is how a read-only album refuses
     * two writes and offers a third.
     */
    function albumWriteTarget(): WriteTarget {
      return photoWriteTarget("own", null, scopesNow());
    }
    /** A reason is a thing to SAY, so there is no empty-string state. */
    function albumRefusalReason(): string | undefined {
      const target = albumWriteTarget();
      return target.disabled ? target.reason : undefined;
    }
    /** The SHELL's label, renameable by its owner, never a storage noun (#599). */
    function ownScopeLabel(): string {
      const own = ownId();
      return scopesNow().find((scope) => scope.id === own)?.label ?? "Library";
    }

    /**
     * The read-only surface's primary: a client-side save through the SAME batch
     * path the selection bar uses, writing nothing anywhere.
     *
     * The progress ref is null on purpose — `runBatchDownload` writes its count
     * into the selection bar's busy element, which this surface has not got. The
     * outcome still lands on the one status line; only the intermediate count is
     * missing, and a determinate app-bar counter is not a contribution this app
     * can make today.
     */
    const handleDownloadAll = (): void => {
      const shown = visibleAssets();
      void runBatchDownload(
        shown.map((asset) => assetKey(asset)),
        shown,
        { current: null },
        { setBarBusy: () => {} }
      );
    };

    /** The explicit, post-write and window-focus path. */
    async function refresh(): Promise<void> {
      await store.refreshAll();
    }

    function albumAssets(): Asset[] {
      if (!shelf) return assets;
      // Favorites and tags travel with the row, so they read the merged list.
      // Album membership is an ID match against an own-scope collection, so it
      // reads own-scope assets only — ids collide across scopes.
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
      // One flat list in section order, so the lightbox steps through it as
      // drawn — a different order would be a second answer to "what is next?".
      // Places, like albums, are an own-scope fact.
      if (shelf === PLACES) return sections().flatMap((s) => s.assets);
      // One person's sub-state: the same timeline under a filter (§5).
      const personId = personIdFrom(shelf);
      if (personId) return people.assetsFor(personId, ownAssets);
      return ownAssets.filter((a) => a.album_ids?.includes(shelf!));
    }

    /** Own-scope, for the same reason albums are. */
    function sections(): ReturnType<typeof placeSections> {
      // The shelf as it is DRAWN (#816), so search and the lightbox's walk
      // order read the same list the member is looking at.
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

    // ──── memories (§4.6) ────
    function memories(): MemoryCard[] {
      if (rootElRef.current?.dataset.showMemories === "hide") return [];
      return buildMemories({
        ownAssets,
        memories: store.own().memories,
        memoryMembers: store.own().memoryMembers,
        onOpen: (id) => navigateTo(id),
      });
    }

    // ──── navigation ────
    function navigateTo(id: ShelfId): void {
      // The strip is the way back OUT of the review, which has no Back control:
      // re-selecting Duplicates returns to the cluster list.
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
      // Navigating IS the dismissal: a sheet open over the destination it just
      // reached would be a second navigation.
      if (moreOpen) closeMore();
      // Cleared only when the route leaves Photos (§16); within Photos it
      // survives a shelf change (§6).
      renderNavigation();
      renderToolbarRow();
      renderMain();
      contributeAppBar();
    }

    /** A pure re-projection of data already held: no scope is re-read. */
    function toggleVault(scopeId: string): void {
      const current = prefs.read().vaultsOn;
      const every = scopesNow().map((scope) => scope.id);
      // The resting state is "every one", held as an EMPTY set, so the first
      // toggle materialises the full set and removes one — never isolates one.
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

    // ──── the frame's app bar (§3) ────
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
      // A READ-ONLY SURFACE SWAPS THE PRIMARY, IT DOES NOT LOSE IT: Import is
      // not merely disabled, and what replaces it is what the grant allows.
      const readOnlyAlbum = Boolean(album) && albumWriteTarget().disabled;
      // On the phone `Select all`/`Select none` stays in the head with the
      // count and Done; only the five actions move to the bottom bar (§6, §15).
      // Desktop/PWA carry Select all inside the bar itself.
      const phoneSelectHead =
        narrowRef.current && selection.isActive()
          ? {
              onToggleAll: selection.toggleAll,
              selectedCount: selection.keys.size,
            }
          : {};
      const contribution = appBar({
        // The position ("cluster 2 of 6") is NOT put here: the frame's count
        // contract is `{count, unit}` and cannot express it, so the review draws
        // it in its own section head.
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
        // ONE FILLED INK ELEMENT PER VIEW (§18): the empty block's own filled
        // Import is where the member is looking, so the bar stands down. An
        // offer that cannot land, or is already on screen, is not an offer.
        showImport:
          !accessDenied &&
          !readOnlyAlbum &&
          !emptyBlockOffersImport() &&
          shelf !== TRASH &&
          shelf !== DUPLICATES &&
          shelf !== STORAGE &&
          // No app-bar primary on Search (§9): the shelf's own field is where
          // the member is looking.
          shelf !== SEARCH,
        // Inside an album the natural "add" is from the library, not disk. This
        // is the ONLY route to the picker in a NON-EMPTY album — its other entry
        // is in the empty block, hidden the moment the album has a photograph.
        onImport: () => (album ? openPicker() : $("fileInput").click()),
        // The compact band already claims a Search destination, so the bar's
        // control is dropped there (§9).
        compact: narrowRef.current,
        onSearch: () => navigateTo(SEARCH),
        ...(target.disabled ? { importDisabledReason: target.reason } : {}),
        ...phoneSelectHead,
      });
      frameRef.current.setAppBar(
        readOnlyAlbum
          ? {
              ...contribution,
              // COMPOSED onto the frame's action set, never a second bar, and
              // LAST, which is where the primary lives.
              actions: (
                <>
                  {contribution.actions}
                  <button
                    type="button"
                    className="kit-btn primary"
                    // Help on an ENABLED control, not a refusal hidden in a
                    // tooltip. Named by the scope's label, never a storage
                    // noun (#599).
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
                // Offered only once `count()` has answered positively, so it
                // never fires into an empty queue.
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
      // Claimed unconditionally: the frame honours it only for a first-party
      // app on the compact form factor (§3.1).
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
      // Known once the shelf's own load lands; `count()` carries the same "not
      // yet answered" `null` every lazy shelf's count does.
      if (shelf === DUPLICATES) return duplicates.count();
      if (shelf === STORAGE) return null;
      if (shelf === SEARCH) return searchResults?.length ?? null;
      return visibleAssets().length;
    }

    // ──── the app's own navigation: the rail (v16) or the strip (§5) ────
    // ONE FUNCTION FOR ONE QUESTION: rail and strip are the same spine on two
    // axes, so they re-render together and can never disagree about the answer
    // or about which seat carries it.
    function renderNavigation(): void {
      renderNavRail();
      renderShelfStrip();
    }

    /**
     * A POINTER SEAT ONLY, and both halves are read: `narrow` is this app's pane,
     * `compact` the SHELL's form factor, and a rail drawn on either would be a
     * column with no room — the strip withdrawn behind it (v16 §4).
     */
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
      // The frame carries the shelves on the band's seat, the column on the
      // rail's; the strip is what is left. `navSeat` answers all three at once,
      // so no seat ends up with two navigations or none (v16).
      if (
        navSeat({ narrow: narrowRef.current, compact: compactRef.current }) !==
        "strip"
      ) {
        shelfStripRoot.render(null);
        return;
      }
      // No strip on Search (§9): it reads as its own page, not the timeline
      // under a filter — the field and its states are the whole surface.
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

    /**
     * ONE map, read by the More sheet and the rail: a count that disagrees with
     * its shelf header is a defect (v16 §3). Every entry is the same expression
     * `countFor` uses, so the rail's number is the app bar's number.
     *
     * A shelf whose count is NOT KNOWN YET omits its entry rather than
     * contributing a zero — People and Duplicates answer `null` until their lazy
     * reads land, and printing 0 would report a shelf never read.
     */
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

    // ──── the Photos toolbar row (§3) ────
    // Renders only when it carries something, so an empty row is never laid out.
    function renderToolbarRow(): void {
      applyUploadTarget();
      if (selection.isActive()) {
        // `#toolbarMount` becomes the selection bar while a selection is
        // active, and selection.tsx owns writing to it then — stay out of its
        // way rather than racing it with a `null` write.
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

    // ──── main content ────
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
        // The People shelf in a different mode (§8). FaceReview is
        // self-contained: it fetches its queue and fires its own writes.
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
        // The gate is the empty body only while there is nothing to browse: a
        // roster with proposal cards has content the gate would hide (#712).
        const rosterEmpty =
          roster !== null && roster.length === 0 && proposalRoster.length === 0;
        if (rosterEmpty) enrichGate.ensurePolicyLoaded();
        const gateProps = rosterEmpty
          ? enrichGate.props(ownAssets.length)
          : null;
        // A roster that has not answered is not an empty roster. The gate draws
        // its own explanation, so the generic empty block is suppressed while it
        // shows — as for Search, Duplicates and Storage.
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
      // `shown` is `[]` while in flight, and handing that to the empty state
      // tells a member with thousands of photographs their library is empty.
      // `--skel` at the packed geometry means nothing reflows on arrival.
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

    /**
     * ONE slot, several claimants, in order of urgency (§4.6, §5, §11):
     *  1. The import panels, when the last run had something to explain — they
     *     are about what the member just did, so they lead, and they ride ANY
     *     shelf.
     *  2. The shelf's own head: Trash's note or the memories strip. Mutually
     *     exclusive by shelf, so they share the slot.
     *
     * Memories are the Library shelf's alone and only at rungs XS-M: at L the
     * cards and the first tile row are the same size and the head stops reading
     * as a head.
     */
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

    /**
     * Every shelf that packs tiles renders the SAME grid under a different
     * filter (§5), so its props live in one place: two call sites drifting apart
     * is how a shelf quietly stops honouring the tile size or the selection.
     */
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
          // A real column on desktop/PWA, so the packer's budget is the pane
          // minus it; on the phone it overlays and the grid keeps every pixel.
          containerWidth={paneWidth - (phone ? 0 : RAIL_WIDTH)}
          targetHeight={rungHeight(rung, phone ? "phone" : "desktop")}
          rung={rung}
          phone={phone}
          memories={extra.memories ?? null}
          inAlbum={Boolean(album)}
          albumId={album ? album.album_id : null}
          // Gated by the SAME answer as the album bar's Rename and Delete;
          // `inAlbum` alone would refuse two writes and offer a third.
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

    /** The ONE place that decides whether this app may say a view is empty. */
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
        // Compact only (§15): a desktop browser would open a file picker
        // wearing a camera's name.
        phone: narrowRef.current,
        ...extra,
      });
    }

    /** The nodes are imperative and long-lived: upload.ts bound `#emptyUpload`
     *  at boot, so they are never unmounted. */
    function applyEmptyState(view: EmptyStateView): void {
      $("empty").hidden = !view.visible;
      if (!view.visible) return;
      $("emptyText").textContent = view.title;
      $("emptyBody").textContent = view.body;
      $("emptyUpload").hidden = !view.offersImport;
      $("emptyCamera").hidden = !view.offersCamera;
    }

    /** Read off what is on screen, never re-derived: "one filled ink element
     *  per view" (§18) is a claim about the RENDERED view, and two derivations
     *  could disagree. `renderMain` always runs before `contributeAppBar`. */
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

    // ──── search (a shelf, §9) ────
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
      // `searching` is DETERMINATE, never a spinner (§14): the local match over
      // the loaded window is on screen, and the shelf says so with its count.
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

    // ──── the band's overflow sheet (§3.1) ────
    // Dismisses on Esc, on Close and on navigating — never by itself, and never
    // over a destination it just reached.
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
      // WHAT THE TRASH HELD BEFORE THE RUN, snapshotted NOW. Re-uploading a
      // deleted photograph's bytes restores it, reported with the same
      // `deduped: 1` as an ordinary dedupe, so the only way to tell them apart
      // is to have known a moment ago. `runUpload` refreshes before it returns,
      // by which point the evidence is gone.
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

    // selection.tsx owns the mode, keys, busy latch and bar; this closure only
    // tells it when the data moved.
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

    // The face-detection consent gate lives in the People shelf's own empty
    // state (#712) — see enrichment-gate.ts.
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

    // Its OWN input: `capture` on the shared one would take the file picker
    // away from the desktop (§14, §15).
    const onCameraClick = (): void => $("cameraInput").click();
    const onCameraChange = async (): Promise<void> => {
      const input = $<HTMLInputElement>("cameraInput");
      const files = [...(input.files ?? [])];
      input.value = "";
      await uploadFiles(files);
    };
    $("emptyCamera").addEventListener("click", onCameraClick);
    $("cameraInput").addEventListener("change", onCameraChange);

    // ──── global wiring ────
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
      // ONE pure place decides what a key means over an open lightbox
      // (`viewerKeyAction`), including the refusal that matters: while the editor
      // is up ←/→ mean nothing, because stepping remounts it and destroys an
      // unwritten crop and rotation (§7.4).
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

    // Component-width narrow observer (#505 trap 1): strip and band are two
    // views of one navigation, so a width change re-decides which is drawn.
    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 860, (isNarrow: boolean) => {
          narrowRef.current = isNarrow;
          renderNavigation();
          renderMain();
        })
      : () => {};

    // ──── first paint ────
    renderNavigation();
    renderToolbarRow();
    // The packed `--skel` grid occupies the photographs' own geometry on the
    // first frame, so nothing reflows when the read lands. A stack of
    // placeholder bars is the wrong shape and guarantees that reflow (§14).
    renderMain();
    // The host may already know the gateway is unreachable, so the member reads
    // why on the first frame rather than after a read times out.
    renderOfflineBanner();
    contributeAppBar();
    void store.refreshAll();

    return () => {
      // A read may resolve after React removes Chrome's DOM: fence its
      // continuation before removing listeners, or it mutates detached slots.
      disposed = true;
      store.dispose();
      stopLiveReads();
      // Withdraw every contribution: a stale Photos title on the next route
      // would be this app drawing chrome it no longer owns.
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
    // Fill the app pane so the inline chrome gets real width (#505 trap 1);
    // the Photos token layer rides this same element.
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
