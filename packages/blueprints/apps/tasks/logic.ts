// governance: allow-repo-hygiene file-size-limit (#630) — this factory is the
// cohesive controller for one blueprint; its board, ordering, and write
// outcomes share the same live app-state closure.
import { createPendingOverlayModel } from "../_shared/pending-overlay.ts";
import type { PendingRowState } from "../_shared/pending-overlay.ts";
import {
  BUCKETS,
  VIEW_BUCKETS,
  bucketFor,
  parseNlDue,
  plusDays,
  todayStr,
} from "./format.ts";
// Non-visual business logic: vault IO (write/act), the board-section
// derivation, sidebar counts, the session activity log and the pending-write
// overlay (issue #738 — createPendingOverlayModel, one instance per mount).
// `createLogic` closes over app.tsx's own `state`/`data` (mutated in place,
// never reassigned) plus the render/refresh entry points app.tsx defines —
// the same factory shape docs/logic.ts and nav.ts use. The pure derivation
// helpers (`buildSections`/`sidebarCounts`/`todayProgress`) need no closure
// and are exported standalone so components can call them too.
import { debounce, outcomeMessage, statusLine } from "./kit.ts";
import { tasksPendingProjection } from "./pending-projection.ts";
import type {
  AppState,
  BoardData,
  BoardSection,
  EditPatch,
  LogicDeps,
  SidebarCountsShape,
  Task,
  TodayProgress,
} from "./types.ts";

/** The capture bar's add payload (mirrors components/Capture.tsx). */
interface CapturePayload {
  title: string;
  dueChoice: string;
  priority: number;
}

export function createLogic({ state, data, render, refresh }: LogicDeps) {
  // One overlay model per mount (issue #738): every write below mints an
  // intentId, projects it through `tasksPendingProjection`, and folds the
  // outcome back in. `restorePending`/`pendingByRowId`/`applyPendingChange`
  // are the three seams app-root.tsx drives (mount/refresh, render, doorbell).
  // Discarding (or retrying) an attention row also clears its durable record,
  // through the engine's one port — a row that returns on the next reload was
  // never really discarded. The clear is fire-and-forget by contract, so the
  // failure is narrated here rather than swallowed.
  const pendingModel = createPendingOverlayModel(tasksPendingProjection, {
    dismissDurable: (intentId) => {
      const forget = window.centraid.dismissAttentionWrite;
      if (!forget) return;
      void forget({ intentId }).catch(() =>
        notice("That change is gone from this view but may return on reload.")
      );
    },
  });

  function notice(text: string) {
    const el = document.querySelector<HTMLElement>("#noticeBanner");
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  // Executed clears the banner and tells the caller to refresh; parked is
  // narrated by the caller (statusLine + per-row pending chip, not the banner —
  // this is a designed calm state, not an error); failed/denied surface the
  // plain-language reason in the banner.
  function narrate(outcome: VaultOutcome | undefined): boolean {
    if (outcome?.status === "executed") {
      notice("");
      return true;
    }
    if (outcome?.status === "parked") {
      notice("");
      return false;
    }
    const message = outcomeMessage(outcome);
    if (message) notice(message);
    return false;
  }

  /** Rebuild the overlay from local truth — the reload path (issue #738).
   *  Two durable sources, because a settled write leaves the outbox: the
   *  outbox for what is still in flight, the attention journal for what came
   *  back denied/conflicted/failed. Feature-detected: an older/mock host
   *  without either restores to empty, and attention rows then persist only
   *  in-session from `applyOutcome`.
   *
   *  `window.centraid` itself is optional here, not defensively: a remount
   *  tears the inline bridge down before the next one installs, so a refresh
   *  already in flight can legitimately outlive the client it started on. */
  async function restorePending(): Promise<void> {
    const [pending, attention] = await Promise.all([
      window.centraid?.pendingWrites?.(),
      window.centraid?.attentionWrites?.(),
    ]);
    // An absent answer is NOT an empty outbox. `restore` prunes rows the
    // durable list omits, so folding "no host surface" or "bridge torn down"
    // into `[]` would delete every queued row — the wipe class #738 exists
    // to end, merely moved from the commons rail to the outbox rail.
    if (pending) pendingModel.restore(pending);
    if (attention) pendingModel.restoreAttention(attention);
    render();
  }

  /** The rows that settled without executing and still need an answer. */
  function attentionRows(): PendingRowState[] {
    return pendingModel.attention();
  }

  /** Discard one — here and in the durable journal (the model's port). */
  function dismissPending(intentId: string): boolean {
    const dismissed = pendingModel.dismiss(intentId);
    if (dismissed) render();
    return dismissed;
  }

  /** Re-issue a refused write under a FRESH intent id: the old id's payload
   *  hash is bound to the attempt that failed, so replaying it would dedupe
   *  onto that failure instead of trying again. */
  async function retryPending(
    intentId: string
  ): Promise<VaultOutcome | undefined> {
    const retry = pendingModel.takeForRetry(intentId);
    if (!retry) return undefined;
    render();
    return write(retry.action, retry.input);
  }

  /** Row-id → pending state for decorating query rows with the chip
   *  (Board/Detail call this fresh each render). */
  function pendingByRowId(): Map<string, PendingRowState> {
    return pendingModel.byRowId();
  }

  /** Fold one change-feed event into the overlay; true when the app should
   *  re-render without a full board refetch (app-root.tsx's doorbell). */
  function applyPendingChange(detail: CentraidChangeDetail): boolean {
    return pendingModel.applyChangeDetail(detail);
  }

  function logActivity(
    taskId: string | undefined,
    text: string,
    outcome: VaultOutcome | undefined
  ) {
    if (!taskId) return;
    const list = state.activityLog.get(taskId) ?? [];
    list.unshift({
      text,
      when: "Today",
      receiptId: outcome?.receiptId ?? null,
    });
    state.activityLog.set(taskId, list.slice(0, 20));
  }

  /** Writes that change a row that already exists — the ones a second device
   *  can race. A create has nothing to be stale against. */
  const VERSIONED_ACTIONS = new Set(["edit", "set-status"]);

  /**
   * The optimistic-concurrency precondition for one write (issue #738 P2):
   * the version of the row this device composed the edit against, read from
   * the local replica. Without it a conflict cannot even occur — the vault
   * has nothing to compare — so this is what makes a `conflict` outcome, and
   * its expected-vs-actual row, reachable at all.
   *
   * Empty is the honest answer in three cases, and none of them fake a
   * version: a create, a host without the version surface, and a row the
   * replica has no canonical version for (an unsettled pending-* row, or a
   * shape whose identity is opaque). A failure to READ the local replica is
   * NOT one of those — it propagates and settles the write as failed, which
   * is retryable, rather than silently downgrading to last-write-wins.
   */
  async function baseVersionsFor(
    action: string,
    input: Record<string, unknown>
  ): Promise<CentraidBaseVersion[]> {
    const taskId = input.task_id;
    if (!VERSIONED_ACTIONS.has(action) || typeof taskId !== "string") return [];
    const readVersion = window.centraid.rowVersion;
    if (!readVersion) return [];
    const version = await readVersion({
      entity: "schedule.task",
      rowId: taskId,
    });
    return version === undefined
      ? []
      : [{ entity: "schedule.task", rowId: taskId, version }];
  }

  // The universal write path (issue #738): mint the intent id, project the
  // app's declared optimistic mutations for it, and fold whatever outcome
  // comes back (or the transport failure) into the model. An action absent
  // from pending-projection.ts projects nothing — `begin()` is a no-op and
  // this is exactly the old fire-and-forget write. Returns the raw outcome so
  // callers narrate/refresh on their own terms (write() below; toggleComplete;
  // kit.ts's wireAttachInput via the exported `act`).
  async function act(
    action: string,
    input: Record<string, unknown>
  ): Promise<VaultOutcome | undefined> {
    const intentId = crypto.randomUUID();
    const optimistic = pendingModel.begin(action, input, intentId);
    try {
      const baseVersions = await baseVersionsFor(action, input);
      const outcome = await window.centraid.write({
        action,
        input,
        intentId,
        ...(optimistic.length > 0 ? { optimistic } : {}),
        ...(baseVersions.length > 0 ? { baseVersions } : {}),
      });
      pendingModel.applyOutcome(outcome.invocationId ?? intentId, {
        status: outcome.status,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        ...(outcome.conflict === undefined
          ? {}
          : { conflict: outcome.conflict }),
      });
      return outcome;
    } catch (error) {
      // The write never reached (or never left) the vault — nothing is
      // durable, so the optimistic entry settles to `failed` rather than
      // hanging as `queued` forever (a dismissible/retryable row, same
      // grammar as a server-reported failure).
      pendingModel.applyOutcome(intentId, { status: "failed" });
      notice(String((error as { message?: unknown })?.message ?? error));
      return undefined;
    }
  }

  async function write(
    action: string,
    input: Record<string, unknown>
  ): Promise<VaultOutcome | undefined> {
    const outcome = await act(action, input);
    const executed = narrate(outcome);
    if (
      (outcome?.status === "executed" || outcome?.status === "queued") &&
      (action === "add" || action === "edit") &&
      input.remind_before_min != null
    ) {
      window.dispatchEvent(new Event("centraid:notification-value"));
      if (window.parent !== window)
        window.parent.postMessage(
          { type: "centraid:notification-value" },
          window.location.origin
        );
    }
    if (outcome?.status === "parked")
      statusLine("Sent to the owner for confirmation.");
    if (executed || outcome?.status === "denied") await refresh();
    else render();
    return outcome;
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

  async function submitCapture({
    title,
    dueChoice,
    priority,
  }: CapturePayload): Promise<boolean> {
    const raw = String(title ?? "").trim();
    if (!raw) return false;
    let cleanTitle = raw;
    let due: string | null = null;
    if (dueChoice === "today") due = todayStr();
    else if (dueChoice === "tomorrow") due = plusDays(1);
    else if (dueChoice === "week") due = plusDays(7);
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
    const outcome = await write("add", input);
    if (outcome?.status === "executed") {
      const newId = outcome.output?.task_id as string | undefined;
      logActivity(newId, "Added to your list", outcome);
      // There is no delete_task command in the manifest — the closest honest
      // "undo" for a freshly captured task is cancelling it (files it into
      // the logbook rather than erasing it, same as every other cancel).
      statusLine("Task added · receipt", {
        undoLabel: newId ? "Undo" : undefined,
        onUndo: newId
          ? () => {
              void write("set-status", { task_id: newId, status: "cancelled" });
            }
          : undefined,
      });
    }
    return outcome?.status === "executed" || outcome?.status === "parked";
  }

  async function addSubtask(
    parentTaskId: string,
    title: string
  ): Promise<VaultOutcome | undefined | null> {
    const raw = String(title ?? "").trim();
    if (!raw) return null;
    const outcome = await write("add", {
      title: raw,
      parent_task_id: parentTaskId,
    });
    if (outcome?.status === "executed") {
      logActivity(parentTaskId, `Added subtask "${raw}"`, outcome);
      statusLine("Subtask added · receipt");
    }
    return outcome;
  }

  // ---------- Projects, sections, and manual order ----------

  async function saveProject(name: string): Promise<boolean> {
    const clean = name.trim();
    if (!clean) return false;
    const outcome = await write("save-project", {
      name: clean,
      sort_order: data.projects.length,
    });
    if (outcome?.status === "executed") statusLine("Project created · receipt");
    return outcome?.status === "executed";
  }

  async function saveSection(
    projectId: string,
    name: string
  ): Promise<boolean> {
    const clean = name.trim();
    if (!clean) return false;
    const outcome = await write("save-section", {
      project_id: projectId,
      name: clean,
      sort_order: data.sections.filter((row) => row.project_id === projectId)
        .length,
    });
    if (outcome?.status === "executed") statusLine("Section created · receipt");
    return outcome?.status === "executed";
  }

  async function organizeTask(
    taskId: string,
    projectId: string | null,
    sectionId: string | null,
    sortOrder: number
  ): Promise<boolean> {
    const outcome = await write("organize-task", {
      task_id: taskId,
      ...(projectId
        ? {
            project_id: projectId,
            ...(sectionId ? { section_id: sectionId } : {}),
          }
        : { clear_project: true }),
      sort_order: sortOrder,
    });
    return outcome?.status === "executed";
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
    const wasOpen =
      task.status === "needs-action" || task.status === "in-process";
    const nextStatus = wasOpen ? "completed" : "needs-action";
    const prevStatus = task.status;
    // Registered for the chip (byRowId) even though this path deliberately
    // never refreshes on its own — the board's own doorbell reconciles it,
    // same as before the overlay engine existed.
    const outcome = await act("set-status", {
      task_id: task.task_id,
      status: nextStatus,
    });
    if (outcome?.status === "executed") {
      notice("");
      logActivity(
        task.task_id,
        nextStatus === "completed" ? "Marked complete" : "Reopened",
        outcome
      );
      if (nextStatus === "completed") {
        statusLine(`Completed “${task.title}”`, {
          undoLabel: "Undo",
          onUndo: () => {
            void write("set-status", {
              task_id: task.task_id,
              status: prevStatus,
            });
          },
        });
      }
      return true;
    }
    if (outcome?.status === "parked") {
      statusLine("Sent to the owner for confirmation.");
      render();
      return false;
    }
    narrate(outcome);
    render();
    return false;
  }

  async function cancelTask(task: Task): Promise<VaultOutcome | undefined> {
    const prevStatus = task.status;
    const outcome = await write("set-status", {
      task_id: task.task_id,
      status: "cancelled",
    });
    if (outcome?.status === "executed") {
      logActivity(task.task_id, "Cancelled", outcome);
      statusLine(`Cancelled “${task.title}”`, {
        undoLabel: "Undo",
        onUndo: () => {
          void write("set-status", {
            task_id: task.task_id,
            status: prevStatus,
          });
        },
      });
    }
    return outcome;
  }

  async function toggleProcess(task: Task): Promise<VaultOutcome | undefined> {
    const inProcess = task.status === "in-process";
    const outcome = await write("set-status", {
      task_id: task.task_id,
      status: inProcess ? "needs-action" : "in-process",
    });
    if (outcome?.status === "executed") {
      logActivity(task.task_id, inProcess ? "Paused" : "Started", outcome);
    }
    return outcome;
  }

  // ---------- Field edits (title / notes / due / priority / effort) ----------

  async function editField(
    taskId: string,
    patch: EditPatch,
    {
      toastText = "Updated · receipt",
      activityText,
    }: { toastText?: string; activityText?: string } = {}
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write("edit", { task_id: taskId, ...patch });
    if (outcome?.status === "executed") {
      logActivity(
        taskId,
        activityText ?? toastText.replace(/\s*·\s*receipt$/u, ""),
        outcome
      );
      statusLine(toastText);
    }
    return outcome;
  }

  // ---------- Attachments (kit.ts renderAttachments / wireAttachInput) ----------

  let attachTarget: string | null = null;
  const setAttachTarget = (taskId: string | null) => {
    attachTarget = taskId;
  };
  const getAttachTarget = () => attachTarget;

  async function removeAttachment(
    attachmentId: string
  ): Promise<VaultOutcome | undefined> {
    const outcome = await act("detach", { attachment_id: attachmentId });
    if (narrate(outcome) || outcome?.status === "denied") await refresh();
    else render();
    return outcome;
  }

  // ---------- Tags ----------

  async function addTag(
    taskId: string,
    label: string
  ): Promise<VaultOutcome | undefined> {
    const l = String(label ?? "").trim();
    if (!l) return undefined;
    const outcome = await act("add-tag", { task_id: taskId, label: l });
    if (narrate(outcome) || outcome?.status === "denied") await refresh();
    else render();
    return outcome;
  }

  async function removeTag(tagId: string): Promise<VaultOutcome | undefined> {
    const outcome = await act("remove-tag", { tag_id: tagId });
    if (narrate(outcome) || outcome?.status === "denied") await refresh();
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
        query: "search",
        input: { term: raw },
      });
      rows = res?.tasks ?? [];
    } catch {
      rows = [];
    }
    if (seq !== searchSeq) return;
    state.searchResults = rows;
    state.searchSnippets = new Map(
      rows
        .filter((t) => t.snippet)
        .map((t) => [t.task_id, t.snippet!] as [string, string])
    );
    render();
  }, 120);

  function clearSearch() {
    searchSeq += 1;
    state.search = "";
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
    saveProject,
    saveSection,
    organizeTask,
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
    restorePending,
    pendingByRowId,
    attentionRows,
    dismissPending,
    retryPending,
    applyPendingChange,
  };
}

// ---------- Pure derivations (no closure — components may call directly) ----------

export function buildSections(
  data: BoardData,
  state: AppState
): { sections: BoardSection[]; isEmpty: boolean } {
  const today = todayStr();
  const weekEnd = plusDays(7);
  const searching = Boolean(state.search.trim());
  const matched = new Set((state.searchResults ?? []).map((t) => t.task_id));

  if (state.view === "logbook") {
    let rows = data.logbook ?? [];
    if (searching) rows = rows.filter((t) => matched.has(t.task_id));
    return {
      sections: rows.length
        ? [
            {
              key: "log",
              label: "Logbook",
              tone: "muted",
              count: rows.length,
              rows,
            },
          ]
        : [],
      isEmpty: rows.length === 0,
    };
  }

  let open = data.open ?? [];
  if (searching) {
    open = open
      .map((task): Task | null => {
        if (matched.has(task.task_id)) return task;
        const children = (task.children ?? []).filter((c) =>
          matched.has(c.task_id)
        );
        return children.length ? { ...task, children } : null;
      })
      .filter((t): t is Task => t !== null);
  }

  if (!searching && state.view === "inbox") {
    const rows = open
      .filter((task) => !task.project_id)
      .toSorted(
        (a, b) =>
          Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) ||
          a.task_id.localeCompare(b.task_id)
      );
    return {
      sections: rows.length
        ? [
            {
              key: "inbox",
              label: "Inbox",
              tone: "muted",
              count: rows.length,
              rows,
            },
          ]
        : [],
      isEmpty: rows.length === 0,
    };
  }

  if (!searching && state.view.startsWith("project:")) {
    const projectId = state.view.slice("project:".length);
    const rows = open.filter((task) => task.project_id === projectId);
    const byOrder = (a: Task, b: Task) =>
      Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0) ||
      a.task_id.localeCompare(b.task_id);
    const projectSections = data.sections
      .filter((section) => section.project_id === projectId)
      .toSorted(
        (a, b) =>
          a.sort_order - b.sort_order ||
          a.section_id.localeCompare(b.section_id)
      );
    const sections = [
      {
        key: `project:${projectId}:loose`,
        label: "No section",
        tone: "muted",
        rows: rows.filter((task) => !task.section_id).toSorted(byOrder),
      },
      ...projectSections.map((section) => ({
        key: section.section_id,
        label: section.name,
        tone: "muted",
        rows: rows
          .filter((task) => task.section_id === section.section_id)
          .toSorted(byOrder),
      })),
    ]
      .filter((section) => section.rows.length > 0)
      .map((section) => ({ ...section, count: section.rows.length }));
    return { sections, isEmpty: rows.length === 0 };
  }

  // A search is a global "find tasks" action, not a per-view filter — once
  // the owner is searching, don't also restrict results to the currently
  // selected focus view's bucket allow-list (e.g. Today = overdue+today
  // only). Doing so silently hides real matches whose due date falls
  // outside the current view, which reads as a false "No matches" empty
  // state even though the task exists and matched.
  const ALL_BUCKETS = VIEW_BUCKETS.all!;
  const allow = searching
    ? ALL_BUCKETS
    : (VIEW_BUCKETS[state.view] ?? ALL_BUCKETS);
  const grouped = new Map<string, Task[]>(
    BUCKETS.map((b) => [b.key, [] as Task[]])
  );
  for (const task of open)
    grouped.get(bucketFor(task, today, weekEnd))!.push(task);
  const byUrgency = (a: Task, b: Task) => {
    if (a.due_at == null && b.due_at != null) return 1;
    if (a.due_at != null && b.due_at == null) return -1;
    if (a.due_at !== b.due_at)
      return String(a.due_at ?? "").localeCompare(String(b.due_at ?? ""));
    const pa0 = a.priority ?? 0;
    const pb0 = b.priority ?? 0;
    const pa = pa0 > 0 ? pa0 : 10;
    const pb = pb0 > 0 ? pb0 : 10;
    if (pa !== pb) return pa - pb;
    return String(a.title).localeCompare(String(b.title));
  };
  for (const list of grouped.values()) list.sort(byUrgency);

  const tone: Record<string, string> = { overdue: "danger", today: "accent" };
  const sections = BUCKETS.filter(
    (b) => allow.has(b.key) && grouped.get(b.key)!.length
  ).map((b) => ({
    key: b.key,
    label: b.label,
    tone: tone[b.key] ?? "muted",
    count: grouped.get(b.key)!.length,
    rows: grouped.get(b.key)!,
  }));
  return { sections, isEmpty: sections.length === 0 };
}

export function sidebarCounts(data: BoardData): SidebarCountsShape {
  const today = todayStr();
  const open = data.open ?? [];
  return {
    inbox: open.filter((task) => !task.project_id).length,
    today: open.filter(
      (t) => t.due_at && String(t.due_at).slice(0, 10) <= today
    ).length,
    upcoming: open.filter(
      (t) => t.due_at && String(t.due_at).slice(0, 10) > today
    ).length,
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
      t.status === "completed" &&
      t.completed_at &&
      String(t.completed_at).slice(0, 10) === today
  ).length;
  const total = doneToday + counts.today;
  const pct = total ? Math.round((doneToday / total) * 100) : 0;
  return {
    pct,
    label: total === 0 ? "Nothing due today" : `${doneToday} of ${total} done`,
  };
}
