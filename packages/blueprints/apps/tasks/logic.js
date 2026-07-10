// Non-visual business logic: vault IO (write/act), the board-section
// derivation, sidebar counts, the session activity log and parked-write
// tracking. `createLogic` closes over app.jsx's own `state`/`data` (mutated
// in place, never reassigned) plus the render/refresh entry points app.jsx
// defines — the same factory shape docs/logic.js and nav.js use. The pure
// derivation helpers (`buildSections`/`sidebarCounts`/`todayProgress`) need
// no closure and are exported standalone so components can call them too.
import { debounce, outcomeMessage, toast } from './kit.js';
import { BUCKETS, VIEW_BUCKETS, bucketFor, parseNlDue, plusDays, todayStr } from './format.js';

export function createLogic({ state, data, render, refresh }) {
  function notice(text) {
    const el = document.getElementById('noticeBanner');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  // Executed clears the banner and tells the caller to refresh; parked is
  // narrated by the caller (toast + per-row pending chip, not the banner —
  // this is a designed calm state, not an error); failed/denied surface the
  // plain-language reason in the banner.
  function narrate(outcome) {
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

  function markPending(action, input, outcome) {
    if (action === 'add') {
      state.pendingAdds.push({
        key: outcome?.invocationId ?? `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: input.title,
        due_at: input.due_at ?? null,
        priority: input.priority ?? 0,
        parent_task_id: input.parent_task_id ?? null,
      });
      return;
    }
    const id = input.task_id ?? input.subject_id;
    if (id) state.pendingIds.add(id);
  }

  function clearPending() {
    state.pendingIds.clear();
    state.pendingAdds = [];
  }

  function logActivity(taskId, text, outcome) {
    if (!taskId) return;
    const list = state.activityLog.get(taskId) ?? [];
    list.unshift({ text, when: 'Today', receiptId: outcome?.receiptId ?? null });
    state.activityLog.set(taskId, list.slice(0, 20));
  }

  async function write(action, input) {
    let outcome;
    try {
      outcome = await window.centraid.write({ action, input });
    } catch (err) {
      notice(String(err?.message ?? err));
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
  // helpers (kit.js wireAttachInput) can narrate and refresh on their own.
  async function act(action, input) {
    try {
      return await window.centraid.write({ action, input });
    } catch (err) {
      notice(String(err?.message ?? err));
      return undefined;
    }
  }

  function findTask(taskId) {
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

  async function submitCapture({ title, dueChoice, priority }) {
    const raw = String(title ?? '').trim();
    if (!raw) return false;
    let cleanTitle = raw;
    let due = null;
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
    const input = { title: cleanTitle };
    if (due) input.due_at = due;
    if (priority > 0) input.priority = priority;
    const outcome = await write('add', input);
    if (outcome?.status === 'executed') {
      const newId = outcome.output?.task_id;
      logActivity(newId, 'Added to your list', outcome);
      // There is no delete_task command in the manifest — the closest honest
      // "undo" for a freshly captured task is cancelling it (files it into
      // the logbook rather than erasing it, same as every other cancel).
      toast('Task added · receipt', {
        undoLabel: newId ? 'Undo' : undefined,
        onUndo: newId ? () => write('set-status', { task_id: newId, status: 'cancelled' }) : undefined,
      });
    }
    return outcome?.status === 'executed' || outcome?.status === 'parked';
  }

  async function addSubtask(parentTaskId, title) {
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

  async function toggleComplete(task) {
    const wasOpen = task.status === 'needs-action' || task.status === 'in-process';
    const nextStatus = wasOpen ? 'completed' : 'needs-action';
    const prevStatus = task.status;
    const outcome = await write('set-status', { task_id: task.task_id, status: nextStatus });
    if (outcome?.status === 'executed') {
      logActivity(task.task_id, nextStatus === 'completed' ? 'Marked complete' : 'Reopened', outcome);
      if (nextStatus === 'completed') {
        toast(`Completed “${task.title}”`, {
          undoLabel: 'Undo',
          onUndo: () => write('set-status', { task_id: task.task_id, status: prevStatus }),
        });
      }
    }
    return outcome?.status === 'executed';
  }

  async function cancelTask(task) {
    const prevStatus = task.status;
    const outcome = await write('set-status', { task_id: task.task_id, status: 'cancelled' });
    if (outcome?.status === 'executed') {
      logActivity(task.task_id, 'Cancelled', outcome);
      toast(`Cancelled “${task.title}”`, {
        undoLabel: 'Undo',
        onUndo: () => write('set-status', { task_id: task.task_id, status: prevStatus }),
      });
    }
    return outcome;
  }

  async function toggleProcess(task) {
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

  async function editField(taskId, patch, { toastText = 'Updated · receipt', activityText } = {}) {
    const outcome = await write('edit', { task_id: taskId, ...patch });
    if (outcome?.status === 'executed') {
      logActivity(taskId, activityText ?? toastText.replace(/\s*·\s*receipt$/, ''), outcome);
      toast(toastText);
    }
    return outcome;
  }

  // ---------- Attachments (kit.js renderAttachments / wireAttachInput) ----------

  let attachTarget = null;
  const setAttachTarget = (taskId) => {
    attachTarget = taskId;
  };
  const getAttachTarget = () => attachTarget;

  async function removeAttachment(attachmentId) {
    const outcome = await act('detach', { attachment_id: attachmentId });
    if (narrate(outcome) || outcome?.status === 'denied') await refresh();
    else render();
    return outcome;
  }

  // ---------- Search ----------

  let searchSeq = 0;
  const applySearchInput = debounce(async (raw) => {
    state.search = raw;
    if (!raw.trim()) {
      state.searchResults = null;
      state.searchSnippets = null;
      render();
      return;
    }
    const seq = ++searchSeq;
    let rows = [];
    try {
      const res = await window.centraid.read({ query: 'search', input: { term: raw } });
      rows = res?.tasks ?? [];
    } catch {
      rows = [];
    }
    if (seq !== searchSeq) return;
    state.searchResults = rows;
    state.searchSnippets = new Map(rows.filter((t) => t.snippet).map((t) => [t.task_id, t.snippet]));
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
    applySearchInput,
    clearSearch,
    clearPending,
  };
}

// ---------- Pure derivations (no closure — components may call directly) ----------

export function buildSections(data, state) {
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
      .map((task) => {
        if (matched.has(task.task_id)) return task;
        const children = (task.children ?? []).filter((c) => matched.has(c.task_id));
        return children.length ? { ...task, children } : null;
      })
      .filter(Boolean);
  }

  const allow = VIEW_BUCKETS[state.view] ?? VIEW_BUCKETS.all;
  const grouped = new Map(BUCKETS.map((b) => [b.key, []]));
  for (const task of open) grouped.get(bucketFor(task, today, weekEnd)).push(task);
  const byUrgency = (a, b) => {
    if (a.due_at == null && b.due_at != null) return 1;
    if (a.due_at != null && b.due_at == null) return -1;
    if (a.due_at !== b.due_at) return String(a.due_at ?? '').localeCompare(String(b.due_at ?? ''));
    const pa = a.priority > 0 ? a.priority : 10;
    const pb = b.priority > 0 ? b.priority : 10;
    if (pa !== pb) return pa - pb;
    return String(a.title).localeCompare(String(b.title));
  };
  for (const list of grouped.values()) list.sort(byUrgency);

  const tone = { overdue: 'danger', today: 'accent' };
  const sections = BUCKETS.filter((b) => allow.has(b.key) && grouped.get(b.key).length).map((b) => ({
    key: b.key,
    label: b.label,
    tone: tone[b.key] ?? 'muted',
    count: grouped.get(b.key).length,
    rows: grouped.get(b.key),
  }));
  return { sections, isEmpty: sections.length === 0 };
}

export function sidebarCounts(data) {
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

export function todayProgress(data) {
  const today = todayStr();
  const counts = sidebarCounts(data);
  const doneToday = (data.logbook ?? []).filter(
    (t) => t.status === 'completed' && t.completed_at && String(t.completed_at).slice(0, 10) === today,
  ).length;
  const total = doneToday + counts.today;
  const pct = total ? Math.round((doneToday / total) * 100) : 0;
  return { pct, label: total === 0 ? 'Nothing due today' : `${doneToday} of ${total} done` };
}
