// governance: allow-repo-hygiene file-size-limit — the app's orchestration is one React tree by design (#505). The v4 frame rewrite pulled the shelf model (shelves.ts), the filters (filters.ts), the copy (view-copy.ts), the member preferences (member-prefs.ts) and the frame contribution (frame.tsx) out of it; what is left is the wiring those five modules are wired BY, and splitting it further would split one closure across files.
// Photos — query-free React tree (issue #505), as a ROUTE INSIDE THE FRAME
// (v4 handoff §3). Holds the `Root` component and the orchestration that does
// NOT depend on the node-side `./queries/*` handler modules.
//
// PHOTOS DRAWS NO CHROME OF ITS OWN. The app bar, the ONE status line and the
// compact bottom band are the frame's; this module contributes to all three
// through the `frame` prop and renders, inside its pane, only the shelf strip,
// the toolbar row, the grid and the overlay regions. The hamburger, the
// in-pane search field, the zoom pair, the slideshow button and the drawer
// retired with the header that carried them.
//
// MULTI-SCOPE (issue #599, v4 §H). This app mounts over N scopes at once — the
// member's own vault, the shared one the account was founded with, and every
// household audience — and paints them as ONE timeline. Which scopes are IN
// that timeline is `vaultsOn`; whether a photograph is marked as shared is
// `personal === false` on its scope, never a name (filters.ts). The per-scope pages and the merge live in library-store.ts.
// Two projections are NOT merged:
//
//  * ALBUMS, PLACES and TRASH stay OWN-SCOPE. A collection id, a place id and
//    a trash shelf are per-scope facts: an album id minted in one scope means
//    nothing in another — or, worse, means something else, since ids collide
//    across scopes by design. Album MEMBERSHIP is therefore computed against
//    own-scope assets only.
//  * The TIMELINE is merged, deduped and horizon-bounded
//    (apps/_shared/scope-merge.ts), then filtered by `vaultsOn` and by the
//    kind filter.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { FC, ReactElement, ReactNode } from "react";

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
import { PlacesShelf, placeSections } from "./components/Places.tsx";
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
import { appBar, bandClaim, publishOutcome } from "./frame.tsx";
import { debounce, observeWidth } from "./kit.ts";
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

// The vault tables the library projection reads — the change-subscription
// filter AND the onChange refetch gate (issue #404).
export const PHOTOS_READ_TABLES_LIST = [
  "media.media_asset",
  "core.content_item",
  "core.collection",
  "core.collection_entry",
  "core.place",
  "core.concept_scheme",
  "core.concept",
  "core.tag",
  "blob.custody_state",
  // The Storage screen's whole-library rollup (issue #711) — a sweep rewrites
  // it, and this app should repaint when it does.
  "blob.custody_rollup",
];
const PHOTOS_READ_TABLES = new Set<string>(PHOTOS_READ_TABLES_LIST);
const FOCUS_STALE_MS = 30_000;

// The genuine <kit-skeleton> custom element as ordinary JSX (pilot pattern —
// the runtime value stays the string, so the emitted DOM is identical).
const KitSkeleton = "kit-skeleton" as unknown as FC<{ rows?: number }>;

type SlotKey = keyof ChromeSlots;

export function Root({ rootRef, frame }: InlineAppProps): ReactElement {
  const [narrow, setNarrow] = useState(false);
  const rootElRef = useRef<HTMLDivElement | null>(null);
  // The frame handle is read from inside the mount-once boot closure. A ref
  // keeps that read live without re-running the boot when the host re-renders;
  // it is seeded at construction and re-synced in an effect, never written
  // during render.
  const frameRef = useRef(frame);
  const narrowRef = useRef(false);
  const [slots, setSlots] = useState<ChromeSlots>({
    shelfStrip: null,
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

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
    },
    [rootRef]
  );

  // Seed the narrow layout BEFORE the first paint: inline, the app pane can be
  // narrower than the viewport, so measure the real element (#505 trap 1).
  useLayoutEffect(() => {
    const el = rootElRef.current;
    if (el) {
      const forced = el.dataset.appWidth === "narrow";
      const isNarrow = forced || el.clientWidth < 860;
      narrowRef.current = isNarrow;
      setNarrow(isNarrow);
    }
  }, []);

  useEffect(() => {
    let disposed = false;

    // ---- slot roots ----
    const setSlot = (key: SlotKey, node: ReactNode): void => {
      setSlots((prev) => ({ ...prev, [key]: node }));
    };
    const mk = (key: SlotKey) => ({
      render: (node: ReactNode) => setSlot(key, node),
    });
    const shelfStripRoot = mk("shelfStrip");
    // The toolbar row's mount — also where the selection bar renders while a
    // selection is active (v4 §6 close-out, selection.tsx's header).
    const toolbarRoot = mk("toolbar");
    const bannerRoot = mk("banner");
    const mainRoot = mk("main");
    const selectionBottomBarRoot = mk("selectionBottomBar");
    const lightboxRoot = mk("lightbox");
    const pickerRoot = mk("picker");
    const slideshowRoot = mk("slideshow");
    const permissionRoot = mk("permission");
    const moreSheetRoot = mk("moreSheet");

    // ---- state ----
    let assets: Asset[] = [];
    let albums: Album[] = [];
    let places: Place[] = [];
    let trash: Asset[] = [];
    /** The current shelf (v4 §16 `shelf`). Built-in ids come from shelves.ts;
     *  an album's own id means album detail. */
    let shelf: ShelfId = null;
    let uploading = false;
    /**
     * A read has LANDED (§14). Until it has, this app knows nothing about the
     * library — and a view that knows nothing may not say it is empty. Set
     * once, by the first read that comes back without an error; a later
     * failure does not un-know what was already read, which is exactly the
     * offline case (the last good page still renders, and the banner explains
     * why it is not growing).
     */
    let loaded = false;
    /** Did the most recent read of the member's OWN scope come back failed?
     *  The only reachability evidence this app can actually observe — see
     *  `libraryReachability` (view-state.ts). */
    let readFailed = false;
    let offlineShown = false;
    let searchQuery = "";
    let searchResults: Asset[] | null = null;
    /** Which of §9's four states the search shelf is in (search.ts). */
    let searchStatus: SearchStatus = "resting";
    /** Per-scope reach for the current answer (issue #726 D10/D11) — one
     *  `{label, value}` fact per mounted scope that did not answer, named
     *  BESIDE whatever other scopes' hits are still on screen. */
    let searchReachFacts: readonly { label: string; value: string }[] = [];
    /** Is the band's own overflow sheet open (§3.1)? */
    let moreOpen = false;
    /** The kind filter (v4 §16 — session, not the member record). */
    let kind: KindFilter = "all";
    let newAlbumOpen = false;
    let renamingAlbum = false;
    /**
     * The last import that had something to EXPLAIN (§11) — a dedupe, a
     * restore, or both. Null the rest of the time, including after a run where
     * every file was new: that run said everything it had to say on the one
     * status line, and a panel repeating it would be a second surface for one
     * outcome. Cleared by the member (`Dismiss`) and by nothing else, because
     * the two panels are read AFTER the fact.
     */
    let lastImport: ImportResult | null = null;
    // The face-review queue rides the People shelf as a mode, not a ninth
    // tab: the shelf's own pending note opens it, and any navigation — the
    // People tab included — returns to the roster. See navigateTo.
    let faceReviewOpen = false;
    // Which face the review should open ON, when the member arrived by pressing
    // a specific unnamed proposal rather than the shelf's own Review control.
    // Null means "start at the head of the queue".
    let faceReviewFocusRegionId: string | null = null;
    let paneWidth = gridWidthFallback(
      typeof window === "undefined" ? 1280 : window.innerWidth
    );
    let libraryTruncated = false;
    /** Is the member's own library out of reach right now (§13)? The app bar
     *  drops Import while it is: an import that cannot land is not an offer. */
    let accessDenied = false;
    let lastFreshLoadAt = 0;
    let recordNextLoad = false;

    // `tileSize`, `vaultsOn` and `bandOwner` — the three preferences the
    // handoff puts on the member record (§16). See member-prefs.ts for what is
    // and is not true about that today.
    const prefs = createMemberPrefs(() => {
      renderShelfStrip();
      renderToolbarRow();
      renderMain();
      contributeAppBar();
    });

    // ---- scopes (issue #599) ----
    const scopesNow = (): InlineScope[] => mountedScopes();
    const ownId = (): string => ownScopeId(scopesNow());
    /** Merged assets restricted to the member's own scope — see the header. */
    let ownAssets: Asset[] = [];
    /**
     * The mounted vault a tile is shown FROM. The tile's marker is derived
     * from this scope's `personal` marker (tile-state.ts `vaultMarker`) — any
     * scope but the member's own — never from its label, which the owner is
     * free to rename (§H).
     */
    const vaultOf = (
      scopeId: string | null | undefined
    ): InlineScope | undefined =>
      scopesNow().find((scope) => scope.id === (scopeId ?? ""));
    // Where a CREATING write lands. One vault switched on is an unambiguous
    // target; "all", or several, falls back to the member's own.
    setWriteTargetResolver((kindOfWrite) =>
      photoWriteTarget(
        kindOfWrite,
        writeScopeFor(prefs.read().vaultsOn),
        scopesNow()
      )
    );

    // ---- the frame's ONE status line ----
    // Every write outcome announces itself there, with Undo where undo is
    // possible. No toast, no badge, no spinner, no red dot (§3, §14).
    // `progress` rides through untouched: a long local operation says how far
    // it has got with EXACT counts on this same line, and the frame draws the
    // determinate meter. A caller that does not know says nothing, which is
    // why this is a passthrough and never a default (§14).
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

    // ---- data ----
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
      // A consent denial and a read failure are OWN-scope outcomes: they are
      // about the member's own library, which is the thing the screen names.
      const denied = own.denied;
      // PERMISSION IS A SCREEN (§13), rendered into its own slot — Chrome hides
      // the live region behind it rather than unmounting it, so every tile's
      // already loaded bytes survive a grant coming back.
      accessDenied = Boolean(denied);
      permissionRoot.render(
        denied ? <PermissionScreen reason={denied.message ?? null} /> : null
      );
      if (denied) {
        contributeAppBar();
        return;
      }
      // A FAILED READ IS NOT A DEAD END (§14). It used to `return` here, which
      // meant the app stopped repainting entirely and left whatever was on
      // screen — including, on a first read, the empty state — standing under
      // one invented sentence. Now the failure is recorded, the banner
      // explains it in the product's own words, and everything that IS known
      // keeps rendering from the replica: months, days, counts, captions,
      // albums, people. The store keeps each scope's last good page for
      // exactly this (library-store.ts `apply`).
      readFailed = Boolean(own.error);
      renderOfflineBanner();
      const view = store.merged();
      // `MergedRow<MergeableAsset>` and `Asset` describe the same query row
      // from two sides — see the same cast's note in library-store.ts.
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
      // A read that came back is a read that landed, even if the library it
      // describes is genuinely empty — THAT is when the empty state may speak.
      if (!readFailed) loaded = true;
      // The Trash → Library redirect that used to live here is GONE (§14). An
      // empty trash is a state with its own words ("Trash is empty."), and
      // silently landing the member on a different shelf answered a question
      // they did not ask. The one shelf that cannot survive a read is a
      // deleted album — see `shelfAfterRead`.
      shelf = shelfAfterRead(
        shelf,
        albums.map((album) => album.album_id)
      );
      selection.prune(assets);
      if (recordNextLoad) lastFreshLoadAt = Date.now();
      recordNextLoad = true;
      renderShelfStrip();
      renderToolbarRow();
      renderMain();
      selection.renderBar();
      contributeAppBar();
      lightbox.renderIfOpen();
    }

    /**
     * The offline banner (§14) and the ONE status line that goes with it.
     *
     * Both are driven by `libraryReachability`, which is the honest answer
     * this app can give — the frame contract carries no reachability channel
     * today (see that function's own note). The status line says the state in
     * the product's words instead of the invented apology it used to carry;
     * the frame owns the `--net` dot and takes it from the shell's own
     * heartbeat, which this app cannot and must not restyle.
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
      // Published ON THE TRANSITION only. The line is the frame's ONE status
      // line and a write outcome (with its Undo) shares it; re-asserting the
      // offline sentence on every repaint would quietly eat the outcome the
      // member is still reading.
      if (offline && !offlineShown) {
        notice(OFFLINE_COPY.status);
        offlineShown = true;
      } else if (!offline && offlineShown) {
        // Take the sentence back down when the library is reachable again —
        // it is a state, not an outcome, so it does not linger.
        notice("");
        offlineShown = false;
      }
    }
    const handleRetryRead = (): void => {
      void refresh();
    };

    /** Album detail is any shelf id that is neither built-in nor a tag. */
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
     * May this member write to the album they are looking at — and if not,
     * WHY? Albums are a per-scope collection this app only ever authors in the
     * member's own space (scopes.ts `photoWriteTarget("own", …)`), so ONE
     * answer serves the bar's Rename and Delete, the tile's Remove and the app
     * bar's primary. They each used to derive their own, which is how a
     * read-only album ended up refusing two writes and offering a third.
     */
    function albumWriteTarget(): WriteTarget {
      return photoWriteTarget("own", null, scopesNow());
    }
    /** Why the album refuses a write, or undefined while it accepts one — a
     *  reason is a thing to SAY, so there is no empty-string state for it. */
    function albumRefusalReason(): string | undefined {
      const target = albumWriteTarget();
      return target.disabled ? target.reason : undefined;
    }
    /** What the member calls their own library — the SHELL's label, which its
     *  owner may rename, never a storage noun (issue #599). */
    function ownScopeLabel(): string {
      const own = ownId();
      return scopesNow().find((scope) => scope.id === own)?.label ?? "Library";
    }

    /**
     * The read-only surface's primary (proto 4800): download what this view is
     * showing. A client-side save through the SAME batch path the selection
     * bar's fourth action uses — a grant that reads "read and download" gets
     * the download it names, and nothing is written anywhere.
     *
     * The progress ref is null on purpose: `runBatchDownload` writes its
     * running count into the selection bar's own busy element, which this
     * surface has not got. The outcome still lands on the frame's one status
     * line ("Downloaded 12 items · 2 not on this device"), so the member is
     * told what happened — only the intermediate count is missing, and a
     * determinate app-bar counter is a frame contribution this app cannot make
     * today (see the report on `frame.tsx`).
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

    /** Re-read every scope — the explicit, post-write and window-focus path. */
    async function refresh(): Promise<void> {
      await store.refreshAll();
    }

    function albumAssets(): Asset[] {
      if (!shelf) return assets;
      // Favorites and tags are per-asset facts that travel with the row, so
      // they read the merged (filtered) list. Album membership is an ID match
      // against an own-scope collection, so it reads own-scope assets only —
      // see the header note on colliding ids.
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
      // PLACES is one flat list in section order (see `sections()`), so the
      // lightbox steps through it exactly as it is drawn — a viewer that
      // stepped in a different order than the grid would be a second answer to
      // "what is next?". Places, like albums, are an own-scope fact.
      if (shelf === PLACES) return sections().flatMap((s) => s.assets);
      // One person's own sub-state: the same timeline under a filter (§5).
      const personId = personIdFrom(shelf);
      if (personId) return people.assetsFor(personId, ownAssets);
      return ownAssets.filter((a) => a.album_ids?.includes(shelf!));
    }

    /** The Places shelf's sections — an own-scope projection, for the same
     *  reason albums are (a place id minted in one scope means nothing in
     *  another). */
    function sections(): ReturnType<typeof placeSections> {
      return placeSections(ownAssets);
    }

    const { visibleAssets, findAsset } = createVisibility({
      getAssets: () => assets,
      getTrash: () => trash,
      getAlbumAssets: albumAssets,
      getSearchResults: () => searchResults,
      getSearchQuery: () => searchQuery,
      getSelectedAlbum: () => shelf,
    });

    // ---- memories (§4.6) ----
    function memories(): MemoryCard[] {
      if (rootElRef.current?.dataset.showMemories === "hide") return [];
      return buildMemories({
        ownAssets,
        memories: store.own().memories,
        memoryMembers: store.own().memoryMembers,
        onOpen: (id) => navigateTo(id),
      });
    }

    // ---- navigation ----
    function navigateTo(id: ShelfId): void {
      // The shelf strip is the way back OUT of the review (proto :4849 keeps
      // the strip on `dupereview`, and gives the review no Back control of its
      // own): re-selecting Duplicates returns to the cluster list, while
      // leaving Duplicates entirely re-fetches.
      if (shelf === DUPLICATES) {
        if (id === DUPLICATES) duplicates.exitReview();
        else duplicates.invalidate();
      }
      shelf = id;
      newAlbumOpen = false;
      renamingAlbum = false;
      // Any navigation closes the review queue — the shelf strip is the way
      // back, so the People tab itself returns a member to the roster.
      faceReviewOpen = false;
      faceReviewFocusRegionId = null;
      // Navigating IS the dismissal — a sheet that stayed open over the
      // destination it just sent you to would be a second navigation.
      if (moreOpen) closeMore();
      // Selection is cleared when the route leaves Photos (§16); within
      // Photos it survives a shelf change, which is what §6 asks for.
      renderShelfStrip();
      renderToolbarRow();
      renderMain();
      contributeAppBar();
    }

    /** Toggle one vault in the merged timeline. A pure re-projection of data
     *  already held: no scope is re-read. */
    function toggleVault(scopeId: string): void {
      const current = prefs.read().vaultsOn;
      const every = scopesNow().map((scope) => scope.id);
      // The resting state is "every one", held as an EMPTY set. The first
      // toggle therefore materialises the full set and removes one from it,
      // rather than leaving the member looking at a single vault they did not
      // ask to isolate.
      const base = current.size === 0 ? new Set(every) : new Set(current);
      if (base.has(scopeId)) base.delete(scopeId);
      else base.add(scopeId);
      // Switching the last one off would show an empty timeline the member
      // cannot explain, so it reads as "back to every one".
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

    // ---- the frame's app bar (§3) ----
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
      // A READ-ONLY SURFACE SWAPS THE PRIMARY, IT DOES NOT LOSE IT
      // (proto 4800-4801: `readonly ? 'Download' : 'Import'`). Import is not
      // merely disabled here — an import that cannot land is not an offer —
      // and what stands in its place is the one thing this grant DOES allow.
      const readOnlyAlbum = Boolean(album) && albumWriteTarget().disabled;
      // On the phone, while selecting, `Select all`/`Select none` stays in
      // the head with the count and Done — the five actions are the only
      // thing that moves to the bottom bar (§6, §15). Desktop/PWA carry
      // Select all inside the bar itself, so this is left off there.
      const phoneSelectHead =
        narrowRef.current && selection.isActive()
          ? {
              onToggleAll: selection.toggleAll,
              selectedCount: selection.keys.size,
            }
          : {};
      const contribution = appBar({
        // proto :3964 — the review keeps the Duplicates shelf and retitles the
        // bar. The position ("cluster 2 of 6") is NOT put here: the frame's
        // count contract is `{count, unit}` and cannot express it, so the
        // review draws it in its own section head, where the prototype does.
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
        // ONE FILLED INK ELEMENT PER VIEW (§18). The empty block's own
        // `Import photographs` is filled, and it is where the member is
        // looking, so the bar stands down while it is offered rather than
        // putting a second filled Import in the same view. The same rule
        // already drops it while access is denied — an offer that cannot
        // land, or that is already on screen, is not an offer.
        showImport:
          !accessDenied &&
          !readOnlyAlbum &&
          !emptyBlockOffersImport() &&
          shelf !== TRASH &&
          shelf !== DUPLICATES &&
          shelf !== STORAGE &&
          // No app-bar primary on Search (§9, ~4799): the shelf's own
          // field is where the member is looking, same reason the empty
          // block already stands the bar down.
          shelf !== SEARCH,
        // Inside a real album the natural "add" is from the library, not from
        // disk (proto :4280, the Picker tab). This is the ONLY route that
        // reaches the picker in a NON-empty album: its other entry lives in
        // the empty block, which is `hidden` the moment the album has a
        // photograph in it, so the picker was unreachable there.
        onImport: () => (album ? openPicker() : $("fileInput").click()),
        // Desktop/PWA's own way to Search (§9) — the compact band already
        // claims a Search destination, so the bar's control is dropped
        // there (frame.tsx honours `compact`).
        compact: narrowRef.current,
        onSearch: () => navigateTo(SEARCH),
        ...(target.disabled ? { importDisabledReason: target.reason } : {}),
        ...phoneSelectHead,
      });
      frameRef.current.setAppBar(
        readOnlyAlbum
          ? {
              ...contribution,
              // COMPOSED onto the frame's own action set, never a second bar:
              // frame.tsx describes `Select` and `Import`, and this appends the
              // one primary that surface has left. It is the app bar's LAST
              // action, which is where the primary lives (frame.tsx).
              actions: (
                <>
                  {contribution.actions}
                  <button
                    type="button"
                    className="kit-btn primary"
                    // The prototype's own `primaryTitle` — help on an ENABLED
                    // control, not a refusal hidden in a tooltip. The library
                    // is named by its scope's label, which its owner may
                    // rename, never by a storage noun (issue #599).
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
                // proto :4800/:4803 — the Duplicates shelf's primary is
                // `Review duplicates`, not Import. Composed onto the frame's
                // action set exactly as the read-only Download above is.
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
      // The band is claimed unconditionally: the frame honours it only on the
      // compact form factor and only while the member's `bandOwner` says
      // `app`, so the app never has to ask whether it may (§3.1).
      frameRef.current.claimBand(
        prefs.read().bandOwner === "app"
          ? bandClaim(
              shelf,
              (segment) => navigateTo(shelfFromSegment(segment)),
              openMore
            )
          : null
      );
    }

    /** What the app bar's count counts on this shelf — or null where a count
     *  would have to be invented rather than read. */
    function countFor(): number | null {
      if (shelf === ALBUMS) return albums.length;
      // The places the LOADED photographs actually name, not the whole known
      // place list: the sections below are what this count counts.
      if (shelf === PLACES) return sections().length;
      if (shelf === PEOPLE) return people.list()?.length ?? null;
      // The count IS known once the shelf's own load lands (proto 3943
      // `Duplicates · 6 clusters`) — `duplicates.count()` carries the same
      // "not yet answered" `null` every other lazy shelf's count does.
      if (shelf === DUPLICATES) return duplicates.count();
      if (shelf === STORAGE) return null;
      if (shelf === SEARCH) return searchResults?.length ?? null;
      return visibleAssets().length;
    }

    // ---- the shelf strip (§5) ----
    function renderShelfStrip(): void {
      const album = currentAlbum();
      const refusal = albumRefusalReason();
      if (album) {
        // Album detail drops the strip and puts the way back in its place.
        shelfStripRoot.render(
          <AlbumBar
            title={album.title ?? "Album"}
            renaming={renamingAlbum}
            canWrite={!albumWriteTarget().disabled}
            // A refused control SAYS WHY, inline (README:233). The bar used to
            // disable Rename and Delete and explain nothing.
            {...(refusal === undefined ? {} : { reason: refusal })}
            onBack={() => navigateTo(ALBUMS)}
            onStartRename={() => {
              renamingAlbum = true;
              renderShelfStrip();
            }}
            onRenameSubmit={(title) =>
              submitRenameAlbum(album, title, {
                refresh,
                renderToolbar: renderShelfStrip,
                setRenamingAlbumForId: (id) => {
                  renamingAlbum = id !== null;
                },
              })
            }
            onRenameCancel={() => {
              renamingAlbum = false;
              renderShelfStrip();
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
      // On the phone whose band claim was honoured, the band carries the
      // shelves and the strip is not rendered — exactly one navigation for one
      // set of destinations (§3, §15).
      if (narrowRef.current && prefs.read().bandOwner === "app") {
        shelfStripRoot.render(null);
        return;
      }
      // No shelf strip on Search (§9, ~4849): Search reads as its own page,
      // not the timeline under a filter every other strip tab is — the field
      // and the states below it are the whole surface.
      if (shelf === SEARCH) {
        shelfStripRoot.render(null);
        return;
      }
      shelfStripRoot.render(
        <ShelfStrip
          shelf={shelf}
          counts={shelfCounts()}
          narrow={narrowRef.current}
          onSelect={navigateTo}
        />
      );
    }

    /** What each shelf counts, for the strip AND the band's sheet — two views
     *  of one navigation must never disagree about how many are in Trash. */
    function shelfCounts(): ReadonlyMap<string, number> {
      return new Map<string, number>([
        [FAVORITES, assets.filter((a) => a.favorite).length],
        [ALBUMS, albums.length],
        [PLACES, sections().length],
        [TRASH, trash.length],
      ]);
    }

    // ---- the Photos toolbar row (§3) ----
    // It renders only when it carries something — ToolbarView returns null
    // when it does not, so an empty row is never laid out.
    function renderToolbarRow(): void {
      applyUploadTarget();
      if (selection.isActive()) {
        // `#toolbarMount` becomes the selection bar while a selection is
        // active — selection.tsx's `renderBar` owns writing to it then, so
        // this function stays out of its way rather than racing it with a
        // `null` write of its own (v4 §6 close-out).
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

    // ---- main content ----
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
        // The review queue is the People shelf in a different mode (§8):
        // same tab, same strip, one proposal at a time. FaceReview is
        // self-contained — it fetches its queue and fires its own writes.
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
        // Lazy, like the duplicate clusters: the roster walks every confirmed
        // face region, which is a bigger read than the bounded window.
        void people.ensureLoaded();
        const roster = people.list();
        const proposalRoster = people.proposalList() ?? [];
        // The consent gate (issue #712 C2) is the empty state's body only
        // while there is truly nothing to browse — a roster with unconfirmed
        // proposal cards has content the gate would hide, not an invitation
        // to ask the question again.
        const rosterEmpty =
          roster !== null && roster.length === 0 && proposalRoster.length === 0;
        if (rosterEmpty) enrichGate.ensurePolicyLoaded();
        const gateProps = rosterEmpty
          ? enrichGate.props(ownAssets.length)
          : null;
        // A roster that has not answered is not an empty roster — the same
        // rule the timeline follows below, expressed through the same gate.
        // The consent gate draws its own explanation of an empty shelf, so
        // the generic empty block is suppressed while it is showing — the
        // same treatment Search, Duplicates and Storage get.
        applyEmptyState(
          gateProps
            ? NO_EMPTY_STATE
            : emptyFor(roster?.length ?? 0, { suppressed: roster === null })
        );
        mainRoot.render(
          roster === null ? (
            <KitSkeleton rows={3} />
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

      // BEFORE THE FIRST READ LANDS THE GRID IS A SHAPE, NOT A VERDICT (§14).
      // `shown` is `[]` while the read is in flight, and the app used to hand
      // that straight to the empty state — telling a member with 6,214
      // photographs that their library was empty. Now it paints `--skel` at
      // the packed geometry, so nothing reflows when the rows arrive, and the
      // toolbar, the shelf strip and the rail all stay exactly where they are.
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
     * WHAT SITS AT THE HEAD OF THE TIMELINE (§4.6, §5, §11). One slot, several
     * claimants, and the order below is the order of urgency:
     *
     *  1. The import panels, when the last run had a dedupe or a restore to
     *     explain. They are read after the fact and they are about what the
     *     member just did, so they lead — and they ride ANY shelf, because an
     *     import lands somewhere the member is looking at.
     *  2. The shelf's own head: Trash's note (§5, proto 4445) or the memories
     *     strip (§4.6). These are mutually exclusive by shelf, so they share
     *     the slot rather than asking Timeline.tsx for two.
     *
     * Memories are the Library shelf's alone, and only at rungs XS-M: at L the
     * cards and the first row of tiles are the same size and the head stops
     * reading as a head.
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
     * The justified timeline, as one element. Every shelf that packs tiles
     * renders the SAME grid under a different filter (§5), so its props live
     * in one place: two call sites drifting apart is how a shelf quietly stops
     * honouring the tile size or the selection.
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
      // Named for the jsx-handler-names rule: the grid's props ask for
      // `handle*`, and re-pointing them here keeps selection.tsx the one owner.
      const handleEnterSelect = selection.enter;
      const handleToggleSelect = selection.toggle;
      // Pinch walks the SAME four rungs the stepper walks (§4.2) — one member
      // preference, one clamp, two ways in.
      const handlePinchRung = (delta: number): void => {
        prefs.write({ tileSize: stepTileSize(prefs.read().tileSize, delta) });
      };
      return (
        <TimelineBody
          assets={shown}
          // The rail is a real column on desktop/PWA, so the packer's budget
          // is the pane minus it; on the phone the rail overlays and the grid
          // keeps every pixel (§4.5).
          containerWidth={paneWidth - (phone ? 0 : RAIL_WIDTH)}
          targetHeight={rungHeight(rung, phone ? "phone" : "desktop")}
          rung={rung}
          phone={phone}
          memories={extra.memories ?? null}
          inAlbum={Boolean(album)}
          albumId={album ? album.album_id : null}
          // The tile's own Remove is gated by the SAME answer as the album
          // bar's Rename and Delete. It used to be gated by `inAlbum` alone,
          // so a read-only album refused two writes in its bar and offered a
          // third, working one on every tile below it.
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

    /**
     * The empty block for the current view — the ONE place that decides
     * whether this app is entitled to say a view is empty (view-state.ts).
     * `count` is what the view is showing; `loaded` is whether it has been
     * told anything at all.
     */
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
        // The camera is the compact surface's second way in (§15) — a desktop
        // browser would open a file picker wearing a camera's name.
        phone: narrowRef.current,
        ...extra,
      });
    }

    /** Write one empty block onto its nodes, or take it down. The nodes are
     *  imperative and long-lived (Chrome.tsx's `#empty`); upload.ts bound
     *  `#emptyUpload` at boot and `applyUploadTarget` re-reads it every
     *  render, so they are never unmounted. */
    function applyEmptyState(view: EmptyStateView): void {
      $("empty").hidden = !view.visible;
      if (!view.visible) return;
      $("emptyText").textContent = view.title;
      $("emptyBody").textContent = view.body;
      $("emptyUpload").hidden = !view.offersImport;
      $("emptyCamera").hidden = !view.offersCamera;
    }

    /** Is the empty block currently drawing the view's one filled Import? Read
     *  off what is actually on screen rather than re-derived: "one filled ink
     *  element per view" (§18) is a claim about the rendered view, and two
     *  derivations of it could disagree. `renderMain` always runs before
     *  `contributeAppBar` on every path that changes either. */
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

    /** The Places shelf (§5) — sections, not cartography. See Places.tsx. */
    function renderPlacesShelf(
      grouped: ReturnType<typeof placeSections>
    ): void {
      const phone = narrowRef.current;
      const rung = prefs.read().tileSize;
      // Named for the jsx-handler-names rule, exactly as `timeline()` does —
      // re-pointing them here keeps selection.tsx the one owner.
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
          onOpen={handleOpenLightbox}
          onToggleSelect={handleToggleSelect}
          onEnterSelectMode={handleEnterSelect}
        />
      );
    }

    /** Storage (§12) — every number read off the rows this app already holds. */
    function renderStorage(): void {
      // Read on first visit, not on every library refresh: the rollup only
      // moves when the gateway's standing blob sweep runs.
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

    // ---- search (a shelf, §9) ----
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
      // The `searching` state is DETERMINATE, not a spinner (§14): what is on
      // screen while the index answers is the local match over the loaded
      // window, and the shelf says so with its exact count.
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

    // ---- the band's overflow sheet (§3.1) ----
    // The band's sixth slot is the APP's, so the sheet is the app's too. It
    // opens on a tap, dismisses on Esc, on Close, and on navigating — never by
    // itself, and never over a destination it just reached.
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

    // ---- upload ----
    async function uploadFiles(files: File[]): Promise<void> {
      if (uploading || files.length === 0) return;
      // WHAT THE TRASH HELD BEFORE THE RUN, snapshotted now. Re-uploading the
      // bytes of a deleted photograph restores it, and the vault reports that
      // with the same `deduped: 1` it reports an ordinary dedupe with — so the
      // only way to tell the two apart is to have known, a moment ago, that
      // the asset was in the trash. `runUpload` refreshes before it returns,
      // by which point the row is live again and the evidence is gone.
      const trashedBefore = new Set(trash.map((asset) => asset.asset_id));
      const result = await runUpload(files, {
        refresh,
        setUploading: (v) => {
          uploading = v;
        },
        wasTrashed: (assetId) => trashedBefore.has(assetId),
      });
      // Only a run with an outcome to explain leaves a panel behind (§11).
      lastImport = result.deduped + result.restored > 0 ? result : null;
      renderMain();
    }

    // Selection owns its own mode, keys, busy latch and bar (selection.tsx);
    // this closure only tells it when the data moved and what to repaint.
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

    // The People shelf's roster (people.ts). Own-scope and lazy, like the
    // duplicate clusters; a repaint is all this closure owes it.
    const people = createPeople({
      onData: () => {
        if (disposed) return;
        renderMain();
        contributeAppBar();
      },
    });

    // The face-detection consent gate (issue #712 C2), re-homed from a
    // toolbar icon + dialog into the People shelf's own empty state — see
    // enrichment-gate.ts and components/People.tsx's `gate` prop.
    const enrichGate = createEnrichmentGate({
      onData: () => {
        if (disposed) return;
        renderMain();
      },
    });

    // The Storage screen's custody rollup (custody-store.ts). Lazy and
    // multi-scope, like the People roster; a repaint is all this closure owes it.
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

    // `Take a photograph` (§14, §15) — the compact surface's second way in.
    // Its own input, because `capture` on the shared one would take the file
    // picker away from the desktop (see Chrome.tsx).
    const onCameraClick = (): void => $("cameraInput").click();
    const onCameraChange = async (): Promise<void> => {
      const input = $<HTMLInputElement>("cameraInput");
      const files = [...(input.files ?? [])];
      input.value = "";
      await uploadFiles(files);
    };
    $("emptyCamera").addEventListener("click", onCameraClick);
    $("cameraInput").addEventListener("change", onCameraChange);

    // ---- global wiring ----
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
      // What a key means over an open lightbox is decided in ONE pure place
      // (lightbox.tsx `viewerKeyAction`) — including the refusal that matters:
      // while the editor is up, ←/→ mean nothing, because stepping the viewer
      // remounts the editor and destroys a crop and rotation that were never
      // written anywhere (§7.4).
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

    // The grid's real width drives the justified timeline (read off #grid, not
    // #scrollPane whose clientWidth includes its own padding).
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

    // Component-width narrow observer (#505 trap 1). The strip and the band
    // are two views of one navigation, so a width change re-decides which one
    // is drawn.
    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 860, (isNarrow: boolean) => {
          narrowRef.current = isNarrow;
          setNarrow(isNarrow);
          renderShelfStrip();
          renderMain();
        })
      : () => {};

    // ---- first paint ----
    renderShelfStrip();
    renderToolbarRow();
    // `renderMain` paints the packed `--skel` grid while `loaded` is false
    // (§14) — the first frame already occupies the geometry the photographs
    // will, so nothing reflows when the read lands. It used to be a stack of
    // `<kit-skeleton>` bars, which is the wrong shape for a timeline and
    // guaranteed exactly the reflow §14 exists to prevent.
    renderMain();
    // The host may already know the gateway is unreachable before this app has
    // asked it anything — if it says so, the member reads why on the first
    // frame rather than after a read has timed out.
    renderOfflineBanner();
    contributeAppBar();
    void store.refreshAll();

    return () => {
      // A read may resolve after React removes Chrome's DOM. Fence its
      // continuation before removing listeners so it cannot mutate detached
      // slots or call the id-based helpers against a now-empty document.
      disposed = true;
      store.dispose();
      stopLiveReads();
      // Withdraw every contribution: the bar, the band and the status line all
      // belong to the frame, and a stale Photos title on the next route would
      // be this app drawing chrome it no longer owns.
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
    // Fill the app pane (a flex child of the route body) so the inline chrome
    // gets real width (#505 trap 1). The Photos token layer
    // (Chrome.module.css `.appRoot`) rides this same element.
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
      <Chrome narrow={narrow} slots={slots} />
    </div>
  );
}
