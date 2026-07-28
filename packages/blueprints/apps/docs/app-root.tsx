// governance: allow-repo-hygiene file-size-limit — this file holds the app's whole orchestration as one React tree by design (#505); it is smaller than the served app.tsx + app-inline.tsx it replaces. Splitting it belongs to the app's own code evolution, not this migration.
// Docs — query-free React tree (issue #505). Holds the `Root` component and
// every constant, helper and type it needs that does NOT depend on the
// node-side `./queries/*` handler modules. The shell's InlineAppModule
// descriptor imports `Root` and `CHANGE_TABLES` from here and adds the query
// wiring; there is deliberately no parallel served-system-app entry.

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement, ReactNode } from 'react';

import type { InlineAppProps } from '../inline-types.ts';
import { Chrome } from './Chrome.tsx';
import { BulkBar } from './components/BulkBar.tsx';
import { Details } from './components/Details.tsx';
import { Editor } from './components/Editor.tsx';
import { GridCard } from './components/Grid.tsx';
import { ListHead, ListRow, WindowFoot } from './components/List.tsx';
import { NewMenu } from './components/NewMenu.tsx';
import { QuickLook } from './components/QuickLook.tsx';
import { FolderList, SmartNav, Storage } from './components/Sidebar.tsx';
import { TagChips, TypeChips } from './components/Toolbar.tsx';
import { emptyStateFor } from './format.ts';
import {
  closePopover,
  debounce,
  emptyState,
  h,
  observeWidth,
  onDataChange,
  onFocusRefresh,
  readFailed,
  showSkeleton,
  wireThemeToggle,
} from './kit.ts';
import { createLogic } from './logic.ts';
import { createNav } from './nav.ts';
import type { AppData, AppState, DriveDoc, Folder } from './types.ts';

import styles from './Chrome.module.css';

// Vault entities this app's queries read — the doorbell filter re-derives only
// when a change names one of these (or names none, i.e. "this app acted").
export const CHANGE_TABLES = [
  'core.document',
  'core.content_item',
  'core.tag',
  'core.concept',
  'core.concept_scheme',
  'core.link',
  'blob.custody_state',
  'consent.provenance',
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

const VALID_VIEWS = new Set<AppState['view']>(['grid', 'list']);

function initialView(rootEl: HTMLElement | null): AppState['view'] {
  const knob = rootEl?.dataset.appView;
  return knob && VALID_VIEWS.has(knob as AppState['view']) ? (knob as AppState['view']) : 'grid';
}

function makeState(view: AppState['view']): AppState {
  return {
    view,
    nav: { kind: 'all' },
    sortKey: 'added',
    sortDir: -1,
    type: 'all',
    tag: 'all',
    search: '',
    searchResults: null,
    searchSeq: 0,
    selected: new Set(),
    anchorIndex: null,
    detailsId: null,
    quickId: null,
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

export function Root({ rootRef }: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [narrow, setNarrow] = useState(false);
  const [ready, setReady] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [consent, setConsent] = useState<{ message: string } | null>(null);
  const [dropVisible, setDropVisible] = useState(false);
  const [dropTarget, setDropTarget] = useState('');

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  const emptyRef = useRef<HTMLDivElement | null>(null);
  const skeletonRef = useRef<HTMLDivElement | null>(null);
  const flushEditorRef = useRef<(() => Promise<void>) | null>(null);
  const readFailedRef = useRef(false);

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
    const core = {} as Core;

    core.refresh = async (): Promise<void> => {
      let next: DriveResult;
      try {
        next = await window.centraid.read<DriveResult>({
          query: 'drive',
          input: { limit: state.driveWindow },
        });
      } catch {
        readFailed(document.querySelector<HTMLElement>('#noticeBanner'));
        readFailedRef.current = true;
        setLoaded(true);
        return;
      }
      if (readFailedRef.current) {
        readFailedRef.current = false;
        core.logic.notice('');
      }
      const denied = next?.vaultDenied;
      setConsent(denied ? { message: denied.message ?? '' } : null);
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
        [...state.selected].filter((id) => data.documents.some((d) => d.document_id === id)),
      );
      if (state.detailsId && !data.documents.some((d) => d.document_id === state.detailsId))
        state.detailsId = null;
      if (state.quickId && !data.documents.some((d) => d.document_id === state.quickId))
        state.quickId = null;
      // The editor overlay manages its own body state after its initial fetch —
      // a background refresh never closes it out from under a typing user.
      bump();
    };

    core.applySearch = debounce(async () => {
      const q = (document.querySelector('#searchInput') as HTMLInputElement).value.trim();
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
          query: 'search',
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
    applySearch: handleSearchInput,
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
  const {
    closeDetails: handleCloseDetails,
    closeQuick: handleCloseQuick,
    openDetails: handleOpenDetails,
    quickStep: handleQuickStep,
    selectTag: handleSelectTag,
    selectType: handleSelectType,
    showMoreDocs: handleShowMoreDocs,
    startCreateFolder: handleStartCreateFolder,
    triggerUpload: handleTriggerUpload,
  } = nav;
  const handleOpenQuick = core.nav.openQuick;
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
    [rootRef],
  );

  // Wrap nav.selectNav so a nav click also closes the React drawer (its own
  // `$('root')` class toggle is a no-op on the host's mount div).
  const selectNav = useCallback(
    (navArg: AppState['nav']) => {
      nav.selectNav(navArg);
      setSideOpen(false);
    },
    [nav],
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
    [state],
  );

  const selectView = useCallback(
    (view: AppState['view']) => {
      state.view = view;
      bump();
    },
    [state],
  );

  const onSort = useCallback(() => {
    const order = ['added', 'name', 'size'] as const;
    if (state.sortDir === -1 && state.sortKey !== 'name') {
      state.sortDir = 1;
    } else if (state.sortDir === 1) {
      state.sortDir = -1;
    } else {
      const i = order.indexOf(state.sortKey);
      const nextKey = order[(i + 1) % order.length]!;
      state.sortKey = nextKey;
      state.sortDir = nextKey === 'name' ? 1 : -1;
    }
    bump();
  }, [state]);

  const onSearchKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      const input = searchInputRef.current;
      if (!input?.value && !state.search) return;
      if (input) input.value = '';
      state.searchSeq += 1;
      state.search = '';
      state.searchResults = null;
      state.selected.clear();
      state.anchorIndex = null;
      bump();
    },
    [state],
  );

  const onUploadChange = useCallback(() => {
    const input = uploadRef.current;
    if (!input) return;
    const files = [...(input.files ?? [])];
    input.value = '';
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
    const forced = el.dataset.appWidth === 'narrow';
    const isNarrow = forced || el.clientWidth < 860;
    if (isNarrow !== stateRef.current.narrow) {
      stateRef.current.narrow = isNarrow;
      setNarrow(isNarrow);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pre-paint seed, refs stable (#505)
  }, []);
  // Enable the drawer slide transition only after the first painted frame, so
  // the mount-time narrow snap above is instant and user-driven open/close animate.
  useEffect(() => {
    const id = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // ---- chrome wiring: theme toggle, doorbell, focus, width, keys, drag/drop ----
  useEffect(() => {
    if (themeBtnRef.current) wireThemeToggle(themeBtnRef.current);
    const stopDoorbell = onDataChange(CHANGE_TABLES, () => void core.refresh());
    const stopFocus = onFocusRefresh(() => void core.refresh());

    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (state.editingId) {
        if (e.key === 'Escape') {
          e.preventDefault();
          void closeEditorSafely();
        }
        return;
      }
      if (state.quickId) {
        if (e.key === 'Escape') {
          e.preventDefault();
          handleCloseQuick();
        } else if (e.key === 'ArrowLeft') handleQuickStep(-1);
        else if (e.key === 'ArrowRight') handleQuickStep(1);
        return;
      }
      if (e.key !== 'Escape') return;
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
    window.addEventListener('keydown', onKey);

    // Close the "+ New" menu on any outside click (matches chrome.ts's
    // `.closest('.d-new-wrap')` guard via the data-new-wrap hook Chrome stamps).
    const onDocClick = (e: MouseEvent): void => {
      if (state.newMenuOpen && !(e.target as Element | null)?.closest('[data-new-wrap]')) {
        state.newMenuOpen = false;
        bump();
      }
    };
    document.addEventListener('click', onDocClick);

    // Drag-and-drop onto the current folder.
    let dragDepth = 0;
    const dragHasFiles = (e: DragEvent): boolean =>
      [...(e.dataTransfer?.types ?? [])].includes('Files');
    const onDragEnter = (e: DragEvent): void => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      dragDepth += 1;
      const target =
        state.nav.kind === 'folder' ? logic.folderName(state.nav.folderId) : 'Documents';
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
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 860, (isNarrow: boolean) => {
          state.narrow = isNarrow;
          setNarrow(isNarrow);
          if (!isNarrow) setSideOpen(false);
        })
      : () => {};

    void core.refresh();
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
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

  // A folder can vanish under us (deleted elsewhere) — fall back to the top.
  if (state.nav.kind === 'folder' && !logic.folderById(state.nav.folderId))
    state.nav = { kind: 'all' };
  state.visibleRows = logic.currentRows();
  const rows = state.visibleRows;

  const active = logic.activeFiles();
  const counts = {
    all: active.length,
    starred: active.filter((f) => f.starred).length,
    trash: logic.trashedFiles().length,
  };

  const titles = {
    all: 'All documents',
    recent: 'Recent',
    starred: 'Starred',
    trash: 'Trash',
  };
  let activeTitle =
    state.nav.kind === 'folder' ? logic.folderName(state.nav.folderId) : titles[state.nav.kind];
  if (state.search.trim()) activeTitle = `Results for “${state.search.trim()}”`;
  const n = rows.length;
  let activeSub: string;
  if (state.search.trim()) activeSub = `${n} match${n === 1 ? '' : 'es'} “${state.search.trim()}”`;
  else if (state.nav.kind === 'trash') activeSub = `${n} in trash · auto-purge after 30 days`;
  else if (state.nav.kind === 'recent') activeSub = 'Newest across every folder';
  else if (state.nav.kind === 'starred')
    activeSub = `${n} starred document${n === 1 ? '' : 's'} · one star across your vault`;
  else activeSub = `${n} document${n === 1 ? '' : 's'}`;

  const sortNames = { added: 'Date', name: 'Name', size: 'Size' };
  const sortLabel = `${sortNames[state.sortKey]} ${state.sortDir === 1 ? '↑' : '↓'}`;

  const tagOptions = [...new Set(active.flatMap((f) => (f.tags ?? []).map((t) => t.label)))].sort();

  // Empty-state config for the current view; filled imperatively (below) into
  // the #empty container's kit-empty structure exactly as served.
  const emptyCfg = loaded && rows.length === 0 ? emptyStateFor(state, active.length > 0) : null;
  useEffect(() => {
    if (!emptyCfg || !emptyRef.current) return;
    const action = emptyCfg.needsUpload
      ? h(
          'button',
          { type: 'button', onclick: () => uploadRef.current?.click() },
          emptyCfg.needsUpload,
        )
      : undefined;
    emptyState(emptyRef.current, {
      icon: emptyCfg.icon,
      title: emptyCfg.title,
      sub: emptyCfg.sub,
      action,
    });
    // No deps array: the #empty node is freshly mounted each time the view
    // re-enters the empty branch, and its copy can be identical across separate
    // empty episodes — so fill on every render while it exists (the guard makes
    // it a no-op otherwise). Matches app.tsx re-running emptyState() per render.
  });

  const inTrash = state.nav.kind === 'trash' && !state.search.trim();
  const trashed = state.nav.kind === 'trash' && !state.search.trim();
  const showFoot = state.driveTruncated && !state.search.trim() && state.nav.kind !== 'starred';

  // ---- slots ----

  const sidebarNav = <SmartNav navKind={state.nav.kind} counts={counts} onSelectNav={selectNav} />;
  const folderList = (
    <FolderList
      folders={data.folders}
      activeDocs={active}
      navKind={state.nav.kind}
      navFolderId={state.nav.folderId}
      renamingFolderId={state.renamingFolderId}
      creatingFolder={state.creatingFolder}
      trashCount={counts.trash}
      onSelectNav={selectNav}
      onStartRename={handleStartRenameFolder}
      onDeleteFolder={handleDeleteFolder}
      onRenameCommit={handleRenameFolder}
      onRenameCancel={handleCancelRenameFolder}
      onCreateCommit={handleCreateFolder}
      onCreateCancel={handleCancelCreateFolder}
    />
  );
  const storage = <Storage docs={active} truncated={state.driveTruncated} />;
  const newMenu = state.newMenuOpen ? (
    <NewMenu onUpload={handleTriggerUpload} onNewFolder={handleStartCreateFolder} />
  ) : null;
  const typeChips = <TypeChips type={state.type} onSelect={handleSelectType} />;
  const tagChips = <TagChips tags={tagOptions} active={state.tag} onSelect={handleSelectTag} />;
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

  let scroll: ReactNode;
  if (!loaded) {
    scroll = (
      <div className={styles.listwrap}>
        <div ref={skeletonRef} />
      </div>
    );
  } else if (rows.length === 0) {
    scroll = <div className="kit-empty" ref={emptyRef} />;
  } else if (state.view === 'grid') {
    scroll = (
      <>
        <div className={styles.grid}>
          {rows.map((d, i) => (
            <GridCard
              key={d.document_id}
              doc={d}
              index={i}
              selectedIds={state.selected}
              onOpenDetails={handleOpenDetails}
              onOpenQuick={handleOpenQuick}
              onToggleSelect={handleToggleSelect}
            />
          ))}
        </div>
        {showFoot ? (
          <WindowFoot driveWindow={state.driveWindow} onShowMore={handleShowMoreDocs} />
        ) : null}
      </>
    );
  } else {
    scroll = (
      <>
        <div className={styles.listwrap}>
          {state.narrow ? null : (
            <div className={styles.listHead}>
              <ListHead
                rows={rows}
                selectedIds={state.selected}
                onToggleAll={handleToggleAllVisible}
              />
            </div>
          )}
          <div>
            {rows.map((d, i) => (
              <ListRow
                key={d.document_id}
                doc={d}
                index={i}
                selectedIds={state.selected}
                narrow={state.narrow}
                search={state.search}
                trashed={trashed}
                folderName={logic.folderName}
                onOpenDetails={handleOpenDetails}
                onOpenQuick={handleOpenQuick}
                onToggleSelect={handleToggleSelect}
                onOpenMenu={handleOpenDocMenu}
                onRestore={handleRestoreDoc}
              />
            ))}
          </div>
        </div>
        {showFoot ? (
          <WindowFoot driveWindow={state.driveWindow} onShowMore={handleShowMoreDocs} />
        ) : null}
      </>
    );
  }

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
          onRestoreVersion={handleRestoreVersion}
          onAddTag={handleAddTag}
          onRemoveTag={handleRemoveTag}
          loadActivity={logic.loadActivity}
        />
      ) : null}
      {quickDoc ? (
        <QuickLook
          doc={quickDoc}
          rows={state.visibleRows}
          folderName={logic.folderName}
          onClose={handleCloseQuick}
          onStep={handleQuickStep}
        />
      ) : null}
      {editorDoc ? (
        <Editor
          key={editorDoc.document_id}
          doc={editorDoc}
          registerFlush={(fn) => {
            flushEditorRef.current = fn;
          }}
          onClose={closeEditorSafely}
          onSave={handleEditDocument}
        />
      ) : null}
    </>
  );

  return (
    // Fill the app pane (a flex child of the route body) so the inline chrome gets
    // real width — otherwise it collapses to content width and the component-width
    // narrow observer wrongly flips to the phone drawer layout.
    <div
      ref={setRoot}
      style={{
        display: 'flex',
        flexDirection: 'column',
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
        themeButtonRef={(el) => {
          themeBtnRef.current = el;
        }}
        uploadRef={(el) => {
          uploadRef.current = el;
        }}
        sidebarNav={sidebarNav}
        folderList={folderList}
        storage={storage}
        newMenu={newMenu}
        typeChips={typeChips}
        tagChips={tagChips}
        bulkBar={bulkBar}
        scroll={scroll}
        overlays={overlays}
      />
    </div>
  );
}
