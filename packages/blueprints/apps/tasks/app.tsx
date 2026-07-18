// Tasks — a Things-style manager that is still a pure projection over the
// personal vault. Every row rendered here lives in schedule.task; every
// mutation is a typed vault command (schedule.add_task / set_task_status /
// edit_task, core.attach/detach) routed through this app's action handlers,
// consent-checked and receipted. The app's own data.sqlite stays empty by
// design: revoke the grant and this page goes dark while the tasks, history
// and receipts remain the owner's.
//
// React port: module-level `state`/`data` (mutated in place, never
// reassigned) plus a `render()` orchestrator fanning out to one React root
// per stable container — the same docs/photos pattern. `logic.ts` holds the
// non-visual business logic (vault IO, section/count derivation, the session
// activity log, parked-write tracking); `chrome.ts` wires the toolbar/
// keyboard/resize listeners; `format.ts`/`icons.ts` are stateless.
// `components/` holds pure functions of props.
//
// CSS: app.css keeps only the global shell remainder (tokens, the static
// #shell/sidebar/topbar chrome, the narrow-layout rules); the JSX-only `tk-*`
// rules moved into co-located components/*.module.css (shared atoms in
// components/shared.module.css).
import { createRoot } from './react-core.min.js';
import { onDataChange, readFailed, showSkeleton, wireAttachInput } from './kit.js';
import { buildSections, createLogic, sidebarCounts, todayProgress } from './logic.ts';
import { wireChrome } from './chrome.ts';
import { Board } from './components/Board.tsx';
import { Detail } from './components/Detail.tsx';
import { SidebarFoot, SidebarNav } from './components/Sidebar.tsx';
import type { AppState, BoardData, EditPatch, Task, View } from './types.ts';

const $ = (id: string) => document.getElementById(id)!;

// Vault entities this app's queries read — the doorbell filter re-derives
// only when a change names one of these (or names none, i.e. "this app acted").
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

// ---------- State ----------
// The last successful board read (never reassigned — mutated in place so
// logic.ts's closure over it stays valid) and all client-side presentation
// state, which is never persisted and never sent to the vault.

const data: BoardData = { open: [], logbook: [], counts: {}, window: 500 };

const VALID_VIEWS = new Set<View>(['today', 'upcoming', 'anytime', 'all', 'logbook']);
const knobView = document.documentElement.getAttribute('data-app-default-view');
const initialView: View =
  knobView && VALID_VIEWS.has(knobView as View) ? (knobView as View) : 'today';

const state: AppState = {
  view: initialView,
  search: '',
  searchResults: null,
  searchSnippets: null,
  boardWindow: 500,
  boardTruncated: false,
  detailId: null,
  narrow: false,
  // Parked writes: task_ids with an outstanding edit/status/attach/detach,
  // plus ghost entries for parked adds (no task_id exists yet).
  pendingIds: new Set(),
  pendingAdds: [],
  // Session-scoped, receipted activity per task — see logic.ts's logActivity.
  // Never fabricated: only writes this session actually made appear here.
  activityLog: new Map(),
  readFailedShown: false,
};

let captureFocusFn: (() => void) | null = null;
function focusCapture() {
  captureFocusFn?.();
}

function emptyCopy(): { title: string; sub: string } {
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

function selectView(view: View) {
  state.view = view;
  if (state.search) {
    ($('searchInput') as HTMLInputElement).value = '';
    state.search = '';
    state.searchResults = null;
    state.searchSnippets = null;
  }
  $('shell').classList.remove('side-open');
  render();
}

function openDetail(taskId: string) {
  state.detailId = taskId;
  render();
}
function closeDetail() {
  state.detailId = null;
  render();
}

async function showMore() {
  const btn = $('board').querySelector('.kit-foot button') as HTMLButtonElement | null;
  if (btn) btn.disabled = true;
  state.boardWindow += 500;
  await refresh();
}

// ---------- Logic instance ----------
// `render`/`refresh` are `function` declarations (hoisted), so `logic` can
// close over them here even though they're defined further down the file.

const logic = createLogic({ state, data, render, refresh });

// ---------- Roots ----------

let sidebarNavRoot: ReturnType<typeof createRoot>;
let sidebarFootRoot: ReturnType<typeof createRoot>;
let boardRoot: ReturnType<typeof createRoot>;
let detailRoot: ReturnType<typeof createRoot>;

function renderDetail() {
  const task = state.detailId ? logic.findTask(state.detailId) : null;
  detailRoot.render(
    task ? (
      <Detail
        key={task.task_id}
        task={task}
        pending={state.pendingIds.has(task.task_id)}
        activity={state.activityLog.get(task.task_id) ?? []}
        onClose={closeDetail}
        onToggleStatus={(t) => logic.toggleComplete(t)}
        onTitleCommit={(id, title) =>
          logic.editField(
            id,
            { title },
            { toastText: 'Renamed · receipt', activityText: `Renamed to “${title}”` },
          )
        }
        onNotesCommit={(id, patch) =>
          logic.editField(id, patch, {
            toastText: 'Notes updated · receipt',
            activityText: 'Notes updated',
          })
        }
        onPickDue={(id, patch) =>
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
        onPickRepeat={(id, patch) =>
          logic.editField(id, patch, {
            toastText: 'Repeat updated · receipt',
            activityText: patch.clear_rrule ? 'Stopped repeating' : 'Repeat updated',
          })
        }
        onPickRemind={(id, patch) =>
          logic.editField(id, patch, {
            toastText: 'Reminder updated · receipt',
            activityText: patch.clear_remind ? 'Reminder cleared' : 'Reminder updated',
          })
        }
        onToggleSubtask={(sub) => logic.toggleComplete(sub)}
        onAddSubtask={(parentId, title) => logic.addSubtask(parentId, title)}
        onAttach={(taskId) => {
          logic.setAttachTarget(taskId);
          ($('attachInput') as HTMLInputElement).click();
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
    ) : null,
  );
}

function render() {
  const counts = sidebarCounts(data);
  sidebarNavRoot.render(<SidebarNav view={state.view} counts={counts} onSelectView={selectView} />);
  sidebarFootRoot.render(<SidebarFoot progress={todayProgress(data)} />);

  const { sections, isEmpty } = buildSections(data, state);
  const q = state.search.trim();

  $('activeTitle').textContent = q ? `Results for “${q}”` : (VIEW_TITLES[state.view] ?? 'Today');
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
  $('activeSub').textContent = sub;

  const empty = emptyCopy();
  const footer =
    state.boardTruncated && !q ? { windowSize: data.window ?? state.boardWindow } : null;

  boardRoot.render(
    <Board
      view={state.view}
      showCapture={state.view !== 'logbook'}
      captureProps={{
        onSubmit: (payload) => logic.submitCapture(payload),
        registerFocus: (fn) => {
          captureFocusFn = fn;
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
    />,
  );

  renderDetail();
}

interface BoardPayload {
  open?: Task[];
  logbook?: Task[];
  counts?: BoardData['counts'];
  window?: number;
  truncated?: boolean;
  vaultDenied?: { code?: string; message?: string };
}

async function refresh() {
  let res: BoardPayload;
  try {
    res = await window.centraid.read<BoardPayload>({
      query: 'board',
      input: { limit: state.boardWindow },
    });
  } catch {
    // A broken vault must not look like an empty one.
    readFailed($('noticeBanner'));
    state.readFailedShown = true;
    return;
  }
  if (state.readFailedShown) {
    state.readFailedShown = false;
    logic.notice('');
  }
  const denied = res?.vaultDenied;
  $('consentBanner').hidden = !denied;
  if (denied) {
    $('consentDetail').textContent = denied.message ?? '';
    data.open = [];
    data.logbook = [];
    data.counts = {};
    state.detailId = null;
    render();
    return;
  }
  data.open = res?.open ?? [];
  data.logbook = res?.logbook ?? [];
  data.counts = res?.counts ?? {};
  data.window = res?.window ?? state.boardWindow;
  state.boardTruncated = Boolean(res?.truncated);
  if (state.detailId && !logic.findTask(state.detailId)) state.detailId = null;
  render();
}

// ---------- Boot ----------

sidebarNavRoot = createRoot($('sidebarNav'));
sidebarFootRoot = createRoot($('sidebarFoot'));
boardRoot = createRoot($('board'));
detailRoot = createRoot($('detailRoot'));

showSkeleton($('board'), 6);

wireChrome({
  state,
  render,
  refresh,
  applySearchInput: logic.applySearchInput,
  focusCapture,
  closeDetail,
});

// One shared file input for the whole app; the Detail drawer's "Attach a
// file" button sets the target task, then triggers this.
wireAttachInput($('attachInput') as HTMLInputElement, () => logic.getAttachTarget(), {
  act: logic.act,
  narrate: logic.narrate,
  notice: logic.notice,
  refresh,
});

// Reactive data (SKILL.md "Reactive data"): a write elsewhere (chat agent, a
// second window) fires this — re-read, and treat it as the resolution of any
// outstanding parked write (the owner approved or discarded it via another
// surface; there is no per-invocation poll wired here, so this is the
// honest, bounded way to clear a stale pending chip without guessing).
onDataChange(CHANGE_TABLES, () => {
  logic.clearPending();
  refresh();
});

refresh();
