// governance: allow-repo-hygiene file-size-limit — the app's orchestration is one React tree by design (#505); splitting it further would split one closure across files.

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
import { MoreSheet } from "../_shared/MoreSheet.tsx";
import type { MoreSheetRow } from "../_shared/MoreSheet.tsx";
import { navSeat } from "../_shared/nav-seat.ts";
import { NavRail } from "../_shared/NavRail.tsx";
import {
  mountedScopes,
  ownScopeId,
  photoWriteTarget,
} from "../_shared/scope-kit.ts";
import { ShelfStrip } from "../_shared/ShelfStrip.tsx";
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
import { OfflineBanner } from "./components/OfflineBanner.tsx";
import { PeopleShelf } from "./components/People.tsx";
import { PermissionScreen } from "./components/Permission.tsx";
import {
  PlacesShelf,
  placeSectionsWithNoLocation,
} from "./components/Places.tsx";
import type { placeSections } from "./components/Places.tsx";
import { SearchShelf } from "./components/SearchShelf.tsx";
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
import { stopMediaObservation } from "./media-observer.ts";
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
  MORE_DESTINATIONS,
  PEOPLE,
  personIdFrom,
  personShelf,
  PLACES,
  SEARCH,
  shelfFromSegment,
  shelfKindFor,
  SHELVES,
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
    let shelf: ShelfId = null;
    let uploading = false;
    let loaded = false;
    let readFailed = false;
    let offlineShown = false;
    let searchQuery = "";
    let searchInput: HTMLInputElement | null = null;
    let searchResults: Asset[] | null = null;
    let searchStatus: SearchStatus = "resting";
    let searchReachFacts: readonly { label: string; value: string }[] = [];
    let moreOpen = false;
    let kind: KindFilter = "all";
    let newAlbumOpen = false;
    let renamingAlbum = false;
    let lastImport: ImportResult | null = null;
    let faceReviewOpen = false;
    let faceReviewFocusRegionId: string | null = null;
    let paneWidth = gridWidthFallback(
      typeof window === "undefined" ? 1280 : window.innerWidth
    );
    let libraryTruncated = false;
    let accessDenied = false;
    let lastFreshLoadAt = 0;
    let recordNextLoad = false;

    const prefs = createMemberPrefs(() => {
      renderNavigation();
      renderToolbarRow();
      renderMain();
      contributeAppBar();
    });

    const scopesNow = (): InlineScope[] => mountedScopes();
    const ownId = (): string => ownScopeId(scopesNow());
    let ownAssets: Asset[] = [];
    const vaultOf = (
      scopeId: string | null | undefined
    ): InlineScope | undefined =>
      scopesNow().find((scope) => scope.id === (scopeId ?? ""));
    setWriteTargetResolver((kindOfWrite) =>
      photoWriteTarget(
        kindOfWrite,
        writeScopeFor(prefs.read().vaultsOn),
        scopesNow()
      )
    );

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
      const denied = own.denied;
      accessDenied = Boolean(denied);
      permissionRoot.render(
        denied ? <PermissionScreen reason={denied.message ?? null} /> : null
      );
      if (denied) {
        contributeAppBar();
        return;
      }
      readFailed = Boolean(own.error);
      renderOfflineBanner();
      const view = store.merged();
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
      if (!readFailed) loaded = true;
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

    function renderOfflineBanner(): void {
      const offline =
        libraryReachability({
          hostStatus: rootElRef.current?.dataset.gatewayStatus,
          readFailed,
        }) === "unreachable";
      bannerRoot.render(
        offline ? <OfflineBanner onRetry={handleRetryRead} /> : null
      );
      if (offline && !offlineShown) {
        notice(OFFLINE_COPY.status);
        offlineShown = true;
      } else if (!offline && offlineShown) {
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

    function albumWriteTarget(): WriteTarget {
      return photoWriteTarget("own", null, scopesNow());
    }
    function albumRefusalReason(): string | undefined {
      const target = albumWriteTarget();
      return target.disabled ? target.reason : undefined;
    }
    function ownScopeLabel(): string {
      const own = ownId();
      return scopesNow().find((scope) => scope.id === own)?.label ?? "Library";
    }

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
      if (shelf === PLACES) return sections().flatMap((s) => s.assets);
      const personId = personIdFrom(shelf);
      if (personId) return people.assetsFor(personId, ownAssets);
      return ownAssets.filter((a) => a.album_ids?.includes(shelf!));
    }

    function sections(): ReturnType<typeof placeSections> {
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
      if (shelf === DUPLICATES) {
        if (id === DUPLICATES) duplicates.exitReview();
        else duplicates.invalidate();
      }
      shelf = id;
      newAlbumOpen = false;
      renamingAlbum = false;
      faceReviewOpen = false;
      faceReviewFocusRegionId = null;
      if (moreOpen) closeMore();
      renderNavigation();
      renderToolbarRow();
      renderMain();
      contributeAppBar();
    }

    function toggleVault(scopeId: string): void {
      const current = prefs.read().vaultsOn;
      const every = scopesNow().map((scope) => scope.id);
      const base = current.size === 0 ? new Set(every) : new Set(current);
      if (base.has(scopeId)) base.delete(scopeId);
      else base.add(scopeId);
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
      const readOnlyAlbum = Boolean(album) && albumWriteTarget().disabled;
      const phoneSelectHead =
        narrowRef.current && selection.isActive()
          ? {
              onToggleAll: selection.toggleAll,
              selectedCount: selection.keys.size,
            }
          : {};
      const contribution = appBar({
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
        showImport:
          !accessDenied &&
          !readOnlyAlbum &&
          !emptyBlockOffersImport() &&
          shelf !== TRASH &&
          shelf !== DUPLICATES &&
          shelf !== STORAGE &&
          shelf !== SEARCH,
        onImport: () => (album ? openPicker() : $("fileInput").click()),
        compact: narrowRef.current,
        onSearch: () => navigateTo(SEARCH),
        ...(target.disabled ? { importDisabledReason: target.reason } : {}),
        ...phoneSelectHead,
      });
      frameRef.current.setAppBar(
        readOnlyAlbum
          ? {
              ...contribution,
              actions: (
                <>
                  {contribution.actions}
                  <button
                    type="button"
                    className="kit-btn primary"
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
      frameRef.current.claimBand(
        bandClaim(
          shelf,
          (segment) => navigateTo(shelfFromSegment(segment)),
          openMore
        )
      );
    }

    function countFor(): number | null {
      if (shelf === ALBUMS) return albums.length;
      if (shelf === PLACES) return sections().length;
      if (shelf === PEOPLE) return people.list()?.length ?? null;
      if (shelf === DUPLICATES) return duplicates.count();
      if (shelf === STORAGE) return null;
      if (shelf === SEARCH) return searchResults?.length ?? null;
      return visibleAssets().length;
    }

    function renderNavigation(): void {
      renderNavRail();
      renderShelfStrip();
    }

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
        shelfStripRoot.render(
          <AlbumBar
            albumId={album.album_id}
            title={album.title ?? "Album"}
            renaming={renamingAlbum}
            canWrite={!albumWriteTarget().disabled}
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
      if (
        navSeat({ narrow: narrowRef.current, compact: compactRef.current }) !==
        "strip"
      ) {
        shelfStripRoot.render(null);
        return;
      }
      if (shelf === SEARCH) {
        shelfStripRoot.render(null);
        return;
      }
      shelfStripRoot.render(
        <ShelfStrip
          shelves={SHELVES}
          current={shelf}
          narrow={narrowRef.current}
          onSelect={navigateTo}
        />
      );
    }

    function shelfCounts(): ReadonlyMap<string, number> {
      const counts = new Map<string, number>([
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

    function renderToolbarRow(): void {
      applyUploadTarget();
      if (selection.isActive()) {
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
        void people.ensureLoaded();
        const roster = people.list();
        const proposalRoster = people.proposalList() ?? [];
        const rosterEmpty =
          roster !== null && roster.length === 0 && proposalRoster.length === 0;
        if (rosterEmpty) enrichGate.ensurePolicyLoaded();
        const gateProps = rosterEmpty
          ? enrichGate.props(ownAssets.length)
          : null;
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
      const handleEnterSelect = selection.enter;
      const handleToggleSelect = selection.toggle;
      const handlePinchRung = (delta: number): void => {
        prefs.write({ tileSize: stepTileSize(prefs.read().tileSize, delta) });
      };
      return (
        <TimelineBody
          assets={shown}
          containerWidth={paneWidth - (phone ? 0 : RAIL_WIDTH)}
          targetHeight={rungHeight(rung, phone ? "phone" : "desktop")}
          rung={rung}
          phone={phone}
          memories={extra.memories ?? null}
          inAlbum={Boolean(album)}
          albumId={album ? album.album_id : null}
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
        phone: narrowRef.current,
        ...extra,
      });
    }

    function applyEmptyState(view: EmptyStateView): void {
      $("empty").hidden = !view.visible;
      if (!view.visible) return;
      $("emptyText").textContent = view.title;
      $("emptyBody").textContent = view.body;
      $("emptyUpload").hidden = !view.offersImport;
      $("emptyCamera").hidden = !view.offersCamera;
    }

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

    function renderPlacesShelf(
      grouped: ReturnType<typeof placeSections>
    ): void {
      const phone = narrowRef.current;
      const rung = prefs.read().tileSize;
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

    function renderStorage(): void {
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
          inputRef={(el) => {
            searchInput = el;
          }}
        >
          {timeline(hits, {
            truncated: false,
            handleShowMore: async () => {},
          })}
        </SearchShelf>
      );
    }

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
      searchStatus = searchQuery === "" ? "resting" : "searching";
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
      if (searchInput) searchInput.value = "";
      renderMain();
      contributeAppBar();
    }

    function moreSheetRows(): readonly MoreSheetRow[] {
      const counts = shelfCounts();
      return MORE_DESTINATIONS.map((destination) => {
        const count =
          destination.id === null ? undefined : counts.get(destination.id);
        return {
          key: destination.segment,
          label: destination.label,
          ...(count === undefined ? {} : { meta: String(count) }),
          ...(destination.id === shelf ? { current: true } : {}),
          select: () => navigateTo(destination.id),
        };
      });
    }

    function renderMoreSheet(): void {
      moreSheetRoot.render(
        moreOpen ? (
          <MoreSheet
            label="More in Photos"
            rows={moreSheetRows()}
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

    async function uploadFiles(files: File[]): Promise<void> {
      if (uploading || files.length === 0) return;
      const trashedBefore = new Set(trash.map((asset) => asset.asset_id));
      const result = await runUpload(files, {
        refresh,
        setUploading: (v) => {
          uploading = v;
        },
        wasTrashed: (assetId) => trashedBefore.has(assetId),
      });
      lastImport = result.deduped + result.restored > 0 ? result : null;
      renderMain();
    }

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

    const people = createPeople({
      onData: () => {
        if (disposed) return;
        renderMain();
        contributeAppBar();
      },
    });

    const enrichGate = createEnrichmentGate({
      onData: () => {
        if (disposed) return;
        renderMain();
      },
    });

    const custody = createCustody({
      onData: () => {
        if (disposed) return;
        renderMain();
      },
    });

    const duplicates = createDuplicates({
      gridRoot: mainRoot,
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

    const stopUpload = wireUpload({
      uploadFiles,
      isAlbumSelected: () => Boolean(currentAlbum()),
      openPicker,
    });

    const onCameraClick = (): void => $("cameraInput").click();
    const onCameraChange = async (): Promise<void> => {
      const input = $<HTMLInputElement>("cameraInput");
      const files = [...(input.files ?? [])];
      input.value = "";
      await uploadFiles(files);
    };
    const emptyCamera = $("emptyCamera");
    const cameraInput = $("cameraInput");
    emptyCamera.addEventListener("click", onCameraClick);
    cameraInput.addEventListener("change", onCameraChange);

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

    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 860, (isNarrow: boolean) => {
          narrowRef.current = isNarrow;
          renderNavigation();
          renderMain();
        })
      : () => {};

    renderNavigation();
    renderToolbarRow();
    renderMain();
    renderOfflineBanner();
    contributeAppBar();
    void store.refreshAll();

    return () => {
      disposed = true;
      store.dispose();
      stopLiveReads();
      setStatusSink(null);
      frameRef.current.setAppBar(null);
      frameRef.current.claimBand(null);
      frameRef.current.clearStatus();
      window.removeEventListener("keydown", onKeydown);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("resize", measurePane);
      emptyCamera.removeEventListener("click", onCameraClick);
      cameraInput.removeEventListener("change", onCameraChange);
      stopUpload();
      stopMediaObservation();
      selection.dispose();
      stopChange?.();
      stopWidth();
      paneObserver?.disconnect();
    };
  }, []);

  return (
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
