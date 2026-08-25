// governance: allow-repo-hygiene file-size-limit — this file holds the app's whole orchestration as one React tree by design (#505); it is smaller than the served app.tsx + app-inline.tsx it replaces. Splitting it belongs to the app's own code evolution, not this migration.
// Docs — query-free React tree (#505): `Root` plus everything it needs that
// does NOT depend on the node-side `./queries/*` modules. The InlineAppModule
// descriptor adds the query wiring; there is deliberately no served entry.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";

import {
  closePopover,
  debounce,
  observeWidth,
  onDataChange,
  onFocusRefresh,
  openPopover,
  popItem,
  readFailed,
  showSkeleton,
} from "@centraid/design/elements";

import { publishOutcome } from "../_shared/app-frame.tsx";
import { readGrantAudiences } from "../_shared/grant-audiences.ts";
import { grantPlaneAvailable } from "../_shared/grant-gateway.ts";
import type { GrantAudienceOption } from "../_shared/grant-plane.ts";
import { GrantSheet } from "../_shared/GrantSheet.tsx";
import { navSeat } from "../_shared/nav-seat.ts";
import { NavRail } from "../_shared/NavRail.tsx";
import { mountedScopes } from "../_shared/scope-kit.ts";
import { SearchScaffold } from "../_shared/SearchScaffold.tsx";
import { SAVED_TO_MY_VAULT } from "../_shared/shared-copy.ts";
import type { InlineAppProps } from "../inline-types.ts";
import { Chrome } from "./Chrome.tsx";
import {
  FilingRoute,
  LockerBoundaryRoute,
  NamesRoute,
} from "./components/BoundaryRoute.tsx";
import { BulkBar } from "./components/BulkBar.tsx";
import { CapabilitiesRoute } from "./components/CapabilitiesRoute.tsx";
import { Details } from "./components/Details.tsx";
import { DriveRoute } from "./components/DriveRoute.tsx";
import { FoldersRoute } from "./components/FoldersRoute.tsx";
import { InfoToggle } from "./components/InfoToggle.tsx";
import { MoreSheet } from "./components/MoreSheet.tsx";
import { NewDocRoute } from "./components/NewDocRoute.tsx";
import { NewMenu } from "./components/NewMenu.tsx";
import { QuickLook } from "./components/QuickLook.tsx";
import { ScanRoute } from "./components/ScanRoute.tsx";
import { SearchField } from "./components/SearchField.tsx";
import { PermissionPanel, ReadOnlyPanel } from "./components/SeatStates.tsx";
import { OfflineBanner } from "./components/Shared.tsx";
import { ShelfStrip } from "./components/ShelfStrip.tsx";
import { FolderList, Storage } from "./components/Sidebar.tsx";
import { StorageRoute } from "./components/StorageRoute.tsx";
import { UploadQueue } from "./components/UploadQueue.tsx";
import { VersionsRoute } from "./components/VersionsRoute.tsx";
import { ViewToggle } from "./components/ViewToggle.tsx";
import {
  SEARCH_COPY,
  SEARCH_EXAMPLES,
  SEARCH_SCOPE,
  SORT_OPTIONS,
  crumbsFor,
} from "./drive-copy.ts";
import { NO_FILTERS, filtersActive } from "./filters.ts";
import type { DriveFilters } from "./filters.ts";
import { appBar, bandClaim } from "./frame.tsx";
import { docsRosterAnswer } from "./grant-audiences.ts";
import type { DocsShareHost } from "./grant-audiences.ts";
import { createLogic, RECENT_WINDOW } from "./logic.ts";
import { docsNavRail } from "./nav-rail.ts";
import { createNav } from "./nav.ts";
import {
  CAPABILITIES,
  FILING,
  FOLDERS,
  LOCKER,
  NAMES,
  NEWDOC,
  RECENT,
  SCAN,
  SEARCH,
  STARRED,
  STORAGE,
  TRASH,
  allowsSelection,
  countKey,
  folderIdFrom,
  shelfFromSegment,
  showsDrive,
  showsViewToggle,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { AppData, AppState, DriveDoc, Folder, SortKey } from "./types.ts";
import { captionFor } from "./view-copy.ts";
import {
  emptyStateView,
  libraryReachability,
  shelfAfterRead,
} from "./view-state.ts";

import styles from "./Chrome.module.css";

// The doorbell re-derives only when a change names one of these, or names none
// (i.e. "this app acted").
export const CHANGE_TABLES = [
  "core.document",
  "core.content_item",
  "core.tag",
  "core.concept",
  "core.concept_scheme",
  "core.link",
  "blob.custody_state",
  "consent.provenance",
];

interface DriveResult {
  folders?: Folder[];
  documents?: DriveDoc[];
  root_folder_id?: string | null;
  truncated?: boolean;
  vaultDenied?: { message?: string } | null;
}
interface SearchResult {
  documents?: DriveDoc[];
}

const VALID_VIEWS = new Set<AppState["view"]>(["grid", "list"]);

function initialView(rootEl: HTMLElement | null): AppState["view"] {
  const knob = rootEl?.dataset.appView;
  return knob && VALID_VIEWS.has(knob as AppState["view"])
    ? (knob as AppState["view"])
    : "grid";
}

function makeState(view: AppState["view"]): AppState {
  return {
    view,
    shelf: null,
    filters: NO_FILTERS,
    // The order the status line names, and the one Recently changed filters.
    sortKey: "changed",
    sortDir: -1,
    selecting: false,
    uploadQueue: [],
    tag: "all",
    search: "",
    searchResults: null,
    searchStatus: "resting",
    searchSeq: 0,
    selected: new Set(),
    anchorIndex: null,
    detailsId: null,
    quickId: null,
    versionsId: null,
    newMenuOpen: false,
    creatingFolder: false,
    renamingFolderId: null,
    narrow: false,
    uploading: false,
    visibleRows: [],
    driveWindow: 200,
    driveTruncated: false,
  };
}

// One ref, because the wiring is circular: nav needs logic.clearSelection and
// logic needs nav.openQuick.
interface Core {
  logic: ReturnType<typeof createLogic>;
  nav: ReturnType<typeof createNav>;
  refresh: () => Promise<void>;
  applySearch: () => void;
}

export function Root({
  rootRef,
  frame,
  compact = false,
}: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [narrow, setNarrow] = useState(false);
  const [ready, setReady] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // The only evidence this app has for "the gateway is out of reach". State,
  // not the ref below: the banner, caption and row state slots render from it.
  const [readFailedState, setReadFailedState] = useState(false);
  const [consent, setConsent] = useState<{ message: string } | null>(null);
  const [dropVisible, setDropVisible] = useState(false);
  const [dropTarget, setDropTarget] = useState("");
  const [shareFolder, setShareFolder] = useState<Folder | null>(null);
  // `null` is "not an answer" — unread or unreadable — which is not the same
  // fact as a vault that knows nobody. Share needs an answer; empty is one.
  const [audiences, setAudiences] = useState<
    readonly GrantAudienceOption[] | null
  >(null);
  // React state, not the mutable bag: nothing outside this component opens it.
  const [moreOpen, setMoreOpen] = useState(false);

  const [residentFolderIds, setResidentFolderIds] = useState<Set<string>>(
    () => new Set()
  );

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const skeletonRef = useRef<HTMLDivElement | null>(null);
  const readFailedRef = useRef(false);
  // A ref, not state: it is SET during the same render that performs the move,
  // so the destination explains itself on that frame — a render-phase write no
  // `setState` may do (view-state.ts rule 2).
  const goneFolderRef = useRef(false);

  const dataRef = useRef<AppData>({
    folders: [],
    documents: [],
    root_folder_id: null,
  });
  const stateRef = useRef<AppState>(makeState(initialView(null)));
  const coreRef = useRef<Core | null>(null);

  // Built once. Every render entry point funnels to `bump` — one tree.
  if (!coreRef.current) {
    const state = stateRef.current;
    const data = dataRef.current;
    const render = (): void => {
      closePopover();
      bump();
    };
    let core = undefined as unknown as Core;

    const refresh = async (): Promise<void> => {
      let next: DriveResult;
      try {
        next = await window.centraid.read<DriveResult>({
          query: "drive",
          input: { limit: state.driveWindow },
        });
      } catch {
        readFailed(document.querySelector<HTMLElement>("#noticeBanner"));
        readFailedRef.current = true;
        setReadFailedState(true);
        setLoaded(true);
        return;
      }
      if (readFailedRef.current) {
        readFailedRef.current = false;
        core.logic.notice("");
      }
      setReadFailedState(false);
      const denied = next?.vaultDenied;
      setConsent(denied ? { message: denied.message ?? "" } : null);
      setLoaded(true);
      if (denied) {
        bump();
        return;
      }
      // Mutate in place, never reassign: logic.ts closed over this object.
      const incoming = next ?? data;
      data.folders = incoming.folders ?? [];
      data.documents = incoming.documents ?? [];
      data.root_folder_id = incoming.root_folder_id ?? data.root_folder_id;
      state.driveTruncated = Boolean(next?.truncated);
      state.selected = new Set(
        [...state.selected].filter((id) =>
          data.documents.some((d) => d.document_id === id)
        )
      );
      if (
        state.detailsId &&
        !data.documents.some((d) => d.document_id === state.detailsId)
      )
        state.detailsId = null;
      if (
        state.quickId &&
        !data.documents.some((d) => d.document_id === state.quickId)
      )
        state.quickId = null;
      // A background refresh must never close the editor over a typing user.
      bump();
    };
    core = { refresh } as Core;

    core.applySearch = debounce(async () => {
      // The field belongs to the Search shelf, so this debounce can be in
      // flight after the member leaves — a missing field means no query left.
      const field = document.querySelector<HTMLInputElement>("#searchInput");
      if (!field) return;
      const q = field.value.trim();
      if (q === state.search) return;
      state.search = q;
      core.logic.clearSelection();
      if (!q) {
        state.searchResults = null;
        state.searchStatus = "resting";
        render();
        return;
      }
      const seq = ++state.searchSeq;
      // A DETERMINATE line over what it already has — never a spinner.
      state.searchStatus = "searching";
      render();
      let rows: DriveDoc[] = [];
      let reached = true;
      try {
        const res = await window.centraid.read<SearchResult>({
          query: "search",
          input: { term: q },
        });
        rows = res?.documents ?? [];
      } catch {
        // A THROW IS NOT AN EMPTY RESULT SET. Falling through to `rows = []`
        // would print "nothing matches" — a claim nobody verified.
        reached = false;
      }
      if (seq !== state.searchSeq) return;
      state.searchResults = reached ? rows : null;
      state.searchStatus = reached ? "ready" : "unreachable";
      render();
    }, 150);

    core.nav = createNav({
      state,
      render,
      refresh: core.refresh,
      renderDetails: bump,
      renderQuick: bump,
      renderNewMenu: bump,
      clearSelection: () => core.logic.clearSelection(),
    });
    core.logic = createLogic({
      state,
      data,
      render,
      refresh: core.refresh,
      openQuick: (id: string) => core.nav.openQuick(id),
      openDetails: (id: string) => core.nav.openDetails(id),
      openVersions: (id: string) => core.nav.openVersions(id),
    });
    coreRef.current = core;
  }

  const core = coreRef.current;
  const { logic } = core;
  const { nav } = core;
  const {
    addTag: handleAddTag,
    cancelCreateFolder: handleCancelCreateFolder,
    cancelRenameFolder: handleCancelRenameFolder,
    clearSelected: handleClearSelected,
    createFolder: handleCreateFolder,
    deleteFolder: handleDeleteFolder,
    moveSelected: handleMoveSelected,
    openDocMenu: handleOpenDocMenu,
    openMovePopover: handleOpenMovePopover,
    removeTag: handleRemoveTag,
    renameFolder: handleRenameFolder,
    replaceDocument: handleReplaceDocument,
    restoreDoc: handleRestoreDoc,
    restoreSelected: handleRestoreSelected,
    starSelected: handleStarSelected,
    restoreVersion: handleRestoreVersion,
    startRenameFolder: handleStartRenameFolder,
    toggleAllVisible: handleToggleAllVisible,
    toggleSelect: handleToggleSelect,
    toggleStar: handleToggleStar,
    trashDoc: handleTrashDoc,
    trashSelected: handleTrashSelected,
  } = logic;
  const handleSearchInput = core.applySearch;
  const {
    closeDetails: handleCloseDetails,
    closeQuick: handleCloseQuick,
    closeVersions: handleCloseVersions,
    openVersions: handleOpenVersions,
    openDetails: handleOpenDetails,
    quickStep: handleQuickStep,
    showMoreDocs: handleShowMoreDocs,
    startCreateFolder: handleStartCreateFolder,
    triggerUpload: handleTriggerUpload,
  } = nav;
  // OPENING A ROW OPENS THE STAGE (§1.8, §7) — never a fork giving text its own
  // reading screen. §1.8's rule is about the SHEET, which the stage keeps, and a
  // fork makes text the one kind a member cannot arrow through.
  const handleOpenQuick = useCallback(
    (id: string) => core.nav.openQuick(id),
    [core]
  );
  const state = stateRef.current;
  const data = dataRef.current;

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      rootElRef.current = el;
      rootRef(el);
      if (el) {
        const view = initialView(el);
        if (view !== stateRef.current.view) {
          stateRef.current.view = view;
          bump();
        }
      }
    },
    [rootRef]
  );

  // Every navigation inside Docs clears what was open over it (§1.1).
  const selectShelf = useCallback(
    (shelf: ShelfId) => {
      // THE QUERY BELONGS TO THE SEARCH SHELF. `currentRows` answers with FTS
      // matches whenever `state.search` is set, on any shelf, so a query left
      // behind shows search results under the wrong breadcrumb.
      if (shelf !== SEARCH && state.search) {
        if (searchInputRef.current) searchInputRef.current.value = "";
        state.searchSeq += 1;
        state.search = "";
        state.searchResults = null;
        state.searchStatus = "resting";
      }
      nav.selectShelf(shelf);
      goneFolderRef.current = false;
      // The MODE must go with the ticks `nav.selectShelf` already dropped, or
      // the next shelf opens with a column of boxes nobody asked for.
      state.selecting = false;
      setMoreOpen(false);
      setSideOpen(false);
    },
    [nav, state]
  );

  /**
   * The way IN to search: land on the shelf and put the caret in its field. The
   * focus is deferred one frame because the field does not exist until this
   * navigation has rendered.
   */
  const openSearch = useCallback(() => {
    selectShelf(SEARCH);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [selectShelf]);

  const toggleNewMenu = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
      state.newMenuOpen = !state.newMenuOpen;
      bump();
    },
    [state]
  );

  const selectView = useCallback(
    (view: AppState["view"]) => {
      state.view = view;
      bump();
    },
    [state]
  );

  // Same column reverses; a different one takes over at ITS OWN natural
  // direction, or every member's first press is a correction.
  const onSortBy = useCallback(
    (key: SortKey) => {
      if (state.sortKey === key) state.sortDir = state.sortDir === 1 ? -1 : 1;
      else {
        state.sortKey = key;
        state.sortDir = key === "name" || key === "kind" ? 1 : -1;
      }
      bump();
    },
    [state]
  );

  // The same plain DOM popover the row kebab and "Move to…" use, so there is
  // one popover in the app at a time and one Escape that closes it.
  const onOpenSortMenu = useCallback(
    (anchor: HTMLElement) => {
      openPopover(anchor, (box) => {
        for (const option of SORT_OPTIONS) {
          const on =
            state.sortKey === option.key && state.sortDir === option.dir;
          box.append(
            popItem(
              `${option.name} · ${option.sub}`,
              () => {
                closePopover();
                state.sortKey = option.key;
                state.sortDir = option.dir;
                bump();
              },
              // TRAILING, AND A TICK — never a leading accent dot, which puts
              // the mark on the edge every label starts from and pushes the
              // other rows' text past it. Labels keep one edge; "which one is
              // on" is answered at the other.
              on ? { trailing: "✓" } : {}
            )
          );
        }
      });
    },
    [state]
  );

  const onSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      const input = searchInputRef.current;
      if (!input?.value && !state.search) return;
      if (input) input.value = "";
      state.searchSeq += 1;
      state.search = "";
      state.searchResults = null;
      state.searchStatus = "resting";
      state.selected.clear();
      state.anchorIndex = null;
      bump();
    },
    [state]
  );

  const onUploadChange = useCallback(() => {
    const input = uploadRef.current;
    if (!input) return;
    const files = [...(input.files ?? [])];
    input.value = "";
    void logic.uploadFiles(files);
  }, [logic]);

  // Seed narrow BEFORE first paint: observeWidth fires only post-paint, so the
  // drawer would paint as an in-flow sidebar and then slide out. `.side` stays
  // gated on `ready` so this snap does not animate.
  useLayoutEffect(() => {
    const el = rootElRef.current;
    if (!el) return;
    const forced = el.dataset.appWidth === "narrow";
    const isNarrow = forced || el.clientWidth < 860;
    if (isNarrow !== stateRef.current.narrow) {
      stateRef.current.narrow = isNarrow;
      setNarrow(isNarrow);
    }
  }, []);
  // After the first painted frame, so the mount-time snap above is instant.
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // THE ROSTER IS READ ONCE, HERE: three surfaces open the share sheet, and a
  // read per sheet asks People the same question three times.
  useEffect(() => {
    if (!ready || !grantPlaneAvailable()) return;
    let active = true;
    void readGrantAudiences().then((read) => {
      if (!active) return;
      // A ROSTER THAT COULD NOT BE READ IS NOT AN EMPTY ONE; `docsRosterAnswer`
      // is where the two stay apart.
      const answer = docsRosterAnswer(read);
      if (answer.status) publishOutcome(frame, { text: answer.status });
      if (answer.audiences) setAudiences(answer.audiences);
    });
    return () => {
      active = false;
    };
  }, [frame, ready]);

  useEffect(() => {
    if (!ready || !window.centraid.commonsResidents) return;
    const actorVaultId = mountedScopes()[0]?.id;
    if (!actorVaultId) return;
    let active = true;
    void window.centraid
      .commonsResidents(actorVaultId)
      .then((items) => {
        if (active)
          setResidentFolderIds(
            new Set(
              items.flatMap((item) =>
                item.itemType === "docs.folder" ? [item.itemId] : []
              )
            )
          );
      })
      .catch(() => {
        if (active) setResidentFolderIds(new Set());
      });
    return () => {
      active = false;
    };
  }, [ready]);

  const saveFolderToMyVault = async (folder: Folder): Promise<void> => {
    const actorVaultId = mountedScopes()[0]?.id;
    if (!actorVaultId || !window.centraid.retainCommonsItem) return;
    try {
      await window.centraid.retainCommonsItem({
        actorVaultId,
        itemType: "docs.folder",
        itemId: folder.folder_id,
      });
      setResidentFolderIds((current) => {
        const next = new Set(current);
        next.delete(folder.folder_id);
        return next;
      });
      // Outcomes go through ONE door (§11): the frame's status line.
      publishOutcome(frame, {
        text: SAVED_TO_MY_VAULT,
      });
    } catch (error) {
      publishOutcome(frame, {
        text:
          error instanceof Error
            ? `Folder was not saved: ${error.message}`
            : "Folder was not saved to your vault.",
      });
    }
  };

  // ──── chrome wiring: doorbell, focus, width, keys, drag/drop ────
  useEffect(() => {
    const stopDoorbell = onDataChange(CHANGE_TABLES, () => void core.refresh());
    const stopFocus = onFocusRefresh(() => void core.refresh());

    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (state.quickId) {
        if (e.key === "Escape") {
          e.preventDefault();
          handleCloseQuick();
        } else if (e.key === "ArrowLeft") handleQuickStep(-1);
        else if (e.key === "ArrowRight") handleQuickStep(1);
        return;
      }
      if (e.key !== "Escape") return;
      if (state.detailsId) {
        handleCloseDetails();
        return;
      }
      if (state.newMenuOpen) {
        state.newMenuOpen = false;
        bump();
        return;
      }
      setSideOpen(false);
    };
    window.addEventListener("keydown", onKey);

    // Outside-click close, via the data-new-wrap hook Chrome stamps.
    const onDocClick = (e: MouseEvent): void => {
      if (
        state.newMenuOpen &&
        !(e.target as Element | null)?.closest("[data-new-wrap]")
      ) {
        state.newMenuOpen = false;
        bump();
      }
    };
    document.addEventListener("click", onDocClick);

    let dragDepth = 0;
    const dragHasFiles = (e: DragEvent): boolean =>
      [...(e.dataTransfer?.types ?? [])].includes("Files");
    const onDragEnter = (e: DragEvent): void => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      const folderId = folderIdFrom(state.shelf);
      const target = folderId ? logic.folderName(folderId) : "Documents";
      setDropTarget(`Drop to upload to ${target}`);
      setDropVisible(true);
    };
    const onDragOver = (e: DragEvent): void => {
      if (dragHasFiles(e)) e.preventDefault();
    };
    const onDragLeave = (): void => {
      if (dragDepth === 0) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDropVisible(false);
    };
    const onDrop = (e: DragEvent): void => {
      e.preventDefault();
      dragDepth = 0;
      setDropVisible(false);
      const files = e.dataTransfer?.files;
      if (files?.length) void logic.uploadFiles(files);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 860, (isNarrow: boolean) => {
          state.narrow = isNarrow;
          setNarrow(isNarrow);
          if (!isNarrow) setSideOpen(false);
        })
      : () => {};

    void core.refresh();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onDocClick);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      stopDoorbell();
      stopFocus();
      stopWidth();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#505)
  }, []);

  // Imperative kit writes are safe here: these containers carry no JSX
  // children, so React reconciliation never clobbers them.
  useEffect(() => {
    if (!loaded && skeletonRef.current) showSkeleton(skeletonRef.current, 6);
  }, [loaded]);

  // ──── derive the render (app.tsx's render()/renderSidebar/renderToolbar/… ) ────

  // A FOLDER CAN VANISH UNDER US. Never drop the member silently on All:
  // `shelfAfterRead` falls back to Folders and says so (view-state.ts rule 2).
  const survived = shelfAfterRead(
    state.shelf,
    data.folders.map((f) => f.folder_id)
  );
  if (survived.shelf !== state.shelf) {
    state.shelf = survived.shelf;
    goneFolderRef.current = survived.goneFolder;
  }
  state.visibleRows = logic.currentRows();
  const rows = state.visibleRows;

  const active = logic.activeFiles();
  const trashCount = logic.trashedFiles().length;
  const openFolderId = folderIdFrom(state.shelf);
  const openFolderName = openFolderId
    ? logic.folderName(openFolderId)
    : undefined;

  // ONE map for the strip, the More sheet and the rail, so the three can never
  // disagree about how many things a shelf holds. Recently changed is a WINDOW,
  // not a filter, so its count is the window's size — what the shelf draws.
  const shelfCounts = new Map<string, number>([
    // All's shelf id is `null`, so it keys on the band's own root name.
    [countKey(null), active.length],
    [RECENT, Math.min(active.length, RECENT_WINDOW)],
    [FOLDERS, data.folders.length],
    [STARRED, active.filter((f) => f.starred).length],
    [TRASH, trashCount],
  ]);

  // Asks about the DESTINATION, not whether a query is typed: the field has to
  // be there BEFORE anything is.
  const onSearchShelf = state.shelf === SEARCH;
  // Boxes appear once anything is picked, so the next one can be picked beside
  // it. Neither this nor `Select` may put an empty box on every row of a drive
  // nobody is selecting on.
  const showBoxes = state.selecting || state.selected.size > 0;
  const searching = Boolean(state.search.trim());
  // THE SEARCH SHELF IS NOT THE DRIVE WITH A FIELD ON TOP. It paints the row
  // set only once there is a query; on the resting shelf everything `onDrive`
  // gates would answer a question nobody asked.
  const onDrive =
    showsDrive(state.shelf) && !state.search.trim() && !onSearchShelf;
  // Wider than `onDrive` on purpose: Folders draws a set too. Same two
  // exclusions, because neither has a set of this shelf's to arrange.
  const arrangeable =
    showsViewToggle(state.shelf) && !state.search.trim() && !onSearchShelf;
  // Any shelf that paints a row set.
  const selectable = allowsSelection(state.shelf) && (onDrive || searching);
  // MAY THE RAIL BE DOCKED HERE? Needs documents to point at and width for a
  // 308px column. Narrow keeps the drawer, opened from a row's menu → Details.
  const railable = !narrow && (onDrive || searching);

  // This drive projects ONE vault with no per-document owner, so the column says
  // so in second person rather than inventing a name. A shared space turns this
  // constant into a per-row lookup; the column and comparator are already here.
  const driveOwner = { name: "you", initial: "Y" };

  // `canWrite` is the SHELL'S answer, read and never inferred from a failed
  // write: a member should learn this before pressing Rename, not from it.
  const primaryScope = mountedScopes()[0];
  const readOnlyScope =
    primaryScope && !primaryScope.canWrite ? primaryScope.label : null;

  // The column heads' own words, so both controls name the same four orders.
  // ──── what the view may SAY about itself (view-state.ts, §4.6, §11) ────
  // "Nothing is empty until a read has landed" and "offline is READ, never
  // invented" are each one call, never inline.
  const offline =
    libraryReachability({
      hostStatus: rootElRef.current?.dataset.gatewayStatus ?? null,
      readFailed: readFailedState,
    }) === "unreachable";

  const emptyView = emptyStateView({
    loaded,
    count: rows.length,
    shelf: state.shelf,
    ...(searching ? { query: state.search } : {}),
    ...(filtersActive(state.filters) ? { filtered: true } : {}),
    ...(openFolderName ? { folderName: openFolderName } : {}),
    ...(active.length === 0 ? { driveIsEmpty: true } : {}),
    // The new-folder editor stands in the shelf's place, so the shelf is not
    // the thing with nothing in it.
    ...(state.creatingFolder ? { suppressed: true } : {}),
  });

  const clearSearch = useCallback(() => {
    if (searchInputRef.current) searchInputRef.current.value = "";
    state.searchSeq += 1;
    state.search = "";
    state.searchResults = null;
    state.searchStatus = "resting";
    bump();
  }, [state]);

  /**
   * Types INTO the field on the member's behalf and runs the same debounced read
   * a keystroke would — never a private shortcut the field would disagree with.
   */
  const runQuery = useCallback(
    (value: string) => {
      const input = searchInputRef.current;
      if (input) {
        input.value = value;
        input.focus();
      }
      handleSearchInput();
    },
    [handleSearchInput]
  );

  /**
   * `applySearch` short-circuits when the field equals `state.search`, so a retry
   * must drop the remembered query first: the field keeps the words, the next
   * read sees them as new.
   */
  const retrySearch = useCallback(() => {
    state.search = "";
    handleSearchInput();
  }, [handleSearchInput, state]);

  const clearFilters = useCallback(() => {
    state.filters = NO_FILTERS;
    logic.clearSelection();
    bump();
  }, [logic, state]);

  const selectFilter = useCallback(
    (axis: keyof DriveFilters, option: string | null) => {
      state.filters = { ...state.filters, [axis]: option };
      logic.clearSelection();
      bump();
    },
    [logic, state]
  );

  // Only where this app can actually perform it: a variant whose route has not
  // landed returns nothing and draws no button, rather than dead-ending.
  const emptyRunFor = useCallback(
    (label: string): (() => void) | undefined => {
      if (label === "Upload documents") return () => uploadRef.current?.click();
      if (label === "Clear the query") return clearSearch;
      if (label === "Clear filters") return clearFilters;
      return undefined;
    },
    [clearFilters, clearSearch]
  );

  const inTrash = state.shelf === TRASH && !searching;
  const trashed = inTrash;
  const showFoot =
    state.driveTruncated && !searching && state.shelf !== STARRED;
  // Absent until the roster is READ (#825): a sheet over an unread roster says
  // "nobody yet" about a vault full of people.
  const handleShareStatus = (message: string): void => {
    publishOutcome(frame, { text: message });
  };
  const shareHost: DocsShareHost | null = audiences
    ? {
        audiences,
        onStatus: handleShareStatus,
      }
    : null;

  // ──── slots ────

  const folderList = (
    <FolderList
      folders={data.folders}
      activeDocs={active}
      shelf={state.shelf}
      renamingFolderId={state.renamingFolderId}
      creatingFolder={state.creatingFolder}
      onSelectShelf={selectShelf}
      onShareFolder={setShareFolder}
      residentFolderIds={residentFolderIds}
      onSaveFolder={saveFolderToMyVault}
      onStartRename={handleStartRenameFolder}
      onDeleteFolder={handleDeleteFolder}
      onRenameCommit={handleRenameFolder}
      onRenameCancel={handleCancelRenameFolder}
      onCreateCommit={handleCreateFolder}
      onCreateCancel={handleCancelCreateFolder}
    />
  );
  const storage = <Storage docs={active} truncated={state.driveTruncated} />;

  // BOTH `narrow` (this app's pane) and `compact` (the SHELL's form factor) must
  // be read: only the shell honours a band claim, so reading the pane alone drops
  // the strip where the shell did not go compact — no strip, no band, six shelves
  // reachable from nowhere. A layout signal may hide a navigation only where it
  // knows the replacement rendered. ONE function decides which surface carries
  // the shelves, so "a destination existing only in the rail is a defect" holds
  // by construction.
  const seat = navSeat({ narrow, compact });
  /** The frame is carrying the shelves; the app bar drops its Search here. */
  const handedOff = seat === "band";
  const shelfStrip =
    seat === "strip" ? (
      <ShelfStrip
        shelf={state.shelf}
        counts={shelfCounts}
        onSelect={selectShelf}
        narrow={narrow}
      />
    ) : null;
  // THE RAIL DRAWS WHERE THE STRIP DREW — here, every route: off-strip
  // destinations draw no breadcrumb, so a rail that withdrew there strands the
  // member. No row is current there, which is honest. The one gate is the DENIED
  // SEAT, where every door opens onto the same panel.
  const navRail =
    seat === "rail" && !consent ? (
      <NavRail
        label="Docs"
        items={docsNavRail({
          shelf: state.shelf,
          counts: shelfCounts,
          folders: data.folders,
          activeDocs: active,
          onSelect: selectShelf,
        })}
      />
    ) : null;
  const moreSheet = moreOpen ? (
    <MoreSheet
      shelf={state.shelf}
      counts={shelfCounts}
      onSelect={selectShelf}
      onClose={() => setMoreOpen(false)}
    />
  ) : null;
  const newMenu = state.newMenuOpen ? (
    <NewMenu
      onUpload={handleTriggerUpload}
      onNewFolder={handleStartCreateFolder}
    />
  ) : null;
  // A browser downloads one file per gesture, so a multi-selection has nothing
  // honest to offer — stand down rather than call the first row "the download".
  const soleSelected =
    state.selected.size === 1
      ? rows.find((d) => state.selected.has(d.document_id))
      : undefined;
  const bulkBar =
    state.selected.size > 0 ? (
      <BulkBar
        n={state.selected.size}
        inTrash={inTrash}
        narrow={narrow}
        allStarred={logic.selectionAllStarred()}
        {...(soleSelected?.content_uri
          ? {
              downloadHref: {
                href: soleSelected.content_uri,
                name: soleSelected.title ?? "file",
              },
            }
          : {})}
        onStar={handleStarSelected}
        onRestore={handleRestoreSelected}
        onMoveTo={handleMoveSelected}
        onTrashSelected={handleTrashSelected}
        onClear={handleClearSelected}
      />
    ) : null;

  // ONE ROW, TWO STATES: selection and arrangement are the SAME slot, so picking
  // swaps what the row carries rather than raising a second bar. AN EMPTY BAND IS
  // CHROME, so the row is null where neither state carries anything. The rail
  // toggle rides the arrangement state, only where a rail could dock.
  const toggleRail = (): void => {
    if (state.detailsId) {
      handleCloseDetails();
      return;
    }
    // The row already pointed at, else the first: a toggle that opened on
    // nothing would sometimes do nothing, and an empty rail says less than none.
    const target =
      rows.find((d) => state.selected.has(d.document_id)) ?? rows[0];
    if (target) handleOpenDetails(target.document_id);
  };
  // The rail follows a row that ends up PICKED, never one being let go:
  // deselecting the last row leaves the rail on what it was showing, because
  // having stopped pointing at something is not asking about nothing (§8).
  const pickRow = (id: string, index: number, shift: boolean): void => {
    handleToggleSelect(id, index, shift);
    if (railable && state.detailsId !== null && state.selected.has(id))
      handleOpenDetails(id);
  };
  const toolbar =
    bulkBar ??
    (arrangeable || searching ? (
      <>
        {railable ? (
          <InfoToggle on={state.detailsId !== null} onToggle={toggleRail} />
        ) : null}
        <ViewToggle view={state.view} onSelectView={selectView} />
      </>
    ) : null);

  // ──── the route switch ────
  // ONE BRANCH PER ROUTE, each body in its own component: the orchestrator picks
  // WHICH screen, the component decides what it looks like.
  //
  // The boot skeleton sits ABOVE the switch — "a read has not landed" is a fact
  // about the read, not the shelf (view-state.ts rule 1). The EMPTY block does
  // not: each §4.6 variant is a state of one screen, so `emptyStateView`'s
  // verdict travels INTO the route body.
  const versionsDoc = state.versionsId
    ? data.documents.find((d) => d.document_id === state.versionsId)
    : null;

  let routeBody: ReactNode;
  if (!loaded) {
    routeBody = (
      <div className={styles.listwrap}>
        <div ref={skeletonRef} />
      </div>
    );
  } else if (versionsDoc) {
    routeBody = (
      <VersionsRoute
        doc={versionsDoc}
        loadHistory={logic.loadHistory}
        loadActivity={logic.loadActivity}
        onRestoreVersion={handleRestoreVersion}
        onSelectShelf={selectShelf}
        onClose={handleCloseVersions}
      />
    );
  } else if (state.shelf === FOLDERS && !searching) {
    routeBody = (
      <FoldersRoute
        folders={data.folders}
        activeDocs={active}
        goneFolder={goneFolderRef.current}
        narrow={state.narrow}
        view={state.view}
        crumbs={crumbsFor(state.shelf)}
        onSelectShelf={selectShelf}
      />
    );
  } else if (state.shelf === CAPABILITIES && !searching) {
    routeBody = <CapabilitiesRoute />;
  } else if (state.shelf === NEWDOC && !searching) {
    routeBody = (
      <NewDocRoute
        narrow={state.narrow}
        onUpload={handleTriggerUpload}
        onNewFolder={handleStartCreateFolder}
      />
    );
  } else if (state.shelf === SCAN && !searching) {
    routeBody = (
      <ScanRoute narrow={state.narrow} onUpload={handleTriggerUpload} />
    );
  } else if (state.shelf === STORAGE && !searching) {
    routeBody = (
      <StorageRoute docs={data.documents} truncated={state.driveTruncated} />
    );
  } else if (state.shelf === FILING && !searching) {
    routeBody = <FilingRoute />;
  } else if (state.shelf === NAMES && !searching) {
    routeBody = <NamesRoute />;
  } else if (state.shelf === LOCKER && !searching) {
    routeBody = <LockerBoundaryRoute />;
  } else {
    routeBody = (
      <DriveRoute
        shelf={state.shelf}
        crumbs={crumbsFor(state.shelf, {
          ...(openFolderName ? { folderName: openFolderName } : {}),
          searching,
        })}
        onSelectShelf={selectShelf}
        rows={rows}
        view={state.view}
        narrow={state.narrow}
        search={state.search}
        trashed={trashed}
        offline={offline}
        filters={state.filters}
        // The SAME set the current screen draws from, so the People axis
        // offers the audiences these rows actually name.
        filterRows={searching ? (state.searchResults ?? []) : data.documents}
        onSelectFilter={selectFilter}
        onClearFilters={clearFilters}
        caption={captionFor(state.shelf, {
          offline,
          ...(openFolderName ? { folderName: openFolderName } : {}),
        })}
        empty={emptyView}
        emptyRunFor={emptyRunFor}
        selectedIds={state.selected}
        driveWindow={state.driveWindow}
        showFoot={showFoot}
        windowFailed={readFailedState}
        folderName={logic.folderName}
        onOpenDetails={handleOpenDetails}
        onOpenQuick={handleOpenQuick}
        onToggleSelect={pickRow}
        onToggleAll={handleToggleAllVisible}
        onOpenMenu={handleOpenDocMenu}
        onRestore={handleRestoreDoc}
        onShowMore={handleShowMoreDocs}
        sortKey={state.sortKey}
        sortDir={state.sortDir}
        onSortBy={onSortBy}
        onOpenSortMenu={onOpenSortMenu}
        selecting={showBoxes}
        owner={driveOwner}
      />
    );
  }

  // ABOVE whatever the route drew, and ONCE: it changes what every route body
  // below it can promise (§11).
  const scroll = (
    <>
      {offline && loaded ? (
        <OfflineBanner onRetry={() => void core.refresh()} />
      ) : null}
      {/* The two SEAT states (§12). They change what every control below them
          can promise, so each is stated once for the whole screen rather than
          discovered one refusing button at a time. */}
      {consent ? (
        <PermissionPanel />
      ) : readOnlyScope ? (
        <ReadOnlyPanel label={readOnlyScope} />
      ) : null}
      {/* The upload queue stands ABOVE the route, on the same terms as the
          banner: it is news about the drive, not a replacement for it. */}
      <UploadQueue
        items={state.uploadQueue}
        onDismiss={() => {
          state.uploadQueue = [];
          bump();
        }}
      />
      {/* THE FIELD IS THE SEARCH SHELF'S FIRST BLOCK, not chrome above every
          shelf (components/SearchField.tsx, and the handoff's own
          `fieldBlock` — the first thing the docs `search` scene pushes). It
          sits inside the scroll host, so it takes `--content-margin` from the
          same place the breadcrumb and the rows below it do. */}
      {onSearchShelf ? (
        <>
          <SearchField
            query={state.search}
            inputRef={(el) => {
              searchInputRef.current = el;
            }}
            onInput={handleSearchInput}
            onKeyDown={onSearchKeyDown}
            onClear={clearSearch}
          />
          {/* THE FOUR STATES ARE THE SHARED ONES (issue #712 S1), rendered by
              `_shared/SearchScaffold.tsx` — the same module Photos' shelf
              renders — so two apps do not grow two grammars for "no results".
              Every string is Docs' own (`SEARCH_COPY`); the scaffold contains
              no product noun.

              The rows are the caller's children, which is why the drive is
              nested inside rather than beside: with nothing typed there is no
              row set to draw at all, and the resting panel is what the shelf
              IS. Handing the drive its own top-level slot here would put the
              whole library under a Search breadcrumb the moment the shelf
              opened. */}
          <SearchScaffold
            query={state.search}
            status={state.searchStatus}
            count={rows.length}
            scope={SEARCH_SCOPE}
            copy={SEARCH_COPY}
            examples={SEARCH_EXAMPLES}
            onQuery={runQuery}
            onClear={clearSearch}
            onRetry={retrySearch}
          >
            {searching && state.searchStatus === "ready" ? routeBody : null}
          </SearchScaffold>
        </>
      ) : (
        routeBody
      )}
    </>
  );

  const detailsDoc = state.detailsId
    ? data.documents.find((d) => d.document_id === state.detailsId)
    : null;
  const quickDoc = state.quickId
    ? data.documents.find((d) => d.document_id === state.quickId)
    : null;

  // ONE element, one set of props; `railable` picks column or drawer. Building
  // it once is what keeps the two housings from drifting into two rails.
  const detailsRail = detailsDoc ? (
    <Details
      doc={detailsDoc}
      docked={railable}
      folderName={logic.folderName}
      onClose={handleCloseDetails}
      onOpenQuick={handleOpenQuick}
      onToggleStar={handleToggleStar}
      onMove={handleOpenMovePopover}
      onTrash={handleTrashDoc}
      onRestore={handleRestoreDoc}
      onReplace={handleReplaceDocument}
      loadHistory={logic.loadHistory}
      onOpenVersions={handleOpenVersions}
      onAddTag={handleAddTag}
      onRemoveTag={handleRemoveTag}
      shareHost={shareHost}
    />
  ) : null;
  const rail = railable ? detailsRail : null;

  const overlays = (
    <>
      {railable ? null : detailsRail}
      {quickDoc ? (
        <QuickLook
          doc={quickDoc}
          rows={state.visibleRows}
          narrow={narrow}
          folderName={logic.folderName}
          onClose={handleCloseQuick}
          onStep={handleQuickStep}
          shareHost={shareHost}
          {...(quickDoc.trashed
            ? {}
            : {
                onToggleStar: () => void handleToggleStar(quickDoc),
                onRename: () => void logic.startRenameDoc(quickDoc),
                // Trash from the stage CLOSES the stage: a viewer left open
                // over a trashed row describes something no longer there.
                onTrash: () => {
                  handleCloseQuick();
                  void handleTrashDoc(quickDoc);
                },
              })}
        />
      ) : null}
      {/* THE ONE SHEET, opened over the folder. Docs no longer carries a
          share flow of its own: who may see or edit a folder is a standing
          grant, drawn by the shared kit, and every outcome lands on the
          frame's single status line (§11). */}
      {shareHost ? (
        <GrantSheet
          open={shareFolder !== null}
          onClose={() => setShareFolder(null)}
          audiences={shareHost.audiences}
          {...(shareFolder
            ? {
                subject: {
                  subjectType: "docs.folder",
                  subjectId: shareFolder.folder_id,
                  label: shareFolder.name,
                },
              }
            : {})}
          onStatus={handleShareStatus}
        />
      ) : null}
    </>
  );

  // ──── what Docs contributes to the FRAME (frame.tsx, §1.4, §11) ────
  //
  // Called from EFFECTS, never during render: the bar and band render ABOVE this
  // app, so contributing while rendering updates a component already painting.
  //
  // THE BAR CARRIES THE VERB, because on this seat nothing else can — Docs' own
  // "+ New" sidebar is `display: none` inline, so withholding `onPrimary` leaves
  // no way to bring a document in. The verb is the SHELF'S, named by
  // `primaryLabel`. `onSearch` stays withheld: the query lives in this app's own
  // topbar field, so a bar button is a second control for no second destination.
  const onPrimary = useCallback(() => {
    if (state.shelf === FOLDERS) handleStartCreateFolder();
    else handleTriggerUpload();
  }, [state, handleStartCreateFolder, handleTriggerUpload]);

  // LEAVING THE MODE CLEARS THE SELECTION: ticked rows nobody can see are rows
  // the next command acts on by surprise.
  const onToggleSelecting = useCallback(() => {
    state.selecting = !state.selecting;
    if (!state.selecting) logic.clearSelection();
    bump();
  }, [state, logic]);
  const barCountValue = onDrive || searching ? rows.length : null;
  useEffect(() => {
    frame.setAppBar(
      appBar({
        shelf: state.shelf,
        ...(openFolderName ? { folderName: openFolderName } : {}),
        count: barCountValue,
        // Only where the band carries one: an unhonoured claim would take the
        // entry point away and put nothing back.
        compact: handedOff,
        onSearch: openSearch,
        onPrimary,
        // Only where there is a row set to select from: Folders lists labels.
        ...(selectable
          ? { onToggleSelecting, selecting: state.selecting }
          : {}),
      })
    );
    // `state` is a mutable bag in a ref, so depend on the derived values above,
    // never on the object they were read from.
  }, [
    frame,
    state.shelf,
    state.selecting,
    openFolderName,
    barCountValue,
    handedOff,
    openSearch,
    onPrimary,
    selectable,
    onToggleSelecting,
  ]);

  useEffect(() => {
    if (!narrow) {
      frame.claimBand(null);
      return;
    }
    frame.claimBand(
      bandClaim(
        state.shelf,
        (segment) => {
          // Search IS a screen, so the band's Search tab navigates to it like
          // every other destination.
          if (segment === "search") {
            openSearch();
            return;
          }
          selectShelf(shelfFromSegment(segment));
        },
        () => setMoreOpen((open) => !open)
      )
    );
  }, [frame, state.shelf, narrow, selectShelf, openSearch]);

  // Hand the bar and band back when Docs stops being the route.
  useEffect(() => {
    return () => {
      frame.setAppBar(null);
      frame.claimBand(null);
    };
  }, [frame]);

  return (
    // Fill the app pane so the inline chrome gets real width; otherwise it
    // collapses to content width and the narrow observer flips to the drawer.
    <div
      ref={setRoot}
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
      }}
    >
      <Chrome
        narrow={narrow}
        ready={ready}
        sideOpen={sideOpen}
        newMenuOpen={state.newMenuOpen}
        consent={consent}
        selecting={bulkBar !== null}
        dropVisible={dropVisible}
        dropTarget={dropTarget}
        onCloseSide={() => setSideOpen(false)}
        onToggleNewMenu={toggleNewMenu}
        onUploadChange={onUploadChange}
        uploadRef={(el) => {
          uploadRef.current = el;
        }}
        slots={{
          toolbar,
          shelfStrip,
          navRail,
          folderList,
          storage,
          newMenu,
          scroll,
          rail,
          overlays,
          moreSheet,
        }}
      />
    </div>
  );
}
