// governance: allow-repo-hygiene file-size-limit — this file holds the app's whole orchestration as one React tree by design (#505); it is smaller than the served app.tsx + app-inline.tsx it replaces. Splitting it belongs to the app's own code evolution, not this migration.
// Docs — query-free React tree (issue #505). Holds the `Root` component and
// every constant, helper and type it needs that does NOT depend on the
// node-side `./queries/*` handler modules. The shell's InlineAppModule
// descriptor imports `Root` and `CHANGE_TABLES` from here and adds the query
// wiring; there is deliberately no parallel served-system-app entry.

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
  readFailed,
  showSkeleton,
} from "@centraid/design/elements";

import { publishOutcome } from "../_shared/app-frame.tsx";
import { mountedScopes } from "../_shared/scope-kit.ts";
import { SAVED_TO_MY_VAULT } from "../_shared/shared-copy.ts";
import { ShareSheet } from "../_shared/ShareSheet.tsx";
import type { InlineAppProps } from "../inline-types.ts";
import { Chrome } from "./Chrome.tsx";
import { BulkBar } from "./components/BulkBar.tsx";
import { Details } from "./components/Details.tsx";
import { DriveRoute } from "./components/DriveRoute.tsx";
import { DueRoute } from "./components/DueRoute.tsx";
import { Editor } from "./components/Editor.tsx";
import { FoldersRoute } from "./components/FoldersRoute.tsx";
import { MoreSheet } from "./components/MoreSheet.tsx";
import { NewMenu } from "./components/NewMenu.tsx";
import { QuickLook } from "./components/QuickLook.tsx";
import { Reading } from "./components/Reading.tsx";
import { OfflineBanner } from "./components/Shared.tsx";
import { ShelfStrip } from "./components/ShelfStrip.tsx";
import { FolderList, Storage } from "./components/Sidebar.tsx";
import { TagChips } from "./components/Toolbar.tsx";
import { VersionsRoute } from "./components/VersionsRoute.tsx";
import { crumbsFor } from "./drive-copy.ts";
import { NO_FILTERS, filtersActive } from "./filters.ts";
import type { DriveFilters } from "./filters.ts";
import { canRender, isTextEditable } from "./format.ts";
import { appBar, bandClaim } from "./frame.tsx";
import { createLogic } from "./logic.ts";
import { createNav } from "./nav.ts";
import {
  DUE,
  FOLDERS,
  RECENT,
  STARRED,
  TRASH,
  folderIdFrom,
  shelfFromSegment,
  showsDrive,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { AppData, AppState, DriveDoc, Folder } from "./types.ts";
import { SHELF_LABELS, captionFor } from "./view-copy.ts";
import {
  emptyStateView,
  libraryReachability,
  shelfAfterRead,
} from "./view-state.ts";

import styles from "./Chrome.module.css";

// Vault entities this app's queries read — the doorbell filter re-derives only
// when a change names one of these (or names none, i.e. "this app acted").
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
    sortKey: "added",
    sortDir: -1,
    tag: "all",
    search: "",
    searchResults: null,
    searchSeq: 0,
    selected: new Set(),
    anchorIndex: null,
    detailsId: null,
    quickId: null,
    readingId: null,
    versionsId: null,
    editingId: null,
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

// The factory pair + the two async orchestration entry points app.tsx defines,
// built once and threaded into the reused factories (mirrors app.tsx's module
// scope). Kept in one ref so the circular wiring (nav needs logic.clearSelection,
// logic needs nav.openQuick) resolves exactly as it does served.
interface Core {
  logic: ReturnType<typeof createLogic>;
  nav: ReturnType<typeof createNav>;
  refresh: () => Promise<void>;
  applySearch: () => void;
}

export function Root({ rootRef, frame }: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [narrow, setNarrow] = useState(false);
  const [ready, setReady] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  // A read that actually came back FAILED — the only evidence this app has for
  // "the gateway is out of reach" (view-state.ts `libraryReachability`). State
  // rather than the ref below, because the banner, the caption and every row's
  // state slot are rendered from it.
  const [readFailedState, setReadFailedState] = useState(false);
  const [consent, setConsent] = useState<{ message: string } | null>(null);
  const [dropVisible, setDropVisible] = useState(false);
  const [dropTarget, setDropTarget] = useState("");
  const [shareFolder, setShareFolder] = useState<Folder | null>(null);
  // The compact band's overflow sheet (§1.5). React state rather than a field
  // on the mutable `state` bag: nothing outside this component opens it.
  const [moreOpen, setMoreOpen] = useState(false);

  const [residentFolderIds, setResidentFolderIds] = useState<Set<string>>(
    () => new Set()
  );

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const skeletonRef = useRef<HTMLDivElement | null>(null);
  const flushEditorRef = useRef<(() => Promise<void>) | null>(null);
  const readFailedRef = useRef(false);
  // The member was moved off a folder that no longer exists (view-state.ts
  // rule 2). A ref, not state: it is SET during the same render that performs
  // the move (so the destination can explain itself on that very frame) and
  // cleared by the next navigation, which is a render-phase write no
  // `setState` may do.
  const goneFolderRef = useRef(false);

  const dataRef = useRef<AppData>({
    folders: [],
    documents: [],
    root_folder_id: null,
  });
  const stateRef = useRef<AppState>(makeState(initialView(null)));
  const coreRef = useRef<Core | null>(null);

  // Build the reused factories + orchestration entry points once. `render` funnels
  // to `bump` (with a popover close, matching app.tsx's render()); the per-surface
  // render entry points nav.ts calls all bump too (one tree).
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
      // Mutate `data` in place (never reassign) — logic.ts closed over this exact
      // object at boot.
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
      // The editor overlay manages its own body state after its initial fetch —
      // a background refresh never closes it out from under a typing user.
      bump();
    };
    core = { refresh } as Core;

    core.applySearch = debounce(async () => {
      const q = (
        document.querySelector("#searchInput") as HTMLInputElement
      ).value.trim();
      if (q === state.search) return;
      state.search = q;
      core.logic.clearSelection();
      if (!q) {
        state.searchResults = null;
        render();
        return;
      }
      const seq = ++state.searchSeq;
      let rows: DriveDoc[] = [];
      try {
        const res = await window.centraid.read<SearchResult>({
          query: "search",
          input: { term: q },
        });
        rows = res?.documents ?? [];
      } catch {
        rows = [];
      }
      if (seq !== state.searchSeq) return;
      state.searchResults = rows;
      render();
    }, 150);

    core.nav = createNav({
      state,
      render,
      refresh: core.refresh,
      renderDetails: bump,
      renderQuick: bump,
      renderNewMenu: bump,
      renderEditor: bump,
      clearSelection: () => core.logic.clearSelection(),
    });
    core.logic = createLogic({
      state,
      data,
      render,
      refresh: core.refresh,
      openQuick: (id: string) => core.nav.openQuick(id),
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
    editDocument: handleEditDocument,
    moveSelected: handleMoveSelected,
    openDocMenu: handleOpenDocMenu,
    openMovePopover: handleOpenMovePopover,
    removeTag: handleRemoveTag,
    renameFolder: handleRenameFolder,
    replaceDocument: handleReplaceDocument,
    restoreDoc: handleRestoreDoc,
    restoreSelected: handleRestoreSelected,
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
    closeReading: handleCloseReading,
    closeVersions: handleCloseVersions,
    openVersions: handleOpenVersions,
    openDetails: handleOpenDetails,
    quickStep: handleQuickStep,
    selectTag: handleSelectTag,
    showMoreDocs: handleShowMoreDocs,
    startCreateFolder: handleStartCreateFolder,
    triggerUpload: handleTriggerUpload,
  } = nav;
  // OPENING A ROW IS A ROUTING DECISION (§1.8). Text renders on paper at a
  // 34em measure — that is the reading view, a screen. Everything else is a
  // kind for the stage, which has not landed; Quick Look remains the interim
  // viewer for those, so no member loses the ability to see their own file
  // while the stage is built.
  const handleOpenQuick = useCallback(
    (id: string) => {
      const doc = dataRef.current.documents.find((d) => d.document_id === id);
      if (doc && isTextEditable(doc)) {
        core.nav.openReading(id);
        return;
      }
      core.nav.openQuick(id);
    },
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

  // Wrap nav.selectShelf so a shelf change also closes the React drawer and
  // the band's More sheet — every navigation inside Docs clears what was open
  // over it (spec §1.1's `dgo`/`dgoFromMore`).
  const selectShelf = useCallback(
    (shelf: ShelfId) => {
      nav.selectShelf(shelf);
      goneFolderRef.current = false;
      setMoreOpen(false);
      setSideOpen(false);
    },
    [nav]
  );

  const closeEditorSafely = useCallback(async () => {
    if (flushEditorRef.current) await flushEditorRef.current();
    flushEditorRef.current = null;
    await core.refresh();
    nav.closeEditor();
  }, [core, nav]);

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

  const onSort = useCallback(() => {
    const order = ["added", "name", "size"] as const;
    if (state.sortDir === -1 && state.sortKey !== "name") {
      state.sortDir = 1;
    } else if (state.sortDir === 1) {
      state.sortDir = -1;
    } else {
      const i = order.indexOf(state.sortKey);
      const nextKey = order[(i + 1) % order.length]!;
      state.sortKey = nextKey;
      state.sortDir = nextKey === "name" ? 1 : -1;
    }
    bump();
  }, [state]);

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

  // Seed the narrow layout BEFORE the first paint (the served app sets is-narrow
  // pre-render; observeWidth in the mount effect below only fires post-paint, so
  // without this the drawer would paint as an in-flow sidebar and then slide out).
  // The `.side` transition stays gated on `ready` (set one frame later) so this
  // initial snap doesn't animate.
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
  // Enable the drawer slide transition only after the first painted frame, so
  // the mount-time narrow snap above is instant and user-driven open/close animate.
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

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
      // Outcomes go through ONE door (§11): the frame's single status line.
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

  // ---- chrome wiring: doorbell, focus, width, keys, drag/drop ----
  useEffect(() => {
    const stopDoorbell = onDataChange(CHANGE_TABLES, () => void core.refresh());
    const stopFocus = onFocusRefresh(() => void core.refresh());

    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (state.editingId) {
        if (e.key === "Escape") {
          e.preventDefault();
          void closeEditorSafely();
        }
        return;
      }
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

    // Close the "+ New" menu on any outside click (matches chrome.ts's
    // `.closest('.d-new-wrap')` guard via the data-new-wrap hook Chrome stamps).
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

    // Drag-and-drop onto the current folder.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#505)
  }, []);

  // Boot skeleton, then the real empty state — both driven with the same kit
  // DOM helpers app.tsx used (their containers carry no JSX children, so the
  // imperative writes are never clobbered by React reconciliation).
  useEffect(() => {
    if (!loaded && skeletonRef.current) showSkeleton(skeletonRef.current, 6);
  }, [loaded]);

  // ---- derive the render (app.tsx's render()/renderSidebar/renderToolbar/… ) ----

  // A FOLDER CAN VANISH UNDER US (deleted in another window). The member is
  // NOT dropped silently on All any more: `shelfAfterRead` falls them back to
  // Folders — where they reached the folder from — and says so once they are
  // there (view-state.ts rule 2).
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

  // Per-shelf counts for the strip and the More sheet — one map, so the two
  // surfaces can never disagree about how many things a shelf holds.
  const shelfCounts = new Map<string, number>([
    [FOLDERS, data.folders.length],
    [STARRED, active.filter((f) => f.starred).length],
    [TRASH, trashCount],
  ]);

  const onDrive = showsDrive(state.shelf) && !state.search.trim();
  const searching = Boolean(state.search.trim());

  let activeTitle: string;
  if (searching) activeTitle = `Results for “${state.search.trim()}”`;
  else if (openFolderName) activeTitle = openFolderName;
  else if (state.shelf === null) activeTitle = "All documents";
  else activeTitle = SHELF_LABELS[state.shelf] ?? "Docs";
  const n = rows.length;
  let activeSub: string;
  if (searching)
    activeSub = `${n} match${n === 1 ? "" : "es"} “${state.search.trim()}”`;
  else if (state.shelf === TRASH)
    activeSub = `${n} in trash · auto-purge after 30 days`;
  else if (state.shelf === RECENT) activeSub = "Newest across every folder";
  else if (state.shelf === STARRED)
    activeSub = `${n} starred document${n === 1 ? "" : "s"} · one star across your vault`;
  else if (state.shelf === FOLDERS)
    activeSub = `${data.folders.length} folder${data.folders.length === 1 ? "" : "s"} · a folder is a label, not a place`;
  else if (state.shelf === DUE) activeSub = "Dated obligations · switched off";
  else activeSub = `${n} document${n === 1 ? "" : "s"}`;

  const sortNames = { added: "Date", name: "Name", size: "Size" };
  const sortLabel = `${sortNames[state.sortKey]} ${state.sortDir === 1 ? "↑" : "↓"}`;

  const tagOptions = [
    ...new Set(active.flatMap((f) => (f.tags ?? []).map((t) => t.label))),
  ].sort();

  // ---- what the view may SAY about itself (view-state.ts, §4.6, §11) ----
  //
  // "Nothing is empty until a read has landed" and "offline is a state the app
  // READS, never one it invents" are both rules this file used to get wrong by
  // expressing them inline. Both are now one call each.
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
    // The new-folder editor is standing in the shelf's place, so the shelf is
    // not the thing with nothing in it.
    ...(state.creatingFolder ? { suppressed: true } : {}),
  });

  const clearSearch = useCallback(() => {
    if (searchInputRef.current) searchInputRef.current.value = "";
    state.searchSeq += 1;
    state.search = "";
    state.searchResults = null;
    bump();
  }, [state]);

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

  // The way forward for an empty view, BY LABEL — and only where this app can
  // actually perform it. A variant whose action is a route that has not landed
  // ("Scan a document", "Move documents here") returns nothing and the button
  // is not drawn, which is the difference between a screen that is honest
  // about what it cannot do and one that dead-ends a member.
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
  const scopes = mountedScopes();

  // ---- slots ----

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

  // The shelf strip (§1.7). It is NOT drawn on the compact form factor whose
  // band claim was honoured — the band carries the same six destinations there
  // and drawing both would put Trash in a strip that scrolls out of sight
  // while the band says the same thing better. This app cannot ask the shell
  // whether its claim was honoured, so it reads the same signal the claim
  // itself is gated on: the compact form factor.
  const shelfStrip = narrow ? null : (
    <ShelfStrip
      shelf={state.shelf}
      counts={shelfCounts}
      onSelect={selectShelf}
      narrow={narrow}
    />
  );
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
  const tagChips = (
    <TagChips tags={tagOptions} active={state.tag} onSelect={handleSelectTag} />
  );
  const bulkBar =
    state.selected.size > 0 ? (
      <BulkBar
        n={state.selected.size}
        inTrash={inTrash}
        onRestore={handleRestoreSelected}
        onMoveTo={handleMoveSelected}
        onTrashSelected={handleTrashSelected}
        onClear={handleClearSelected}
      />
    ) : null;

  // ---- the route switch ----
  //
  // ONE BRANCH PER ROUTE, and each branch's BODY lives in its own component
  // (components/DriveRoute, FoldersRoute, DueRoute). The orchestrator decides
  // WHICH screen; the component decides what that screen looks like. That
  // split is what keeps this file under the size cap and what lets the
  // remaining Docs routes land in parallel without three agents editing the
  // same switch arm.
  //
  // The boot skeleton sits ABOVE the switch, because "a read has not landed"
  // is a fact about the read and not about the shelf (view-state.ts rule 1).
  // The EMPTY block does not: §4.6's five variants are each one state of a
  // particular screen — an empty folder says a different thing from an empty
  // drive — so `emptyStateView`'s verdict travels INTO the route body, which
  // draws it in the row set's own place, under that screen's own breadcrumb
  // and caption.
  // The two document-scoped routes (§6.1, §6.2). They stand IN the scroll
  // region rather than over it: a reading view is paper and a version history
  // is a spine, and neither is something a member peers at through a hole in
  // the drive.
  const readingDoc = state.readingId
    ? data.documents.find((d) => d.document_id === state.readingId)
    : null;
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
  } else if (readingDoc) {
    routeBody = (
      <Reading
        key={readingDoc.document_id}
        doc={readingDoc}
        folderName={logic.folderName}
        {...(canRender(readingDoc) && isTextEditable(readingDoc)
          ? { onEdit: () => nav.openEditor(readingDoc.document_id) }
          : {})}
        onOpenVersions={() => handleOpenVersions(readingDoc.document_id)}
        onOpenDetails={() => handleOpenDetails(readingDoc.document_id)}
        onClose={handleCloseReading}
      />
    );
  } else if (state.shelf === FOLDERS && !searching) {
    routeBody = (
      <FoldersRoute
        folders={data.folders}
        activeDocs={active}
        goneFolder={goneFolderRef.current}
        onSelectShelf={selectShelf}
      />
    );
  } else if (state.shelf === DUE && !searching) {
    routeBody = <DueRoute />;
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
        onToggleSelect={handleToggleSelect}
        onToggleAll={handleToggleAllVisible}
        onOpenMenu={handleOpenDocMenu}
        onRestore={handleRestoreDoc}
        onShowMore={handleShowMoreDocs}
      />
    );
  }

  // §11's banner stands ABOVE whatever the route drew, exactly as §4.3's own
  // state panels stand above the breadcrumb — and ONCE here rather than six
  // times, because it changes what every route body below it can promise.
  const scroll = (
    <>
      {offline && loaded ? (
        <OfflineBanner onRetry={() => void core.refresh()} />
      ) : null}
      {routeBody}
    </>
  );

  const detailsDoc = state.detailsId
    ? data.documents.find((d) => d.document_id === state.detailsId)
    : null;
  const quickDoc = state.quickId
    ? data.documents.find((d) => d.document_id === state.quickId)
    : null;
  const editorDoc = state.editingId
    ? data.documents.find((d) => d.document_id === state.editingId)
    : null;

  const overlays = (
    <>
      {detailsDoc ? (
        <Details
          doc={detailsDoc}
          folderName={logic.folderName}
          onClose={handleCloseDetails}
          onOpenQuick={handleOpenQuick}
          onToggleStar={handleToggleStar}
          onMove={handleOpenMovePopover}
          onTrash={handleTrashDoc}
          onRestore={handleRestoreDoc}
          onEdit={(d) => nav.openEditor(d.document_id)}
          onReplace={handleReplaceDocument}
          loadHistory={logic.loadHistory}
          onOpenVersions={handleOpenVersions}
          onAddTag={handleAddTag}
          onRemoveTag={handleRemoveTag}
        />
      ) : null}
      {quickDoc ? (
        <QuickLook
          doc={quickDoc}
          rows={state.visibleRows}
          narrow={narrow}
          folderName={logic.folderName}
          onClose={handleCloseQuick}
          onStep={handleQuickStep}
        />
      ) : null}
      {editorDoc ? (
        <Editor
          key={editorDoc.document_id}
          doc={editorDoc}
          narrow={narrow}
          registerFlush={(fn) => {
            flushEditorRef.current = fn;
          }}
          onClose={closeEditorSafely}
          onSave={handleEditDocument}
        />
      ) : null}
      <ShareSheet
        open={shareFolder !== null}
        onClose={() => setShareFolder(null)}
        sourceScopeId={scopes[0]?.id ?? ""}
        scopes={scopes}
        itemType="docs.folder"
        itemIds={shareFolder ? [shareFolder.folder_id] : []}
        appLabel="Docs"
        onDone={(outcome) => publishOutcome(frame, { text: outcome.message })}
      />
    </>
  );

  // ---- what Docs contributes to the FRAME (frame.tsx, spec §1.4, §11) ----
  //
  // Called from EFFECTS, never during render: the bar and the band render
  // ABOVE this app in the tree, so a contribution made while rendering would
  // be updating a component that is already painting.
  //
  // NEITHER ACTION IS CONTRIBUTED YET, and both omissions are deliberate:
  //
  //   * `onPrimary` — the bar's filled verb per shelf is `primaryLabel`'s to
  //     name, but Docs' own "+ New" is still a dropdown anchored in the
  //     sidebar, and a second filled control in the bar would be two answers
  //     to one question. The verb moves up when the `newdoc` route lands.
  //   * `onSearch` — the query still lives in this app's own topbar field, in
  //     view on every pointer surface. A bar button that only focused a field
  //     already on screen is a second control for no second destination; it
  //     becomes real when Search is its own route.
  //
  // Until then the bar carries the title and the count, which is what the
  // frame could never say for itself.
  const barTitleValue = activeTitle;
  const barCountValue = onDrive || searching ? rows.length : null;
  useEffect(() => {
    frame.setAppBar(
      appBar({
        shelf: state.shelf,
        ...(openFolderName ? { folderName: openFolderName } : {}),
        count: barCountValue,
        compact: narrow,
      })
    );
    // `state` is a mutable bag held in a ref, so the bar's dependencies are
    // the derived values above rather than the object it was read from.
  }, [
    frame,
    state.shelf,
    openFolderName,
    barCountValue,
    narrow,
    barTitleValue,
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
          // Search is a shelf in the model (shelves.ts) but its screen has not
          // landed: today the query lives in the topbar field, so the band's
          // Search tab takes the member to the thing that actually searches
          // rather than to an empty route.
          if (segment === "search") {
            setMoreOpen(false);
            searchInputRef.current?.focus();
            return;
          }
          selectShelf(shelfFromSegment(segment));
        },
        () => setMoreOpen((open) => !open)
      )
    );
  }, [frame, state.shelf, narrow, selectShelf]);

  // Hand the bar and the band back when Docs stops being the route.
  useEffect(() => {
    return () => {
      frame.setAppBar(null);
      frame.claimBand(null);
    };
  }, [frame]);

  return (
    // Fill the app pane (a flex child of the route body) so the inline chrome gets
    // real width — otherwise it collapses to content width and the component-width
    // narrow observer wrongly flips to the phone drawer layout.
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
        view={state.view}
        newMenuOpen={state.newMenuOpen}
        consent={consent}
        activeTitle={activeTitle}
        activeSub={activeSub}
        sortLabel={sortLabel}
        showDriveTools={onDrive || searching}
        dropVisible={dropVisible}
        dropTarget={dropTarget}
        onOpenSide={() => setSideOpen(true)}
        onCloseSide={() => setSideOpen(false)}
        onToggleNewMenu={toggleNewMenu}
        onSelectView={selectView}
        onSort={onSort}
        onSearchInput={handleSearchInput}
        onSearchKeyDown={onSearchKeyDown}
        onUploadChange={onUploadChange}
        searchRef={(el) => {
          searchInputRef.current = el;
        }}
        uploadRef={(el) => {
          uploadRef.current = el;
        }}
        slots={{
          shelfStrip,
          folderList,
          storage,
          newMenu,
          tagChips,
          bulkBar,
          scroll,
          overlays,
          moreSheet,
        }}
      />
    </div>
  );
}
