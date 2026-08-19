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
  openPopover,
  popItem,
  readFailed,
  showSkeleton,
} from "@centraid/design/elements";

import { publishOutcome } from "../_shared/app-frame.tsx";
import { loadGrantAudiences } from "../_shared/grant-audiences.ts";
import { grantPlaneAvailable } from "../_shared/grant-gateway.ts";
import type { GrantAudienceOption } from "../_shared/grant-plane.ts";
import { GrantSheet } from "../_shared/GrantSheet.tsx";
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
import type { DocsShareHost } from "./grant-audiences.ts";
import { createLogic } from "./logic.ts";
import { createNav } from "./nav.ts";
import {
  CAPABILITIES,
  FILING,
  FOLDERS,
  LOCKER,
  NAMES,
  NEWDOC,
  SCAN,
  SEARCH,
  STARRED,
  STORAGE,
  TRASH,
  allowsSelection,
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
    // The drive opens on last change, newest first — the order the status line
    // names and the one the Recently changed shelf is a filtered view of.
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
  // A read that actually came back FAILED — the only evidence this app has for
  // "the gateway is out of reach" (view-state.ts `libraryReachability`). State
  // rather than the ref below, because the banner, the caption and every row's
  // state slot are rendered from it.
  const [readFailedState, setReadFailedState] = useState(false);
  const [consent, setConsent] = useState<{ message: string } | null>(null);
  const [dropVisible, setDropVisible] = useState(false);
  const [dropTarget, setDropTarget] = useState("");
  const [shareFolder, setShareFolder] = useState<Folder | null>(null);
  // `null` is "the roster has not been read yet", which is not the same fact
  // as a vault that knows nobody — Share is offered only once it IS an answer.
  const [audiences, setAudiences] = useState<
    readonly GrantAudienceOption[] | null
  >(null);
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
      // Same reason as `nav.ts`: the field belongs to the Search shelf, so it
      // is absent on every other one. This debounce can still be in flight
      // when the member navigates away, and a missing field means there is no
      // query left to apply.
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
      // The read is in flight, and the shelf says so in a DETERMINATE line
      // over whatever it already has — never a spinner.
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
        // A THROW IS NOT AN EMPTY RESULT SET. The index lives on the gateway;
        // if it could not be asked, the shelf says that and offers a retry
        // rather than printing "nothing matches", which would be a claim
        // nobody verified. This used to fall through to `rows = []` and the
        // two outcomes were indistinguishable on screen.
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
  // OPENING A ROW OPENS THE STAGE (§1.8, §7). It used to be a fork: text left
  // the drive for a reading SCREEN of its own, and every other kind opened on
  // the stage. §1.8's rule is about the SHEET, not about the screen — "text
  // renders on paper, capped at a 34em measure" — and the stage keeps that
  // rule literally: `QuickLookText` stands paper on the theater ground. What
  // the fork cost was everything around the sheet: text was the one kind a
  // member could not step through with the arrows, could not see the
  // properties of without going somewhere else, and had to back out of rather
  // than close.
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

  // Wrap nav.selectShelf so a shelf change also closes the React drawer and
  // the band's More sheet — every navigation inside Docs clears what was open
  // over it (spec §1.1's `dgo`/`dgoFromMore`).
  const selectShelf = useCallback(
    (shelf: ShelfId) => {
      // THE QUERY BELONGS TO THE SEARCH SHELF and does not follow the member
      // off it. `currentRows` answers with the vault's flat FTS matches
      // whenever `state.search` is set, on whatever shelf is open — so a query
      // left behind would make Starred, Trash and every folder show the same
      // search results under the wrong breadcrumb. It used to be impossible to
      // leave one behind, because the field was chrome the member could see
      // from anywhere; now that the field lives on one shelf, leaving is what
      // clears it.
      if (shelf !== SEARCH && state.search) {
        if (searchInputRef.current) searchInputRef.current.value = "";
        state.searchSeq += 1;
        state.search = "";
        state.searchResults = null;
        state.searchStatus = "resting";
      }
      nav.selectShelf(shelf);
      goneFolderRef.current = false;
      // Selection is scoped to the set it was entered over. `nav.selectShelf`
      // already drops what was ticked; the MODE has to go with it, or the next
      // shelf opens with a column of boxes nobody asked for.
      state.selecting = false;
      setMoreOpen(false);
      setSideOpen(false);
    },
    [nav, state]
  );

  /**
   * The way IN to search, from the app bar's Search control (frame.tsx) and
   * from the compact band's Search tab. Both land on the shelf and put the
   * caret in its field — Photos' `onSearch: () => navigateTo(SEARCH)` plus the
   * focus the band used to do by hand, now that there is a field to focus that
   * is not chrome.
   *
   * The focus is deferred one frame because the field does not exist until
   * this navigation has rendered.
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

  // Pressing a column head: the same column reverses, a different one takes
  // over at ITS OWN natural direction. A name wants A→Z; a size, a date and a
  // kind want the biggest, the newest and the ones you have most of first, and
  // starting them ascending would make every member's first press a correction.
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

  // The named orders (`SORT_OPTIONS`), anchored to the head's own button. A
  // plain DOM popover, the same one the row kebab and "Move to…" use, so there
  // is one popover in the app at a time and one Escape that closes it.
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
              // The tick marks the order the drive is in — the menu reports
              // the state as well as setting it, so it is never a list of five
              // things one of which mysteriously already happened.
              //
              // TRAILING, AND A TICK. It was a leading accent dot, which put
              // the mark on the edge every label starts from and pushed the
              // other four rows' text past it. The handoff's sort menu hangs
              // its `key` — `'✓'` on the chosen order — off the far edge
              // instead (`keyCss: 'flex:none;font:var(--section)'`), so the
              // labels keep one edge and "which one is on" is answered at the
              // other.
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

  // THE ROSTER IS READ ONCE, HERE. Three surfaces open the share sheet — the
  // folder rail, the details rail and the stage — and a roster read per sheet
  // would ask People the same question three times for one app.
  useEffect(() => {
    if (!ready || !grantPlaneAvailable()) return;
    let active = true;
    void loadGrantAudiences().then((rows) => {
      if (active) setAudiences(rows);
    });
    return () => {
      active = false;
    };
  }, [ready]);

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

  // Search is a SHELF (shelves.ts), and it is the only shelf that draws a
  // field. This asks about the DESTINATION, not about whether a query happens
  // to be typed, because the field has to be there BEFORE anything is.
  const onSearchShelf = state.shelf === SEARCH;
  // WHEN THE BOXES ARE DRAWN. The handoff's rule is `showBox: !!sel` — once
  // anything is picked, every row grows a box so the next one can be picked
  // beside it. `Select` still exists in the app bar as the keyboard-and-
  // announcement way in, so the mode counts too; what neither of them does any
  // more is put an empty box on every row of a drive nobody is selecting on.
  const showBoxes = state.selecting || state.selected.size > 0;
  const searching = Boolean(state.search.trim());
  // THE SEARCH SHELF IS NOT THE DRIVE WITH A FIELD ON TOP. `showsDrive` says
  // it paints the document row set, which it does — once there is a query. On
  // the resting shelf it excludes itself, because everything `onDrive` gates
  // would otherwise answer a question nobody asked: the bar would count the
  // whole library as "3 results", the grid/list toggle would offer to arrange
  // rows that are not there, and Select would offer to pick them.
  const onDrive =
    showsDrive(state.shelf) && !state.search.trim() && !onSearchShelf;
  // WIDER THAN `onDrive`, and on purpose: Folders draws a set too, so the pair
  // means something there. Same two exclusions — a live query and the resting
  // Search shelf — because neither has a set of this shelf's to arrange.
  const arrangeable =
    showsViewToggle(state.shelf) && !state.search.trim() && !onSearchShelf;
  // Where selection is offered at all: any shelf that paints a row set.
  const selectable = allowsSelection(state.shelf) && (onDrive || searching);
  // MAY THE RAIL BE DOCKED HERE? The handoff's `showInfoBtn: !mob &&
  // (driveish || s === 'read')` — a set of documents to point at, and the
  // width for a 308px column beside it. Narrow keeps the drawer, opened the
  // way it always was: a row's menu → Details.
  const railable = !narrow && (onDrive || searching);

  // WHO THE ROWS BELONG TO. This drive projects ONE vault — the query reads no
  // per-document owner — so every row in it is the member's own, and the
  // column says so in the product's own second person rather than printing a
  // name it would have had to invent. The disc takes the same initial. The day
  // a shared space puts somebody else's documents in this set, the owner
  // becomes a per-row fact and this constant becomes a lookup; the column, its
  // head and its comparator are already in place for it.
  const driveOwner = { name: "you", initial: "Y" };

  // A space the member was placed in and may not write to (§12's `readonly`).
  // `canWrite` is the SHELL'S answer — read, never inferred from a failed
  // write, because a member should learn this before pressing Rename and not
  // from pressing it. `null` on the ordinary case: one library, writable.
  const primaryScope = mountedScopes()[0];
  const readOnlyScope =
    primaryScope && !primaryScope.canWrite ? primaryScope.label : null;

  // THE IN-PAGE TITLE AND ITS BYLINE ARE GONE (Chrome.tsx). Both restated what
  // two surfaces above them already said, and each sentence they carried has a
  // home that outlived them: the shelf's title and count are the app bar's
  // (`frame.tsx` → `shelfCopy`); trash's purge window and the folder rule are
  // captions under their own row sets (`view-copy.ts`). None of it was lost,
  // and none of it is said twice.

  // The compact button's label. The words are the column heads' own, so the
  // two controls name the same four orders rather than inventing two dialects.
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
    state.searchStatus = "resting";
    bump();
  }, [state]);

  /**
   * Type a query INTO the field on the member's behalf — what the resting
   * panel's example chips do. The chips are literal queries a member could
   * have typed, so this writes the words into the input and runs the same
   * debounced read a keystroke would, rather than taking a private shortcut
   * into the vault that the field would then disagree with.
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
   * Ask the index again for the query already in the field — the unreachable
   * panel's one control.
   *
   * `applySearch` short-circuits when the field's value equals `state.search`,
   * which is what stops every keystroke that lands back on the same string
   * from re-reading. A retry has to get past that guard, so the remembered
   * query is dropped first: the field still holds the words, and the next read
   * sees them as new.
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
  // WHAT DOCS OWES THE SHARE KIT (issue #825): the roster, and the one status
  // line. Absent until the roster has actually been read — a sheet opened over
  // an unread roster would say "nobody yet" about a vault full of people.
  const handleShareStatus = (message: string): void => {
    publishOutcome(frame, { text: message });
  };
  const shareHost: DocsShareHost | null = audiences
    ? {
        audiences,
        onStatus: handleShareStatus,
      }
    : null;

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
  // while the band says the same thing better.
  //
  // BOTH HALVES OF THAT SENTENCE HAVE TO BE TRUE AT ONCE, so both are read.
  // `narrow` is this app's own pane (< 860px, the width at which five columns
  // stop fitting); `compact` is the SHELL's form factor, and the shell honours
  // a band claim on nothing else (inline-types.ts, `claimBand`). Reading the
  // pane alone dropped the strip on a pane the shell did not consider compact
  // — no strip, no band, and six shelves reachable from nowhere. A layout
  // signal may hide a navigation only where it knows the replacement rendered.
  const handedOff = compact && narrow;
  const shelfStrip = handedOff ? null : (
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
  // Exactly one picked, and its bytes are reachable: a browser downloads one
  // file per gesture, so a multi-selection has nothing honest to offer and the
  // button stands down rather than fetching the first row and calling it "the
  // download".
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

  // THE HANDOFF'S `barRow`, above the strip — ONE ROW, TWO STATES.
  //
  // `barNormal: !sel, selOn: !!sel` (prototype, verbatim): the selection row
  // and the arrangement row are the same slot, and picking something SWAPS
  // what the row carries rather than raising a second bar somewhere else. The
  // selection bar used to be a floating accent pill below the shelf strip:
  // two bars on screen at once, the drive's own controls still sitting above
  // a row that had taken the drive over, and the picked count announced in a
  // place nothing else on the screen speaks from.
  //
  // AN EMPTY BAND IS CHROME (Photos' `toolbarCarriesSomething`), so the row is
  // null where neither state would carry anything — off the drive there are no
  // rows to arrange, and on the resting Search shelf there are no rows at all.
  //
  // THE RAIL TOGGLE RIDES THE ARRANGEMENT STATE, on the leading side of the
  // pair, and only where a rail could dock (`railable`) — the handoff's own
  // order in `barRow`, and its own two withholdings (`!mob && !sel`). While
  // something is picked this slot is the selection bar, so the question does
  // not arise.
  const toggleRail = (): void => {
    if (state.detailsId) {
      handleCloseDetails();
      return;
    }
    // WHICH ROW? The one the member has already pointed at, and otherwise the
    // first in the set — the handoff's `DDOC(this.state.dInfoId) || DDOCS[0]`.
    // A toggle that opened on nothing would be a control that sometimes does
    // nothing, and an empty rail says less than no rail.
    const target =
      rows.find((d) => state.selected.has(d.document_id)) ?? rows[0];
    if (target) handleOpenDetails(target.document_id);
  };
  // §8's CLOSING SENTENCE, MADE TRUE. The rail's own footer says "Everything
  // here is about one row. Select another and the rail follows it" — it has
  // said so since the rail was written, and until the rail could be docked it
  // was not something the app did: a modal drawer over a scrim cannot follow a
  // selection, because the set it would follow is behind the scrim.
  //
  // It follows a row that ends up PICKED, never one being let go. Deselecting
  // the last row leaves the rail on the document it was showing rather than
  // emptying it — the member has stopped pointing at something, which is not
  // the same as asking a question about nothing.
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

  // ---- the route switch ----
  //
  // ONE BRANCH PER ROUTE, and each branch's BODY lives in its own component
  // (components/DriveRoute, FoldersRoute, StorageRoute). The orchestrator decides
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
  // The document-scoped route (§6.2). It stands IN the scroll region rather
  // than over it: a version history is a spine, not something a member peers
  // at through a hole in the drive. (§6.1's reading view was the second one
  // here; it is the stage's paper sheet now.)
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
        // Unfiltered, and the SAME set the current screen draws from: search
        // results while a query is live, the whole drive otherwise. The People
        // axis offers the audiences these rows actually name.
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

  // §11's banner stands ABOVE whatever the route drew, exactly as §4.3's own
  // state panels stand above the breadcrumb — and ONCE here rather than six
  // times, because it changes what every route body below it can promise.
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

  // THE RAIL, IN WHICHEVER HOUSING THE SURFACE HAS ROOM FOR. One element, one
  // set of props; `railable` decides whether it goes into the content row as a
  // column or over the drive as a drawer. Building it once is what keeps the
  // two forms from drifting into two rails.
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
                // Trash from the stage CLOSES the stage: the document the
                // viewer is standing on has left the shelf it was opened
                // from, and a viewer left open over a trashed row is a
                // surface describing something that is no longer there.
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

  // ---- what Docs contributes to the FRAME (frame.tsx, spec §1.4, §11) ----
  //
  // Called from EFFECTS, never during render: the bar and the band render
  // ABOVE this app in the tree, so a contribution made while rendering would
  // be updating a component that is already painting.
  //
  // THE BAR NOW CARRIES THE VERB, because on this seat nothing else could.
  // `onPrimary` used to be withheld on the grounds that "Docs' own '+ New' is
  // still a dropdown anchored in the sidebar, and a second filled control in
  // the bar would be two answers to one question". That sidebar is
  // `display: none` inline (Chrome.module.css: navigation belongs to the host
  // stem), so there was no first answer either — a member on the web seat had
  // no way to bring a document in at all.
  //
  // The verb is the SHELF'S, named by `primaryLabel` and doing exactly what it
  // says: "New folder" on the Folders shelf opens the inline folder editor,
  // "New" everywhere else opens the file picker. Those are the two rows the
  // old dropdown held, split across the two places each one belongs — so the
  // menu is not reproduced in the bar, it is spent. The fuller "four ways in"
  // is the `newdoc` route, still withheld (docs/design-divergences.md).
  //
  // `onSearch` stays withheld: the query lives in this app's own topbar field,
  // in view on every pointer surface, and a bar button that only focused a
  // field already on screen is a second control for no second destination.
  const onPrimary = useCallback(() => {
    if (state.shelf === FOLDERS) handleStartCreateFolder();
    else handleTriggerUpload();
  }, [state, handleStartCreateFolder, handleTriggerUpload]);

  // LEAVING THE MODE CLEARS THE SELECTION. A set of ticked rows that nobody
  // can see is a set the next command would act on by surprise, so "Done"
  // means done rather than hidden.
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
        // The bar drops its own Search only where the band carries one
        // (frame.tsx). Same rule, same signal: an unhonoured claim would have
        // taken the entry point away and put nothing back.
        compact: handedOff,
        onSearch: openSearch,
        onPrimary,
        // Selection means nothing where no rows are painted — Folders lists
        // labels, not documents — so the verb is contributed only on the
        // shelves that have a row set to select from.
        ...(selectable
          ? { onToggleSelecting, selecting: state.selecting }
          : {}),
      })
    );
    // `state` is a mutable bag held in a ref, so the bar's dependencies are
    // the derived values above rather than the object it was read from.
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
          // Search IS a screen now — the shelf plus its own field
          // (components/SearchField.tsx) — so the band's Search tab navigates
          // to it like every other destination. It used to reach sideways and
          // focus the topbar field instead, because there was nowhere to go.
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
