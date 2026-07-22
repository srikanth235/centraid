// Tasks, inline (issue #505). The served entry (app.tsx) stays byte-for-byte for
// mobile WebViews + the visual harness; this co-located sibling re-expresses the
// SAME orchestration as ONE React tree for the shell's inline route. `logic.ts`
// (vault IO, section/count derivation, activity log, parked tracking) and the
// `components/*` are reused verbatim; `chrome.ts`'s imperative listeners become
// hooks + JSX handlers; app.tsx's four `createRoot` islands + imperative
// `render()` collapse into this component's JSX. Reads/writes flow through the
// shell-installed `window.centraid` (backed by the replica), so mount awaits
// nothing over the network — first paint is local.
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from './react-core.min.js';
import {
  observeWidth,
  onDataChange,
  onFocusRefresh,
  readFailed,
  wireAttachInput,
  wireThemeToggle,
} from './kit.js';
import { buildSections, createLogic, sidebarCounts, todayProgress } from './logic.ts';
import { Board } from './components/Board.tsx';
import { Detail } from './components/Detail.tsx';
import { SidebarFoot, SidebarNav } from './components/Sidebar.tsx';
import { Chrome } from './Chrome.tsx';
import boardQuery from './queries/board.ts';
import searchQuery from './queries/search.ts';
import type { AppState, BoardData, EditPatch, Task, View } from './types.ts';
import type { InlineAppModule, InlineAppProps } from '../inline-types.ts';

const CHANGE_TABLES = [
  'schedule.task',
  'core.tag',
  'core.concept',
  'core.attachment',
  'core.content_item',
  'core.link',
];

const VIEW_TITLES: Record<View, string> = {
  today: 'Today',
  upcoming: 'Upcoming',
  anytime: 'Anytime',
  all: 'All open',
  logbook: 'Logbook',
};

const VALID_VIEWS = new Set<View>(['today', 'upcoming', 'anytime', 'all', 'logbook']);

function initialView(rootEl: HTMLElement | null): View {
  const knob = rootEl?.getAttribute('data-app-default-view');
  return knob && VALID_VIEWS.has(knob as View) ? (knob as View) : 'today';
}

function makeState(view: View): AppState {
  return {
    view,
    search: '',
    searchResults: null,
    searchSnippets: null,
    boardWindow: 500,
    boardTruncated: false,
    detailId: null,
    narrow: false,
    pendingIds: new Set(),
    pendingAdds: [],
    activityLog: new Map(),
    readFailedShown: false,
  };
}

function emptyCopy(state: AppState): { title: string; sub: string } {
  const q = state.search.trim();
  if (q) return { title: 'No matches', sub: `No tasks match “${q}”.` };
  if (state.view === 'logbook')
    return { title: 'Nothing logged yet', sub: 'Completed and cancelled tasks land here.' };
  if (state.view === 'today')
    return {
      title: 'Nothing due today',
      sub: 'Enjoy the breathing room — or capture something above.',
    };
  if (state.view === 'upcoming')
    return {
      title: 'Nothing scheduled',
      sub: 'Add a task above and it lands as a receipted vault command.',
    };
  if (state.view === 'anytime')
    return {
      title: 'No loose tasks',
      sub: 'Add a task above and it lands as a receipted vault command.',
    };
  return { title: 'All clear', sub: 'Add a task above and it lands as a receipted vault command.' };
}

interface BoardPayload {
  open?: Task[];
  logbook?: Task[];
  counts?: BoardData['counts'];
  window?: number;
  truncated?: boolean;
  vaultDenied?: { code?: string; message?: string };
}

function Root({ rootRef }: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [narrow, setNarrow] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const rootElRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef<BoardData>({ open: [], logbook: [], counts: {}, window: 500 });
  const stateRef = useRef<AppState>(makeState(initialView(null)));
  const logicRef = useRef<ReturnType<typeof createLogic> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  const captureFocusRef = useRef<(() => void) | null>(null);
  const consentRef = useRef<{ message: string } | null>(null);

  const refresh = useCallback(async () => {
    const state = stateRef.current;
    const data = dataRef.current;
    const logic = logicRef.current;
    let res: BoardPayload;
    try {
      res = await window.centraid.read<BoardPayload>({
        query: 'board',
        input: { limit: state.boardWindow },
      });
    } catch {
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
      data.open = [];
      data.logbook = [];
      data.counts = {};
      state.detailId = null;
      bump();
      return;
    }
    data.open = res?.open ?? [];
    data.logbook = res?.logbook ?? [];
    data.counts = res?.counts ?? {};
    data.window = res?.window ?? state.boardWindow;
    state.boardTruncated = Boolean(res?.truncated);
    if (state.detailId && !logic?.findTask(state.detailId)) state.detailId = null;
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
        if (view !== stateRef.current.view && stateRef.current.search === '') {
          stateRef.current.view = view;
          bump();
        }
      }
    },
    [rootRef],
  );

  const selectView = useCallback((view: View) => {
    const state = stateRef.current;
    state.view = view;
    if (state.search) {
      if (searchInputRef.current) searchInputRef.current.value = '';
      state.search = '';
      state.searchResults = null;
      state.searchSnippets = null;
    }
    setSideOpen(false);
    bump();
  }, []);

  const openDetail = useCallback((taskId: string) => {
    stateRef.current.detailId = taskId;
    bump();
  }, []);
  const closeDetail = useCallback(() => {
    stateRef.current.detailId = null;
    bump();
  }, []);

  const showMore = useCallback(async () => {
    stateRef.current.boardWindow += 500;
    await refresh();
  }, [refresh]);

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
        if (stateRef.current.detailId) return void closeDetail();
        if (stateRef.current.search) {
          if (searchInputRef.current) searchInputRef.current.value = '';
          logic.applySearchInput('');
          return;
        }
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n') {
        e.preventDefault();
        captureFocusRef.current?.();
      } else if (e.key === '/' || e.key === 'f') {
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
  const { sections, isEmpty } = buildSections(data, state);
  const q = state.search.trim();
  const title = q ? `Results for “${q}”` : (VIEW_TITLES[state.view] ?? 'Today');
  let sub: string;
  if (q) {
    const n = sections.reduce((s, x) => s + x.rows.length, 0);
    sub = `${n} match${n === 1 ? '' : 'es'} “${q}”`;
  } else if (state.view === 'logbook') {
    sub = `${counts.logbook} completed & cancelled`;
  } else {
    sub =
      counts.all > 0
        ? `${counts.all} open · ${counts.today} due today or overdue`
        : 'Your canonical task list, from the vault.';
  }
  const empty = emptyCopy(state);
  const footer =
    state.boardTruncated && !q ? { windowSize: data.window ?? state.boardWindow } : null;
  const detailTask = state.detailId ? logic.findTask(state.detailId) : null;

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (!searchInputRef.current?.value && !state.search) return;
    if (searchInputRef.current) searchInputRef.current.value = '';
    logic.applySearchInput('');
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
        title={title}
        sub={sub}
        consent={consentRef.current}
        onOpenSide={() => setSideOpen(true)}
        onCloseSide={() => setSideOpen(false)}
        onNewTask={() => {
          setSideOpen(false);
          if (state.view === 'logbook') {
            state.view = 'today';
            bump();
          }
          captureFocusRef.current?.();
        }}
        onSearchInput={(value) => logic.applySearchInput(value)}
        onSearchKeyDown={onSearchKeyDown}
        searchRef={(el) => {
          searchInputRef.current = el;
        }}
        themeButtonRef={(el) => {
          themeBtnRef.current = el;
        }}
        sidebarNav={<SidebarNav view={state.view} counts={counts} onSelectView={selectView} />}
        sidebarFoot={<SidebarFoot progress={todayProgress(data)} />}
        board={
          <Board
            view={state.view}
            showCapture={state.view !== 'logbook'}
            captureProps={{
              onSubmit: (payload) => logic.submitCapture(payload),
              registerFocus: (fn) => {
                captureFocusRef.current = fn;
              },
            }}
            pendingAdds={state.pendingAdds}
            sections={sections}
            isEmpty={isEmpty}
            emptyTitle={empty.title}
            emptySub={empty.sub}
            search={state.search}
            snippets={state.searchSnippets}
            pendingIds={state.pendingIds}
            footer={footer}
            onShowMore={showMore}
            onOpenDetail={openDetail}
            onToggle={(task) => logic.toggleComplete(task)}
          />
        }
        detail={
          detailTask ? (
            <Detail
              key={detailTask.task_id}
              task={detailTask}
              pending={state.pendingIds.has(detailTask.task_id)}
              activity={state.activityLog.get(detailTask.task_id) ?? []}
              onClose={closeDetail}
              onToggleStatus={(t) => logic.toggleComplete(t)}
              onTitleCommit={(id, title2) =>
                logic.editField(
                  id,
                  { title: title2 },
                  { toastText: 'Renamed · receipt', activityText: `Renamed to “${title2}”` },
                )
              }
              onNotesCommit={(id, patch) =>
                logic.editField(id, patch, {
                  toastText: 'Notes updated · receipt',
                  activityText: 'Notes updated',
                })
              }
              onPickDue={(id, patch: EditPatch) =>
                logic.editField(id, patch, {
                  toastText: 'Updated · receipt',
                  activityText: patch.clear_due ? 'Due date cleared' : `Due ${patch.due_at}`,
                })
              }
              onPickPriority={(id, value) =>
                logic.editField(
                  id,
                  { priority: value },
                  { toastText: 'Priority updated · receipt', activityText: 'Priority updated' },
                )
              }
              onPickEffort={(id, value) =>
                logic.editField(
                  id,
                  { effort_min: value },
                  { toastText: 'Effort updated · receipt', activityText: 'Effort updated' },
                )
              }
              onPickRepeat={(id, patch: EditPatch) =>
                logic.editField(id, patch, {
                  toastText: 'Repeat updated · receipt',
                  activityText: patch.clear_rrule ? 'Stopped repeating' : 'Repeat updated',
                })
              }
              onPickRemind={(id, patch: EditPatch) =>
                logic.editField(id, patch, {
                  toastText: 'Reminder updated · receipt',
                  activityText: patch.clear_remind ? 'Reminder cleared' : 'Reminder updated',
                })
              }
              onToggleSubtask={(sub2) => logic.toggleComplete(sub2)}
              onAddSubtask={(parentId, title2) => logic.addSubtask(parentId, title2)}
              onAttach={(taskId) => {
                logic.setAttachTarget(taskId);
                (document.getElementById('attachInput') as HTMLInputElement | null)?.click();
              }}
              onRemoveAttachment={(attachmentId) => logic.removeAttachment(attachmentId)}
              onAddTag={(taskId, label) => logic.addTag(taskId, label)}
              onRemoveTag={(tagId) => logic.removeTag(tagId)}
              onToggleProcess={(t) => logic.toggleProcess(t)}
              onCancel={(t) => {
                logic.cancelTask(t);
                closeDetail();
              }}
            />
          ) : null
        }
      />
    </div>
  );
}

const tasksInlineApp: InlineAppModule = {
  appId: 'tasks',
  changeTables: CHANGE_TABLES,
  // The query defaults are typed against the ambient `HandlerArgs`; the inline
  // contract types `ctx` as `unknown`, so bridge the two here (the shell builds
  // a compatible ctx at run time — inlineQueryCtx.ts).
  queries: {
    board: { default: boardQuery },
    search: { default: searchQuery },
  } as unknown as InlineAppModule['queries'],
  kitAsk: {
    scope: 'tasks',
    placeholder: 'Ask your tasks…',
    intro:
      'Ask me to add, complete, reschedule or find tasks. I’ll show the change for your approval before it touches the vault.',
    suggest: ['Add “call mom tomorrow”', 'What’s due today?', 'Complete “Send the studio invoice”'],
  },
  Root,
};

export default tasksInlineApp;
