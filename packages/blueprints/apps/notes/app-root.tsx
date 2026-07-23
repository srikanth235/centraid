// Notes — query-free React tree (issue #505). Holds the `Root` component and
// every constant, helper and type it needs that does NOT depend on the
// node-side `./queries/*` handler modules. Both the served shim (app.tsx, for
// mobile WebViews) and the shell's inline route mount this `Root`; keeping it
// free of `./queries/*` imports is what lets the gateway's whole-graph bundler
// serve app.tsx to the browser without dragging node-only handler code into the
// client graph. The InlineAppModule descriptor (app-inline.tsx) imports `Root`
// and `CHANGE_TABLES` from here and adds the query wiring.

import { useCallback, useEffect, useReducer, useRef, useState } from './react-core.min.js';
import type { KeyboardEvent, ReactElement } from './react-core.min.js';
import {
  observeWidth,
  onDataChange,
  onFocusRefresh,
  readFailed,
  wireAttachInput,
  wireThemeToggle,
} from './kit.js';
import {
  buildWall,
  createLogic,
  notebookNoteCounts,
  sidebarCounts,
  tagNoteCounts,
} from './logic.ts';
import { SidebarFoot, SidebarNav } from './components/Sidebar.tsx';
import { Toolbar } from './components/Toolbar.tsx';
import { Wall } from './components/Wall.tsx';
import { Editor } from './components/Editor.tsx';
import { Chrome } from './Chrome.tsx';
import type { AppData, AppState, Note, Notebook, SidebarTag } from './types.ts';
import type { InlineAppProps } from '../inline-types.ts';

export const CHANGE_TABLES = [
  'knowledge.note',
  'core.content_item',
  'core.attachment',
  'core.link',
  'core.collection',
  'core.collection_entry',
  'core.tag',
  'core.concept',
];

const VALID_VIEWS = new Set<AppState['view']>(['masonry', 'list']);

function initialView(rootEl: HTMLElement | null): AppState['view'] {
  const knob = rootEl?.getAttribute('data-app-default-view');
  return knob && VALID_VIEWS.has(knob as AppState['view']) ? (knob as AppState['view']) : 'masonry';
}

function makeState(view: AppState['view']): AppState {
  return {
    nav: { kind: 'all' },
    view,
    search: '',
    searchResults: null,
    libraryWindow: 200,
    libraryTruncated: false,
    editorId: null,
    narrow: false,
    editingNotebookId: null,
    creatingNotebook: false,
    pendingNoteIds: new Set(),
    pendingNotebookIds: new Set(),
    pendingCreates: [],
    readFailedShown: false,
  };
}

interface LibraryPayload {
  notes?: Note[];
  notebooks?: Notebook[];
  tags?: SidebarTag[];
  window?: number;
  truncated?: boolean;
  vaultDenied?: { code?: string; message?: string };
}

export function Root({ rootRef }: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [narrow, setNarrow] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const rootElRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef<AppData>({ notes: [], notebooks: [], tags: [], window: 200 });
  const stateRef = useRef<AppState>(makeState(initialView(null)));
  const logicRef = useRef<ReturnType<typeof createLogic> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  const focusQuickAddRef = useRef<(() => void) | null>(null);
  const editorFlushRef = useRef<(() => Promise<void>) | null>(null);
  const consentRef = useRef<{ message: string } | null>(null);

  const refresh = useCallback(async () => {
    const state = stateRef.current;
    const data = dataRef.current;
    const logic = logicRef.current;
    let res: LibraryPayload;
    try {
      res = await window.centraid.read<LibraryPayload>({
        query: 'library',
        input: { limit: state.libraryWindow },
      });
    } catch {
      // A broken vault must not look like an empty one.
      readFailed(document.getElementById('noticeBanner'));
      state.readFailedShown = true;
      return;
    }
    if (state.readFailedShown) {
      state.readFailedShown = false;
      logic?.notice('');
    }
    const denied = res?.vaultDenied;
    consentRef.current = denied ? { message: denied.message ?? '' } : null;
    if (denied) {
      data.notes = [];
      data.notebooks = [];
      data.tags = [];
      state.editorId = null;
      bump();
      return;
    }
    data.notes = res?.notes ?? [];
    data.notebooks = res?.notebooks ?? [];
    data.tags = res?.tags ?? [];
    data.window = res?.window ?? state.libraryWindow;
    state.libraryTruncated = Boolean(res?.truncated);
    if (state.nav.kind === 'notebook') {
      const notebookId = state.nav.notebookId;
      if (!data.notebooks.some((nb) => nb.notebook_id === notebookId)) state.nav = { kind: 'all' };
    }
    if (state.nav.kind === 'tag') {
      const conceptId = state.nav.conceptId;
      if (!data.tags.some((t) => t.concept_id === conceptId)) state.nav = { kind: 'all' };
    }
    if (
      state.editingNotebookId &&
      !data.notebooks.some((nb) => nb.notebook_id === state.editingNotebookId)
    ) {
      state.editingNotebookId = null;
    }
    if (state.editorId && !logic?.findNote(state.editorId)) state.editorId = null;
    bump();
  }, []);

  if (!logicRef.current) {
    logicRef.current = createLogic({
      state: stateRef.current,
      data: dataRef.current,
      render: bump,
      refresh,
    });
  }
  const logic = logicRef.current;

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

  const selectNav = useCallback(
    (nav: AppState['nav']) => {
      logic.selectNav(nav);
      setSideOpen(false);
    },
    [logic],
  );

  const focusQuickAdd = useCallback(() => {
    if (stateRef.current.nav.kind === 'pinned') logic.selectNav({ kind: 'all' });
    focusQuickAddRef.current?.();
  }, [logic]);

  const closeEditor = useCallback(async () => {
    if (editorFlushRef.current) {
      const fn = editorFlushRef.current;
      editorFlushRef.current = null;
      await fn();
    }
    logic.closeEditor();
  }, [logic]);

  const showMore = useCallback(async () => {
    stateRef.current.libraryWindow += 200;
    await refresh();
  }, [refresh]);

  const selectView = useCallback((view: AppState['view']) => {
    stateRef.current.view = view;
    bump();
  }, []);

  const clearSearchInput = useCallback(() => {
    if (searchInputRef.current) searchInputRef.current.value = '';
    logic.applySearchInput('');
  }, [logic]);

  // ---- chrome wiring: theme toggle, attach input, doorbell, focus, keys, width ----
  useEffect(() => {
    if (themeBtnRef.current) wireThemeToggle(themeBtnRef.current);
    const attachInput = document.getElementById('attachInput') as HTMLInputElement | null;
    if (attachInput) {
      wireAttachInput(attachInput, () => logic.getAttachTarget(), {
        act: logic.act,
        narrate: logic.narrate,
        notice: logic.notice,
        refresh,
      });
    }
    const stopDoorbell = onDataChange(CHANGE_TABLES, () => {
      logic.clearPending();
      void refresh();
    });
    const stopFocus = onFocusRefresh(() => void refresh());
    const onKey = (e: globalThis.KeyboardEvent): void => {
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement;
      if (e.key === 'Escape') {
        if (stateRef.current.editorId) return void closeEditor();
        if (stateRef.current.search) return clearSearchInput();
        setSideOpen(false);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || stateRef.current.editorId) return;
      if (e.key === 'n') {
        e.preventDefault();
        focusQuickAdd();
      } else if (e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 860, (isNarrow: boolean) => {
          stateRef.current.narrow = isNarrow;
          setNarrow(isNarrow);
          if (!isNarrow) setSideOpen(false);
        })
      : () => {};
    void refresh();
    return () => {
      window.removeEventListener('keydown', onKey);
      stopDoorbell();
      stopFocus();
      stopWidth();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#505)
  }, []);

  const state = stateRef.current;
  const data = dataRef.current;
  const counts = sidebarCounts(data);
  const nbCounts = notebookNoteCounts(data);
  const tgCounts = tagNoteCounts(data);
  const q = state.search.trim();
  const wall = buildWall(data, state);
  const rows = wall.pinned.length + wall.others.length;
  const titles: Record<string, string> = { all: 'All notes', pinned: 'Pinned' };
  let activeTitle: string;
  if (state.nav.kind === 'notebook') {
    activeTitle = logic.notebookName(state.nav.notebookId);
  } else if (state.nav.kind === 'tag') {
    const conceptId = state.nav.conceptId;
    activeTitle = `#${(data.tags ?? []).find((t) => t.concept_id === conceptId)?.label ?? 'tag'}`;
  } else {
    activeTitle = titles[state.nav.kind] ?? 'All notes';
  }
  const activeSub = q
    ? `${rows} match${rows === 1 ? '' : 'es'} “${q}”`
    : `${rows} ${rows === 1 ? 'note' : 'notes'}`;
  const footer =
    state.libraryTruncated && !q ? { windowSize: data.window ?? state.libraryWindow } : null;
  const targetLabel =
    state.nav.kind === 'notebook' ? `Into ${logic.notebookName(state.nav.notebookId)}` : 'Unfiled';
  const editorNote = state.editorId ? logic.findNote(state.editorId) : null;

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (!searchInputRef.current?.value && !state.search) return;
    clearSearchInput();
  };

  return (
    // Fill the app pane (a flex child of the route body) so the inline chrome
    // gets real width — otherwise it collapses to content width and the
    // component-width narrow observer wrongly flips to the phone drawer layout.
    <div
      ref={setRoot}
      style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, minHeight: 0 }}
    >
      <Chrome
        narrow={narrow}
        sideOpen={sideOpen}
        view={state.view}
        consent={consentRef.current}
        onOpenSide={() => setSideOpen(true)}
        onCloseSide={() => setSideOpen(false)}
        onNewNote={() => {
          setSideOpen(false);
          focusQuickAdd();
        }}
        onSearchInput={(value) => logic.applySearchInput(value)}
        onSearchKeyDown={onSearchKeyDown}
        onSearchClear={() => {
          clearSearchInput();
          searchInputRef.current?.focus();
        }}
        onSelectView={selectView}
        searchRef={(el) => {
          searchInputRef.current = el;
        }}
        themeButtonRef={(el) => {
          themeBtnRef.current = el;
        }}
        sidebarNav={
          <SidebarNav
            nav={state.nav}
            counts={counts}
            notebooks={data.notebooks}
            notebookCounts={nbCounts}
            tags={data.tags}
            tagCounts={tgCounts}
            creatingNotebook={state.creatingNotebook}
            pendingNotebookIds={state.pendingNotebookIds}
            onSelect={selectNav}
            onStartCreate={() => {
              state.creatingNotebook = true;
              bump();
            }}
            onCancelCreate={() => {
              state.creatingNotebook = false;
              bump();
            }}
            onSubmitCreate={(name) => logic.createNotebook(name)}
          />
        }
        sidebarFoot={<SidebarFoot counts={counts} />}
        toolbar={
          <Toolbar
            title={activeTitle}
            sub={activeSub}
            showNotebookTools={state.nav.kind === 'notebook'}
            renaming={
              state.nav.kind === 'notebook' && state.editingNotebookId === state.nav.notebookId
            }
            notebookId={state.nav.kind === 'notebook' ? state.nav.notebookId : null}
            notebookName={activeTitle}
            onStartRename={() => {
              if (state.nav.kind === 'notebook') state.editingNotebookId = state.nav.notebookId;
              bump();
            }}
            onCommitRename={(notebookId, name) => logic.renameNotebook(notebookId, name)}
            onCancelRename={() => {
              state.editingNotebookId = null;
              bump();
            }}
            onDelete={(notebookId) => logic.deleteNotebook(notebookId)}
          />
        }
        wall={
          <Wall
            view={state.view}
            showQuickAdd={state.nav.kind !== 'pinned' && !q}
            quickAddProps={{
              targetLabel,
              onSubmit: (payload) => logic.submitQuickAdd(payload),
              registerFocus: (fn) => {
                focusQuickAddRef.current = fn;
              },
            }}
            pendingCreates={state.pendingCreates}
            pinned={wall.pinned}
            others={wall.others}
            showPinnedGroup={wall.showPinnedGroup}
            isEmpty={wall.isEmpty}
            emptyTitle={wall.emptyTitle}
            emptySub={wall.emptySub}
            search={state.search}
            pendingNoteIds={state.pendingNoteIds}
            footer={footer}
            onShowMore={showMore}
            onOpenNote={(noteId) => logic.openEditor(noteId)}
            onTogglePin={(note) => logic.togglePin(note)}
          />
        }
        editor={
          editorNote ? (
            <Editor
              key={`${editorNote.note_id}:${typeof editorNote.body === 'string' ? 'full' : 'lite'}`}
              note={editorNote}
              notebooks={data.notebooks}
              pending={state.pendingNoteIds.has(editorNote.note_id)}
              registerFlush={(fn) => {
                editorFlushRef.current = fn;
              }}
              onClose={closeEditor}
              onAutosave={(noteId, patch) => logic.editNoteAutosave(noteId, patch)}
              onTogglePin={(n) => logic.togglePin(n)}
              onMove={(noteId, notebookId) => logic.moveNote(noteId, notebookId)}
              onDelete={(n) => logic.deleteNote(n)}
              onAttach={(noteId) => {
                logic.setAttachTarget(noteId);
                (document.getElementById('attachInput') as HTMLInputElement | null)?.click();
              }}
              onRemoveAttachment={(attachmentId) => logic.removeAttachment(attachmentId)}
              onAddTag={(noteId, label) => logic.addTag(noteId, label)}
              onRemoveTag={(tagId) => logic.removeTag(tagId)}
            />
          ) : null
        }
      />
    </div>
  );
}
