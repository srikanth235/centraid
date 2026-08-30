// governance: allow-repo-hygiene file-size-limit — this file holds the app's
// whole orchestration as one React tree by design (#505).
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
import { MoreSheet } from "../_shared/MoreSheet.tsx";
import { navSeat } from "../_shared/nav-seat.ts";
import { NavRail } from "../_shared/NavRail.tsx";
import { mountedScopes } from "../_shared/scope-kit.ts";
import { SearchScaffold } from "../_shared/SearchScaffold.tsx";
import { SAVED_TO_MY_VAULT } from "../_shared/shared-copy.ts";
import { ShelfStrip } from "../_shared/ShelfStrip.tsx";
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
import { NewDocRoute } from "./components/NewDocRoute.tsx";
import { NewMenu } from "./components/NewMenu.tsx";
import { QuickLook } from "./components/QuickLook.tsx";
import { ScanRoute } from "./components/ScanRoute.tsx";
import { SearchField } from "./components/SearchField.tsx";
import { PermissionPanel, ReadOnlyPanel } from "./components/SeatStates.tsx";
import { OfflineBanner } from "./components/Shared.tsx";
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
  DSHELVES,
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
  stripShelf,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { AppData, AppState, DriveDoc, Folder, SortKey } from "./types.ts";
import { captionFor, MORE_FOOTER, MORE_ROWS, MORE_TITLE } from "./view-copy.ts";
import {
  emptyStateView,
  libraryReachability,
  shelfAfterRead,
} from "./view-state.ts";

import styles from "./Chrome.module.css";

// Re-derived when a change names one of these, or names none.
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
    // The order the status line names.
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

// One ref: nav needs logic.clearSelection and logic needs nav.openQuick.
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
  // State, not the ref below: banner and caption render from it.
  const [readFailedState, setReadFailedState] = useState(false);
  const [consent, setConsent] = useState<{ message: string } | null>(null);
  const [dropVisible, setDropVisible] = useState(false);
  const [dropTarget, setDropTarget] = useState("");
  const [shareFolder, setShareFolder] = useState<Folder | null>(null);
  // `null` = unread/unreadable, not empty — share needs an answer; empty is one.
  const [audiences, setAudiences] = useState<
    readonly GrantAudienceOption[] | null
  >(null);
  const [moreOpen, setMoreOpen] = useState(false);

  const [residentFolderIds, setResidentFolderIds] = useState<Set<string>>(
    () => new Set()
  );

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const skeletonRef = useRef<HTMLDivElement | null>(null);
  const readFailedRef = useRef(false);
  // Set during the render that performs the move — a render-phase write no
  // `setState` may do (view-state.ts rule 2).
  const goneFolderRef = useRef(false);

  const dataRef = useRef<AppData>({
    folders: [],
    documents: [],
    root_folder_id: null,
  });
  const stateRef = useRef<AppState>(makeState(initialView(null)));
  const coreRef = useRef<Core | null>(null);

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
      // Debounce can outlive the shelf — a missing field means a stale query.
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
        // A throw is not an empty result set; falling through would claim
        // "nothing matches" unverified.
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
  // Opening a row opens the stage, never a text-only fork (§1.8, §7).
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

  // Every navigation clears what was open over it (§1.1).
  const selectShelf = useCallback(
    (shelf: ShelfId) => {
      // A query left behind shows search rows under the wrong breadcrumb.
      if (shelf !== SEARCH && state.search) {
        if (searchInputRef.current) searchInputRef.current.value = "";
        state.searchSeq += 1;
        state.search = "";
        state.searchResults = null;
        state.searchStatus = "resting";
      }
      nav.selectShelf(shelf);
      goneFolderRef.current = false;
      // Mode must go with the ticks nav.selectShelf dropped, or the next
      // shelf opens with stray checkboxes.
      state.selecting = false;
      setMoreOpen(false);
      setSideOpen(false);
    },
    [nav, state]
  );

  /** Focus the field next frame — it does not exist until this nav renders. */
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

  // Same column reverses; a new one takes its own natural direction.
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

  // Shared popover: one menu open, one Escape closes it.
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
              // Trailing tick, never a leading dot: labels keep one edge.
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

  // Seed narrow before first paint — observeWidth is post-paint. `.side` gated on `ready` so this snap does not animate.
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

  // THE ROSTER IS READ ONCE: three surfaces would otherwise ask People three times.
  useEffect(() => {
    if (!ready || !grantPlaneAvailable()) return;
    let active = true;
    void readGrantAudiences().then((read) => {
      if (!active) return;
      // An unreadable roster is not an empty one; docsRosterAnswer keeps
      // the two apart.
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

  // Containers carry no JSX children, so React reconciliation never clobbers
  // these imperative kit writes.
  useEffect(() => {
    if (!loaded && skeletonRef.current) showSkeleton(skeletonRef.current, 6);
  }, [loaded]);

  // A folder can vanish: `shelfAfterRead` falls back to Folders and says so (view-state.ts rule 2).
  const survived = shelfAfterRead(
    state.shelf,
    data.folders.map((f) => f.folder_id)
  );
  if (survived.shelf !== state.shelf) {
    state.shelf = survived.shelf;
    goneFolderRef.current = survived.goneFolder;
  }
  state.visibleRows = logic.currentRows();
  logic.pruneVisibleSelection();
  const rows = state.visibleRows;

  const active = logic.activeFiles();
  const trashCount = logic.trashedFiles().length;
  const openFolderId = folderIdFrom(state.shelf);
  const openFolderName = openFolderId
    ? logic.folderName(openFolderId)
    : undefined;

  // One map for strip, More sheet, and rail. Recent is a window, not a filter.
  const shelfCounts = new Map<string, number>([
    [countKey(null), active.length],
    [RECENT, Math.min(active.length, RECENT_WINDOW)],
    [FOLDERS, data.folders.length],
    [STARRED, active.filter((f) => f.starred).length],
    [TRASH, trashCount],
  ]);

  const onSearchShelf = state.shelf === SEARCH;
  const showBoxes = state.selecting || state.selected.size > 0;
  const searching = Boolean(state.search.trim());
  // Resting search must not answer drive questions.
  const onDrive =
    showsDrive(state.shelf) && !state.search.trim() && !onSearchShelf;
  const arrangeable =
    showsViewToggle(state.shelf) && !state.search.trim() && !onSearchShelf;
  const selectable = allowsSelection(state.shelf) && (onDrive || searching);
  const railable = !narrow && (onDrive || searching);

  const driveOwner = { name: "you", initial: "Y" };

  const primaryScope = mountedScopes()[0];
  const readOnlyScope =
    primaryScope && !primaryScope.canWrite ? primaryScope.label : null;

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
    // The new-folder editor stands in the shelf's place, so it is not "empty".
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

  /** Type into the field and run the same debounced read a keystroke would. */
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

  /** Drop the remembered query first: applySearch short-circuits on equality. */
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

  // Only where this app can perform it; unroutable labels draw no button.
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
  // Absent until the roster is READ (#825).
  const handleShareStatus = (message: string): void => {
    publishOutcome(frame, { text: message });
  };
  const shareHost: DocsShareHost | null = audiences
    ? {
        audiences,
        onStatus: handleShareStatus,
      }
    : null;

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

  // Read both `narrow` (pane) and `compact` (shell); only the shell honours a band claim.
  const seat = navSeat({ narrow, compact });
  const handedOff = seat === "band";
  const shelfStrip =
    seat === "strip" ? (
      <ShelfStrip
        shelves={DSHELVES}
        current={stripShelf(state.shelf)}
        counts={shelfCounts}
        onSelect={selectShelf}
        narrow={narrow}
      />
    ) : null;
  // Rail draws where the strip drew; the denied seat gates it off.
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
  // The band's sixth slot, drawn by the ONE shared sheet (#883 B9). Docs owns
  // the TABLE: which rows are live, and the count-plus-rule the meta reads.
  const moreSheet = moreOpen ? (
    <MoreSheet
      label={MORE_TITLE}
      rows={MORE_ROWS.filter((row) => row.live).map((row) => {
        const count =
          typeof row.shelf === "string"
            ? shelfCounts.get(row.shelf)
            : undefined;
        const meta =
          count === undefined
            ? row.meta
            : row.meta
              ? `${count} · ${row.meta}`
              : String(count);
        return {
          key: row.label,
          label: row.label,
          ...(meta === undefined ? {} : { meta }),
          ...(row.shelf === state.shelf ? { current: true } : {}),
          select: () => selectShelf(row.shelf),
        };
      })}
      footer={MORE_FOOTER}
      onClose={() => setMoreOpen(false)}
    />
  ) : null;
  const newMenu = state.newMenuOpen ? (
    <NewMenu
      onUpload={handleTriggerUpload}
      onNewFolder={handleStartCreateFolder}
    />
  ) : null;
  // A browser downloads one file per gesture — stand down for multi-selection.
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

  // ONE ROW, TWO STATES: selection and arrangement share this slot; null when
  // neither carries anything. The rail toggle rides arrangement state.
  const toggleRail = (): void => {
    if (state.detailsId) {
      handleCloseDetails();
      return;
    }
    // Pointed-at row, else first: a toggle that opens on nothing does nothing.
    const target =
      rows.find((d) => state.selected.has(d.document_id)) ?? rows[0];
    if (target) handleOpenDetails(target.document_id);
  };
  // The rail follows a row being PICKED, never one being let go (§8).
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

  // One branch per route; each body in its own component. The boot skeleton
  // sits ABOVE the switch (view-state.ts rule 1); emptiness is decided inside
  // each route body by `emptyStateView`.
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
        // The SAME set the screen draws from, so the People axis offers
        // the audiences these rows actually name.
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

  // Above whatever the route drew, and ONCE (§11).
  const scroll = (
    <>
      {offline && loaded ? (
        <OfflineBanner onRetry={() => void core.refresh()} />
      ) : null}
      {/* The two SEAT states (§12), stated once for the whole screen. */}
      {consent ? (
        <PermissionPanel />
      ) : readOnlyScope ? (
        <ReadOnlyPanel label={readOnlyScope} />
      ) : null}
      {/* News about the drive, above the route — not a replacement for it. */}
      <UploadQueue
        items={state.uploadQueue}
        onDismiss={() => {
          state.uploadQueue = [];
          bump();
        }}
      />
      {/* THE FIELD IS THE SEARCH SHELF'S FIRST BLOCK (SearchField.tsx,
          `fieldBlock`), inside the scroll host so it takes `--page-margin`
          from the same place the rows do. */}
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
          {/* THE FOUR STATES ARE THE SHARED ONES (#712 S1), rendered by
              `_shared/SearchScaffold.tsx`, with Docs' own copy (`SEARCH_COPY`).
              The drive nests INSIDE as the caller's child rows: beside it, a
              resting shelf would carry a Search breadcrumb over the library. */}
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

  // ONE element, one set of props; `railable` picks column or drawer.
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
                // Trash from the stage CLOSES the stage.
                onTrash: () => {
                  handleCloseQuick();
                  void handleTrashDoc(quickDoc);
                },
              })}
        />
      ) : null}
      {/* THE ONE SHEET, opened over the folder. Docs carries no share flow of
          its own; outcomes land on the frame's status line (§11). */}
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

  // Frame contribution from effects, never during render. Bar carries the verb;
  // withhold `onSearch` — the query lives in the app's own field.
  const onPrimary = useCallback(() => {
    if (state.shelf === FOLDERS) handleStartCreateFolder();
    else handleTriggerUpload();
  }, [state, handleStartCreateFolder, handleTriggerUpload]);

  // Leaving select mode clears the selection — hidden ticks would surprise the next command.
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
        // Claim honoured only where the band carries one.
        compact: handedOff,
        onSearch: openSearch,
        onPrimary,
        ...(selectable
          ? { onToggleSelecting, selecting: state.selecting }
          : {}),
      })
    );
    // `state` is a mutable bag in a ref: depend on the derived values above.
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
