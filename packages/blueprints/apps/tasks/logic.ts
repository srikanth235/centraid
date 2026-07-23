// Non-visual business logic: vault IO (write/act), the board-section
// derivation, sidebar counts, the session activity log and parked-write
// tracking. `createLogic` closes over app.tsx's own `state`/`data` (mutated
// in place, never reassigned) plus the render/refresh entry points app.tsx
// defines — the same factory shape docs/logic.ts and nav.ts use. The pure
// derivation helpers (`buildSections`/`sidebarCounts`/`todayProgress`) need
// no closure and are exported standalone so components can call them too.
import { debounce, outcomeMessage, toast } from './kit.ts';
import { BUCKETS, VIEW_BUCKETS, bucketFor, parseNlDue, plusDays, todayStr } from './format.ts';
import type {
  AppState,
  BoardData,
  BoardSection,
  EditPatch,
  LogicDeps,
  SidebarCountsShape,
  Task,
  TodayProgress,
} from './types.ts';

/** The capture bar's add payload (mirrors components/Capture.tsx). */
interface CapturePayload {
  title: string;
  dueChoice: string;
  priority: number;
}

export function createLogic({ state, data, render, refresh }: LogicDeps) {
  function notice(text: string) {
    const el = document.getElementById('noticeBanner');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  // Executed clears the banner and tells the caller to refresh; parked is
  // narrated by the caller (toast + per-row pending chip, not the banner —
  // this is a designed calm state, not an error); failed/denied surface the
  // plain-language reason in the banner.
  function narrate(outcome: VaultOutcome | undefined): boolean {
    if (outcome?.status === 'executed') {
      notice('');
      return true;
    }
    if (outcome?.status === 'parked') {
      notice('');
      return false;
    }
    const message = outcomeMessage(outcome);
    if (message) notice(message);
    return false;
  }

  function markPending(
    action: string,
    input: Record<string, unknown>,
    outcome: VaultOutcome | undefined,
  ) {
    if (action === 'add') {
      state.pendingAdds.push({
        key:
          outcome?.invocationId ??
          `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: String(input.title ?? ''),
        due_at: (input.due_at as string | null | undefined) ?? null,
        priority: (input.priority as number | undefined) ?? 0,
        parent_task_id: (input.parent_task_id as string | null | undefined) ?? null,
      });
      return;
    }
    const id = (input.task_id ?? input.subject_id) as string | undefined;
    if (id) state.pendingIds.add(id);
  }

  function clearPending() {
    state.pendingIds.clear();
    state.pendingAdds = [];
  }

  function logActivity(
    taskId: string | undefined,
    text: string,
    outcome: VaultOutcome | undefined,
  ) {
    if (!taskId) return;
    const list = state.activityLog.get(taskId) ?? [];
    list.unshift({ text, when: 'Today', receiptId: outcome?.receiptId ?? null });
    state.activityLog.set(taskId, list.slice(0, 20));
  }

  async function write(
    action: string,
    input: Record<string, unknown>,
  ): Promise<VaultOutcome | undefined> {
    let outcome: VaultOutcome | undefined;
    try {
      outcome = await window.centraid.write({ action, input });
    } catch (err) {
      notice(String((err as { message?: unknown })?.message ?? err));
      return undefined;
    }
    const executed = narrate(outcome);
    if (outcome?.status === 'parked') {
      markPending(action, input, outcome);
      toast('Sent to the owner for confirmation.');
    }
    if (executed || outcome?.status === 'denied') await refresh();
    else render();
    return outcome;
  }

  // Like write(), but returns the raw outcome so the shared attachment
  // helpers (kit.ts wireAttachInput) can narrate and refresh on their own.
  async function act(
    action: string,
    input: Record<string, unknown>,
  ): Promise<VaultOutcome | undefined> {
    try {
      return await window.centraid.write({ action, input });
    } catch (err) {
      notice(String((err as { message?: unknown })?.message ?? err));
      return undefined;
    }
  }

  function findTask(taskId: string): Task | null {
    for (const bucket of [data.open, data.logbook]) {
      for (const t of bucket ?? []) {
        if (t.task_id === taskId) return t;
        const child = (t.children ?? []).find((c) => c.task_id === taskId);
        if (child) return child;
      }
    }
    return null;
  }

  // ---------- Capture ----------

  async function submitCapture({ title, dueChoice, priority }: CapturePayload): Promise<boolean> {
    const raw = String(title ?? '').trim();
    if (!raw) return false;
    let cleanTitle = raw;
    let due: string | null = null;
    if (dueChoice === 'today') due = todayStr();
    else if (dueChoice === 'tomorrow') due = plusDays(1);
    else if (dueChoice === 'week') due = plusDays(7);
    else {
      const nl = parseNlDue(raw);
      if (nl) {
        cleanTitle = nl.clean;
        due = nl.due;
      }
    }
    const input: Record<string, unknown> = { title: cleanTitle };
    if (due) input.due_at = due;
    if (priority > 0) input.priority = priority;
    const outcome = await write('add', input);
    if (outcome?.status === 'executed') {
      const newId = outcome.output?.task_id as string | undefined;
      logActivity(newId, 'Added to your list', outcome);
      // There is no delete_task command in the manifest — the closest honest
      // "undo" for a freshly captured task is cancelling it (files it into
      // the logbook rather than erasing it, same as every other cancel).
      toast('Task added · receipt', {
        undoLabel: newId ? 'Undo' : undefined,
        onUndo: newId
          ? () => {
              void write('set-status', { task_id: newId, status: 'cancelled' });
            }
          : undefined,
      });
    }
    return outcome?.status === 'executed' || outcome?.status === 'parked';
  }

  async function addSubtask(
    parentTaskId: string,
    title: string,
  ): Promise<VaultOutcome | undefined | null> {
    const raw = String(title ?? '').trim();
    if (!raw) return null;
    const outcome = await write('add', { title: raw, parent_task_id: parentTaskId });
    if (outcome?.status === 'executed') {
      logActivity(parentTaskId, `Added subtask "${raw}"`, outcome);
      toast('Subtask added · receipt');
    }
    return outcome;
  }

  // ---------- Status transitions ----------

  // The one hot, high-frequency write path (issue #404). Checking a box used
  // to await the POST AND a full board refetch before the click resolved (two
  // serial round trips). Now the circle fills optimistically in Row.tsx the
  // instant it's clicked; we fire the write and let the write's own (debounced)
  // change doorbell reconcile the board — the task sliding to/from the logbook
  // — with no inline refetch on the click. Returning truthy keeps the fill;
  // falsy reverts it. Parked/failed are honest first-class outcomes, not the
  // completed state: parked surfaces the app's existing per-row pending chip,
  // failed/denied revert and narrate.
  async function toggleComplete(task: Task): Promise<boolean> {
    const wasOpen = task.status === 'needs-action' || task.status === 'in-process';
    const nextStatus = wasOpen ? 'completed' : 'needs-action';
    const prevStatus = task.status;
    let outcome: VaultOutcome | undefined;
    try {
      outcome = await window.centraid.write({
        action: 'set-status',
        input: { task_id: task.task_id, status: nextStatus },
      });
    } catch (err) {
      notice(String((err as { message?: unknown })?.message ?? err));
      return false;
    }
    if (outcome?.status === 'executed') {
      notice('');
      logActivity(
        task.task_id,
        nextStatus === 'completed' ? 'Marked complete' : 'Reopened',
        outcome,
      );
      if (nextStatus === 'completed') {
        toast(`Completed “${task.title}”`, {
          undoLabel: 'Undo',
          onUndo: () => {
            void write('set-status', { task_id: task.task_id, status: prevStatus });
          },
        });
      }
      return true;
    }
    if (outcome?.status === 'parked') {
      markPending('set-status', { task_id: task.task_id }, outcome);
      toast('Sent to the owner for confirmation.');
      render();
      return false;
    }
    narrate(outcome);
    render();
    return false;
  }

  async function cancelTask(task: Task): Promise<VaultOutcome | undefined> {
    const prevStatus = task.status;
    const outcome = await write('set-status', { task_id: task.task_id, status: 'cancelled' });
    if (outcome?.status === 'executed') {
      logActivity(task.task_id, 'Cancelled', outcome);
      toast(`Cancelled “${task.title}”`, {
        undoLabel: 'Undo',
        onUndo: () => {
          void write('set-status', { task_id: task.task_id, status: prevStatus });
        },
      });
    }
    return outcome;
  }

  async function toggleProcess(task: Task): Promise<VaultOutcome | undefined> {
    const inProcess = task.status === 'in-process';
    const outcome = await write('set-status', {
      task_id: task.task_id,
      status: inProcess ? 'needs-action' : 'in-process',
    });
    if (outcome?.status === 'executed') {
      logActivity(task.task_id, inProcess ? 'Paused' : 'Started', outcome);
    }
    return outcome;
  }

  // ---------- Field edits (title / notes / due / priority / effort) ----------

  async function editField(
    taskId: string,
    patch: EditPatch,
    {
      toastText = 'Updated · receipt',
      activityText,
    }: { toastText?: string; activityText?: string } = {},
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write('edit', { task_id: taskId, ...patch });
    if (outcome?.status === 'executed') {
      logActivity(taskId, activityText ?? toastText.replace(/\s*·\s*receipt$/, ''), outcome);
      toast(toastText);
    }
    return outcome;
  }

  // ---------- Attachments (kit.ts renderAttachments / wireAttachInput) ----------

  let attachTarget: string | null = null;
  const setAttachTarget = (taskId: string | null) => {
    attachTarget = taskId;
  };
  const getAttachTarget = () => attachTarget;

  async function removeAttachment(attachmentId: string): Promise<VaultOutcome | undefined> {
    const outcome = await act('detach', { attachment_id: attachmentId });
    if (narrate(outcome) || outcome?.status === 'denied') await refresh();
    else render();
    return outcome;
  }

  // ---------- Tags ----------

  async function addTag(taskId: string, label: string): Promise<VaultOutcome | undefined> {
    const l = String(label ?? '').trim();
    if (!l) return undefined;
    const outcome = await act('add-tag', { task_id: taskId, label: l });
    if (narrate(outcome) || outcome?.status === 'denied') await refresh();
    else render();
    return outcome;
  }

  async function removeTag(tagId: string): Promise<VaultOutcome | undefined> {
    const outcome = await act('remove-tag', { tag_id: tagId });
    if (narrate(outcome) || outcome?.status === 'denied') await refresh();
    else render();
    return outcome;
  }

  // ---------- Search ----------

  let searchSeq = 0;
  const applySearchInput = debounce(async (raw: string) => {
    state.search = raw;
    if (!raw.trim()) {
      state.searchResults = null;
      state.searchSnippets = null;
      render();
      return;
    }
    const seq = ++searchSeq;
    let rows: Task[] = [];
    try {
      const res = await window.centraid.read<{ tasks?: Task[] }>({
        query: 'search',
        input: { term: raw },
      });
      rows = res?.tasks ?? [];
    } catch {
      rows = [];
    }
    if (seq !== searchSeq) return;
    state.searchResults = rows;
    state.searchSnippets = new Map(
      rows.filter((t) => t.snippet).map((t) => [t.task_id, t.snippet!] as [string, string]),
    );
    render();
  }, 120);

  function clearSearch() {
    searchSeq += 1;
    state.search = '';
    state.searchResults = null;
    state.searchSnippets = null;
    render();
  }

  return {
    notice,
    narrate,
    write,
    act,
    findTask,
    submitCapture,
    addSubtask,
    toggleComplete,
    cancelTask,
    toggleProcess,
    editField,
    setAttachTarget,
    getAttachTarget,
    removeAttachment,
    addTag,
    removeTag,
    applySearchInput,
    clearSearch,
    clearPending,
  };
}

// ---------- Pure derivations (no closure — components may call directly) ----------

export function buildSections(
  data: BoardData,
  state: AppState,
): { sections: BoardSection[]; isEmpty: boolean } {
  const today = todayStr();
  const weekEnd = plusDays(7);
  const searching = Boolean(state.search.trim());
  const matched = new Set((state.searchResults ?? []).map((t) => t.task_id));

  if (state.view === 'logbook') {
    let rows = data.logbook ?? [];
    if (searching) rows = rows.filter((t) => matched.has(t.task_id));
    return {
      sections: rows.length
        ? [{ key: 'log', label: 'Logbook', tone: 'muted', count: rows.length, rows }]
        : [],
      isEmpty: rows.length === 0,
    };
  }

  let open = data.open ?? [];
  if (searching) {
    open = open
      .map((task): Task | null => {
        if (matched.has(task.task_id)) return task;
        const children = (task.children ?? []).filter((c) => matched.has(c.task_id));
        return children.length ? { ...task, children } : null;
      })
      .filter((t): t is Task => t !== null);
  }

  // A search is a global "find tasks" action, not a per-view filter — once
  // the owner is searching, don't also restrict results to the currently
  // selected focus view's bucket allow-list (e.g. Today = overdue+today
  // only). Doing so silently hides real matches whose due date falls
  // outside the current view, which reads as a false "No matches" empty
  // state even though the task exists and matched.
  const ALL_BUCKETS = VIEW_BUCKETS.all!;
  const allow = searching ? ALL_BUCKETS : (VIEW_BUCKETS[state.view] ?? ALL_BUCKETS);
  const grouped = new Map<string, Task[]>(BUCKETS.map((b) => [b.key, [] as Task[]]));
  for (const task of open) grouped.get(bucketFor(task, today, weekEnd))!.push(task);
  const byUrgency = (a: Task, b: Task) => {
    if (a.due_at == null && b.due_at != null) return 1;
    if (a.due_at != null && b.due_at == null) return -1;
    if (a.due_at !== b.due_at) return String(a.due_at ?? '').localeCompare(String(b.due_at ?? ''));
    const pa0 = a.priority ?? 0;
    const pb0 = b.priority ?? 0;
    const pa = pa0 > 0 ? pa0 : 10;
    const pb = pb0 > 0 ? pb0 : 10;
    if (pa !== pb) return pa - pb;
    return String(a.title).localeCompare(String(b.title));
  };
  for (const list of grouped.values()) list.sort(byUrgency);

  const tone: Record<string, string> = { overdue: 'danger', today: 'accent' };
  const sections = BUCKETS.filter((b) => allow.has(b.key) && grouped.get(b.key)!.length).map(
    (b) => ({
      key: b.key,
      label: b.label,
      tone: tone[b.key] ?? 'muted',
      count: grouped.get(b.key)!.length,
      rows: grouped.get(b.key)!,
    }),
  );
  return { sections, isEmpty: sections.length === 0 };
}

export function sidebarCounts(data: BoardData): SidebarCountsShape {
  const today = todayStr();
  const open = data.open ?? [];
  return {
    today: open.filter((t) => t.due_at && String(t.due_at).slice(0, 10) <= today).length,
    upcoming: open.filter((t) => t.due_at && String(t.due_at).slice(0, 10) > today).length,
    anytime: open.filter((t) => !t.due_at).length,
    all: open.length,
    logbook: (data.logbook ?? []).length,
  };
}

export function todayProgress(data: BoardData): TodayProgress {
  const today = todayStr();
  const counts = sidebarCounts(data);
  const doneToday = (data.logbook ?? []).filter(
    (t) =>
      t.status === 'completed' && t.completed_at && String(t.completed_at).slice(0, 10) === today,
  ).length;
  const total = doneToday + counts.today;
  const pct = total ? Math.round((doneToday / total) * 100) : 0;
  return { pct, label: total === 0 ? 'Nothing due today' : `${doneToday} of ${total} done` };
}
