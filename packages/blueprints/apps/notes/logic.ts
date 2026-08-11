import { createPendingOverlayModel } from "../_shared/pending-overlay.ts";
import type { PendingRowState } from "../_shared/pending-overlay.ts";
import { checkStats, previewText } from "./format.ts";
// governance: allow-repo-hygiene file-size-limit cohesive non-visual notes logic module; vault IO, notebook navigation/CRUD, note commands, and the pending-write overlay share the vault predicate translation
// Non-visual business logic: vault IO (write/act), notebook navigation,
// notebook CRUD with the vault's predicates translated to sentences, the
// quick-add/pin/move/delete note commands, the pending-write overlay (issue
// #738) and search. `createLogic` closes over app.tsx's own `state`/`data`
// (mutated in place, never reassigned) plus the render/refresh entry points
// app.tsx defines — the same factory shape tasks/logic.ts and agenda/logic.ts
// use. The pure derivations (`sidebarCounts`/`buildWall`) need no closure and
// are exported standalone so components can call them too.
import { debounce, outcomeMessage, statusLine } from "./kit.ts";
import { notesPendingProjection } from "./pending-projection.ts";
import type {
  AppData,
  AppState,
  LogicDeps,
  Nav,
  Note,
  NotePatch,
  SidebarCounts,
} from "./types.ts";

type Friendly = Record<string, string>;

export function createLogic({ state, data, render, refresh }: LogicDeps) {
  // One overlay model per mount (issue #738): every write below mints an
  // intentId, projects it through `notesPendingProjection`, and folds the
  // outcome back in. `restorePending`/`pendingByRowId`/`applyPendingChange`
  // are the three seams app-root.tsx drives (mount/refresh, render, doorbell).
  // Discarding (or taking for a retry/edit) an attention row also clears its
  // DURABLE record through the engine's one port — a row that returns on the
  // next reload was never really discarded. The clear is fire-and-forget by
  // contract, so the failure is narrated here rather than swallowed.
  const pendingModel = createPendingOverlayModel(notesPendingProjection, {
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
  // narrated by the caller (statusLine + the calm accent-rail/pending-chip
  // treatment, not the banner — a designed calm state, not an error);
  // failed/denied surface the plain-language reason, translating a known
  // predicate through `friendly` when the caller supplies one.
  function narrate(
    outcome: VaultOutcome | undefined,
    friendly?: Friendly
  ): boolean {
    if (outcome?.status === "executed") {
      notice("");
      return true;
    }
    if (outcome?.status === "parked") {
      notice("");
      return false;
    }
    if (outcome?.status === "failed" && friendly) {
      const predicate = String(outcome.predicate ?? outcome.reason ?? "");
      const known = Object.keys(friendly).find((k) => predicate.includes(k));
      if (known) {
        notice(friendly[known]!);
        return false;
      }
    }
    notice(outcomeMessage(outcome) ?? "");
    return false;
  }

  /** Rebuild the overlay from local truth — the reload path (issue #738).
   *  TWO durable sources, because a settled write leaves the outbox: the
   *  outbox for what is still in flight, the attention journal for what came
   *  back denied/conflicted/failed. Feature-detected: an older/mock host
   *  without either restores to empty, and attention rows then persist only
   *  in-session from `applyOutcome`. */
  async function restorePending(): Promise<void> {
    const [pending, attention] = await Promise.all([
      window.centraid.pendingWrites?.() ?? [],
      window.centraid.attentionWrites?.() ?? [],
    ]);
    pendingModel.restore(pending);
    pendingModel.restoreAttention(attention);
    render();
  }

  /** The writes that settled without executing and still need an answer —
   *  what `components/Attention.tsx` renders above the wall. */
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
   *  onto that failure instead of trying again. Whatever the resend settles
   *  as lands back on its own row, so this never narrates twice. */
  async function retryPending(
    intentId: string
  ): Promise<VaultOutcome | undefined> {
    const retry = pendingModel.takeForRetry(intentId);
    if (!retry) return undefined;
    render();
    const outcome = await act(retry.action, retry.input);
    render();
    return outcome;
  }

  /**
   * The third answer beside retry and discard: put the refused payload back
   * in the COMPOSER so it can be corrected before it is resent. Notes' one
   * composer is the quick-add card, and it composes a NEW note — so only a
   * refused `create-note` can be reopened there.
   *
   * `edit-note` is deliberately not editable here even though the editor
   * exists: the editor is bound to the canonical note and autosaves what it
   * shows, so seeding it with a refused body would either resend on the next
   * keystroke or quietly diverge from the note on disk. Retry and discard are
   * the honest pair for it.
   */
  function isEditablePending(row: PendingRowState): boolean {
    return row.action === "create-note" && row.input !== undefined;
  }

  function editPending(intentId: string): boolean {
    const entry = pendingModel.rows().find((row) => row.intentId === intentId);
    if (!entry || !isEditablePending(entry)) return false;
    const taken = pendingModel.takeForRetry(intentId);
    if (!taken) return false;
    state.quickAddDraft = {
      id: intentId,
      title: String(taken.input.title ?? ""),
      body: String(taken.input.body_text ?? ""),
    };
    // The quick-add card is hidden in the pinned/trash scopes and while a
    // search is running (app-root.tsx's `showQuickAdd`) — seeding a draft
    // into a card the member cannot see would silently swallow it.
    if (state.nav.kind === "pinned" || state.nav.kind === "trash")
      state.nav = { kind: "all" };
    if (state.search) {
      state.search = "";
      state.searchResults = null;
    }
    render();
    return true;
  }

  /** The quick-add card seeded a draft and the member sent (or abandoned)
   *  it — the draft is spent, and leaving it set would re-seed the card on
   *  the next render. */
  function clearQuickAddDraft(): void {
    if (!state.quickAddDraft) return;
    state.quickAddDraft = null;
    render();
  }

  /** Row-id → pending state for decorating query rows with the chip
   *  (Wall/Card/Sidebar/Editor call this fresh each render). */
  function pendingByRowId(): Map<string, PendingRowState> {
    return pendingModel.byRowId();
  }

  /** Fold one change-feed event into the overlay; true when the app should
   *  re-render without a full library refetch (app-root.tsx's doorbell). */
  function applyPendingChange(detail: CentraidChangeDetail): boolean {
    return pendingModel.applyChangeDetail(detail);
  }

  // The universal write path (issue #738): mint the intent id, project the
  // app's declared optimistic mutations for it, and fold whatever outcome
  // comes back (or the transport failure) into the model. An action absent
  // from pending-projection.ts projects nothing — `begin()` is a no-op and
  // this is exactly the old fire-and-forget write. Returns the raw outcome so
  // callers narrate/refresh on their own terms (write() below; kit.ts's
  // wireAttachInput via the exported `act`).
  /**
   * The optimistic-concurrency precondition for one write (issue #738 P2):
   * the version of the row this device composed the change against, read
   * from the local replica. Without it a conflict cannot even occur — the
   * vault has nothing to compare — so this is what makes a `conflict`
   * outcome, and its expected-vs-actual row, reachable at all.
   *
   * The row is the one the write actually changes, and it is the same row
   * `pending-projection.ts` keys its overlay on. `create-note` creates and so
   * has nothing to be stale against. `move-note` is included even though its
   * projection carries no field changes — the filing it replaces is a join
   * row this device cannot address, but the note itself is exactly what a
   * second device races.
   */
  const VERSIONED_ROW_OF: Record<string, { entity: string; key: string }> = {
    "edit-note": { entity: "knowledge.note", key: "note_id" },
    "move-note": { entity: "knowledge.note", key: "note_id" },
    "delete-note": { entity: "knowledge.note", key: "note_id" },
    "rename-notebook": { entity: "core.collection", key: "notebook_id" },
    "delete-notebook": { entity: "core.collection", key: "notebook_id" },
  };

  async function baseVersionsFor(
    action: string,
    input: Record<string, unknown>
  ): Promise<CentraidBaseVersion[]> {
    const target = VERSIONED_ROW_OF[action];
    const rowId = target ? input[target.key] : undefined;
    if (!target || typeof rowId !== "string" || !rowId) return [];
    const readVersion = window.centraid.rowVersion;
    if (!readVersion) return [];
    const version = await readVersion({ entity: target.entity, rowId });
    return version === undefined
      ? []
      : [{ entity: target.entity, rowId, version }];
  }

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
      const e = error as { message?: string };
      notice(String(e?.message ?? error));
      return undefined;
    }
  }

  // The generic write: narrate, refresh (full re-read) on anything that
  // changed vault-visible shape. Discrete, infrequent actions (pin, move,
  // delete, notebook CRUD) all go through this — a refetch per click is
  // cheap and keeps counts/wall consistent.
  async function write(
    action: string,
    input: Record<string, unknown>,
    { friendly }: { friendly?: Friendly } = {}
  ): Promise<VaultOutcome | undefined> {
    const outcome = await act(action, input);
    const executed = narrate(outcome, friendly);
    if (outcome?.status === "parked")
      statusLine("Sent to the owner for confirmation.");
    if (executed || outcome?.status === "denied") await refresh();
    else render();
    return outcome;
  }

  // The editor's continuous autosave (debounced while typing) is the one
  // high-frequency write path: a full library refetch every ~700 keystrokes
  // would be wasteful and would flicker the whole card wall mid-type, so a
  // successful save patches the already-loaded row in place instead — the
  // same optimization the pre-React app.js made in its own performSave().
  // Parked/failed autosaves are still narrated in the banner; only the
  // "refetch everything" step is skipped — `act()`'s projection (issue #738)
  // IS the optimistic patch now, composed by the replica on any OTHER read
  // (another mount, a reload) without this one needing to refetch at all.
  async function editNoteAutosave(
    noteId: string,
    patch: NotePatch
  ): Promise<VaultOutcome | undefined> {
    const outcome = await act("edit-note", { note_id: noteId, ...patch });
    if (outcome?.status === "executed") {
      notice("");
      const note = findNote(noteId);
      if (note) {
        if (patch.title != null) note.title = patch.title;
        if (patch.body_text != null) {
          note.body = patch.body_text;
          // Keep the card's preview + checklist tally in step with the edit
          // without a full library refetch (issue #404).
          note.preview = previewText(patch.body_text);
          note.check = checkStats(patch.body_text);
        }
        note.updated_at = new Date().toISOString();
      }
    } else if (outcome?.status === "parked") {
      notice("");
    } else {
      notice(outcomeMessage(outcome) ?? "");
    }
    render();
    return outcome;
  }

  function findNote(noteId: string): Note | null {
    return (
      [...(data.notes ?? []), ...(data.trash ?? [])].find(
        (n) => n.note_id === noteId
      ) ?? null
    );
  }

  function notebookName(notebookId: string): string {
    return (
      (data.notebooks ?? []).find((nb) => nb.notebook_id === notebookId)
        ?.name ?? ""
    );
  }

  // ---------- Navigation ----------

  function selectNav(nav: Nav) {
    state.nav = nav;
    state.editingNotebookId = null;
    state.creatingNotebook = false;
    if (state.search) {
      state.search = "";
      state.searchResults = null;
    }
    document.querySelector("#shell")?.classList.remove("side-open");
    render();
  }

  // Open the editor and lazily pull the canonical body (issue #404: the
  // library projection no longer ships it). The list row is patched in place
  // with `body` so the Editor mounts with content — the editor is keyed on
  // `note_id + body-loaded`, so it remounts once the body arrives. A note
  // whose body is already cached (opened before, or just edited) skips the
  // round trip. A denial/failure leaves the editor usable with an empty body.
  async function openEditor(noteId: string) {
    state.editorId = noteId;
    render();
    const note = findNote(noteId);
    if (!note || typeof note.body === "string") return;
    let res: { body?: unknown; vaultDenied?: unknown } | undefined;
    try {
      res = await window.centraid.read({
        query: "note",
        input: { note_id: noteId },
      });
    } catch {
      return;
    }
    if (state.editorId !== noteId) return; // closed/switched while loading
    const fresh = findNote(noteId);
    if (fresh && res && !res.vaultDenied) {
      fresh.body = typeof res.body === "string" ? res.body : "";
      render();
    }
  }
  function closeEditor() {
    state.editorId = null;
    render();
  }

  // ---------- Quick add ----------

  async function submitQuickAdd({
    title,
    body,
  }: {
    title: string;
    body: string;
  }): Promise<boolean> {
    const t = String(title ?? "").trim();
    const b = String(body ?? "").trim();
    if (!t && !b) {
      notice("Write something first — a title or a first line is enough.");
      return false;
    }
    const finalTitle = t || b.split("\n")[0]!.slice(0, 80);
    const input: Record<string, unknown> = {
      title: finalTitle,
      body_text: b || t,
      format: "markdown",
    };
    if (state.nav.kind === "notebook") input.notebook_id = state.nav.notebookId;
    const outcome = await write("create-note", input);
    if (outcome?.status === "executed") {
      const newId = outcome.output?.note_id;
      statusLine("Note created · receipt", {
        undoLabel: newId ? "Undo" : undefined,
        onUndo: newId
          ? () => void write("delete-note", { note_id: newId })
          : undefined,
      });
    }
    return outcome?.status === "executed" || outcome?.status === "parked";
  }

  // ---------- Note actions ----------

  async function togglePin(note: Note): Promise<VaultOutcome | undefined> {
    const nextPinned = note.pinned === 1 ? 0 : 1;
    const outcome = await write("edit-note", {
      note_id: note.note_id,
      pinned: nextPinned,
    });
    if (outcome?.status === "executed")
      statusLine(nextPinned ? "Pinned · receipt" : "Unpinned · receipt");
    return outcome;
  }

  async function moveNote(
    noteId: string,
    notebookId: string | null
  ): Promise<VaultOutcome | undefined> {
    const input: Record<string, unknown> = { note_id: noteId };
    if (notebookId) input.notebook_id = notebookId;
    const outcome = await write("move-note", input);
    if (outcome?.status === "executed")
      statusLine(notebookId ? "Moved · receipt" : "Unfiled · receipt");
    return outcome;
  }

  async function deleteNote(note: Note): Promise<VaultOutcome | undefined> {
    const outcome = await write("delete-note", { note_id: note.note_id });
    if (outcome?.status === "executed") {
      if (state.editorId === note.note_id) state.editorId = null;
      statusLine(`Moved “${String(note.title ?? "").slice(0, 40)}” to trash`, {
        undoLabel: "Undo",
        onUndo: () => void restoreNote(note.note_id),
        duration: 10_000,
      });
    }
    return outcome;
  }

  async function restoreNote(
    noteId: string
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write("restore-note", { note_id: noteId });
    if (outcome?.status === "executed") {
      if (state.nav.kind === "trash") state.nav = { kind: "all" };
      statusLine("Note restored · receipt");
      render();
    }
    return outcome;
  }

  async function restoreNoteVersion(
    noteId: string,
    contentId: string
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write("restore-note-version", {
      note_id: noteId,
      content_id: contentId,
    });
    if (outcome?.status === "executed") {
      const note = findNote(noteId);
      if (note) delete note.body;
      statusLine("Earlier version restored · receipt");
      await openEditor(noteId);
    }
    return outcome;
  }

  // ---------- Notebooks ----------
  // The vault's predicates, translated. Rename refuses a name already used
  // by another of the owner's notebooks; delete refuses while children exist.
  const RENAME_NOTEBOOK_FRIENDLY: Friendly = {
    name_unused_by_owner: "You already have a notebook with that name.",
  };
  const CREATE_NOTEBOOK_FRIENDLY: Friendly = {
    name_unused: "You already have a notebook with that name.",
  };
  const DELETE_NOTEBOOK_FRIENDLY: Friendly = {
    notebook_has_no_children:
      "This notebook still has notebooks inside it — delete or move those first.",
  };

  // Each of these three mutates state AFTER `write()` has already resolved
  // (and `write()`'s own executed/refresh path has already rendered once
  // with the OLD state) — so every branch below needs its own explicit
  // render() to actually reach the screen; without it the nav switch /
  // form-close / editing-clear silently sits in `state` until some later,
  // unrelated render happens to flush it.
  async function createNotebook(
    name: string
  ): Promise<VaultOutcome | undefined> {
    const n = String(name ?? "").trim();
    if (!n) return undefined;
    const outcome = await write(
      "create-notebook",
      { name: n },
      { friendly: CREATE_NOTEBOOK_FRIENDLY }
    );
    if (outcome?.status === "executed") {
      state.nav = {
        kind: "notebook",
        notebookId: String(outcome.output?.notebook_id ?? ""),
      };
      state.creatingNotebook = false;
      statusLine("Notebook created · receipt");
      render();
    }
    return outcome;
  }

  async function renameNotebook(
    notebookId: string,
    name: string
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write(
      "rename-notebook",
      { notebook_id: notebookId, name },
      { friendly: RENAME_NOTEBOOK_FRIENDLY }
    );
    if (outcome?.status === "executed") {
      state.editingNotebookId = null;
      statusLine("Notebook renamed · receipt");
      render();
    }
    return outcome;
  }

  async function deleteNotebook(
    notebookId: string
  ): Promise<VaultOutcome | undefined> {
    const outcome = await write(
      "delete-notebook",
      { notebook_id: notebookId },
      { friendly: DELETE_NOTEBOOK_FRIENDLY }
    );
    if (outcome?.status === "executed") {
      const unfiled = Number(outcome.output?.notes_unfiled ?? 0);
      if (
        state.nav.kind === "notebook" &&
        state.nav.notebookId === notebookId
      ) {
        state.nav = { kind: "all" };
        render();
      }
      statusLine(
        `Notebook deleted — ${unfiled} ${unfiled === 1 ? "note" : "notes"} unfiled`
      );
    }
    return outcome;
  }

  // ---------- Attachments (kit.ts renderAttachments / wireAttachInput) ----------

  let attachTarget: string | null = null;
  const setAttachTarget = (noteId: string | null) => {
    attachTarget = noteId;
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
    noteId: string,
    label: string
  ): Promise<VaultOutcome | undefined> {
    const l = String(label ?? "").trim();
    if (!l) return undefined;
    const outcome = await act("add-tag", { note_id: noteId, label: l });
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

  async function linkNote(
    noteId: string,
    target: { type: string; id: string },
    anchor: {
      exact: string;
      prefix: string;
      suffix: string;
      start: number;
    }
  ): Promise<void> {
    const outcome = await act("link", {
      note_id: noteId,
      target_type: target.type,
      target_id: target.id,
      ...anchor,
    });
    if (narrate(outcome) || outcome?.status === "denied") await refresh();
    else render();
  }

  // ---------- Search ----------

  let searchSeq = 0;
  const applySearchInput = debounce(async (raw: string) => {
    state.search = raw;
    if (!raw.trim()) {
      state.searchResults = null;
      notice("");
      render();
      return;
    }
    const seq = ++searchSeq;
    let rows: Note[] = [];
    // A denied/broken search must not look like "no matches" — the same
    // honesty app.tsx's refresh() already gives the library read.
    let deniedMessage = "";
    try {
      const res = await window.centraid.read<{
        notes?: Note[];
        vaultDenied?: { message?: string };
      }>({ query: "search", input: { term: raw } });
      if (res?.vaultDenied) {
        deniedMessage =
          res.vaultDenied.message || "The vault denied this search.";
      } else {
        rows = res?.notes ?? [];
      }
    } catch {
      deniedMessage = "Couldn’t reach the vault — retrying when you come back.";
    }
    if (seq !== searchSeq) return;
    state.searchResults = rows;
    notice(deniedMessage);
    render();
  }, 120);

  function clearSearch() {
    searchSeq += 1;
    state.search = "";
    state.searchResults = null;
    render();
  }

  return {
    notice,
    narrate,
    write,
    act,
    editNoteAutosave,
    findNote,
    notebookName,
    selectNav,
    openEditor,
    closeEditor,
    submitQuickAdd,
    togglePin,
    moveNote,
    deleteNote,
    restoreNote,
    restoreNoteVersion,
    createNotebook,
    renameNotebook,
    deleteNotebook,
    setAttachTarget,
    getAttachTarget,
    removeAttachment,
    addTag,
    removeTag,
    linkNote,
    applySearchInput,
    clearSearch,
    restorePending,
    pendingByRowId,
    attentionRows,
    dismissPending,
    retryPending,
    editPending,
    isEditablePending,
    clearQuickAddDraft,
    applyPendingChange,
  };
}

// ---------- Pure derivations (no closure — components may call directly) ----------

/** Sidebar summary. `all`/`checks` are bounded by the library window (honest
 * about the projection's own edge — see data.window/truncated); `pinned`
 * is exact (the library query always includes every pinned note beside the
 * window) and `notebooks` is exact (notebooks are never windowed). */
export function sidebarCounts(data: AppData): SidebarCounts {
  const notes = data.notes ?? [];
  return {
    all: notes.length,
    pinned: notes.filter((n) => n.pinned === 1).length,
    trash: (data.trash ?? []).length,
    notebooks: (data.notebooks ?? []).length,
    checks: notes.reduce((sum, n) => {
      // The list projection ships a `check` tally (issue #404); fall back to
      // deriving from a full `body` when an older payload carried one.
      const s = n.check ?? checkStats(n.body);
      return sum + (s.total - s.done);
    }, 0),
  };
}

/** The rows the active nav scope shows: the vault's ranked search matches
 * while a term is active (the library copy is only the browse view), else
 * the library window — either narrowed to the active notebook/pinned scope. */
export function scopedRows(data: AppData, state: AppState): Note[] {
  let rows =
    state.nav.kind === "trash"
      ? (data.trash ?? [])
      : state.search.trim()
        ? (state.searchResults ?? [])
        : (data.notes ?? []);
  if (state.nav.kind === "pinned") rows = rows.filter((n) => n.pinned === 1);
  else if (state.nav.kind === "notebook") {
    const notebookId = state.nav.notebookId;
    rows = rows.filter((n) => (n.notebook_ids ?? []).includes(notebookId));
  } else if (state.nav.kind === "tag") {
    const conceptId = state.nav.conceptId;
    rows = rows.filter((n) =>
      (n.tags ?? []).some((t) => t.concept_id === conceptId)
    );
  }
  return rows;
}

/** notebook_id → note count within the library window — the same bounded
 * honesty as sidebarCounts' `all`/`checks`. */
export function notebookNoteCounts(data: AppData): Map<string, number> {
  const map = new Map<string, number>();
  for (const n of data.notes ?? []) {
    for (const id of n.notebook_ids ?? []) map.set(id, (map.get(id) ?? 0) + 1);
  }
  return map;
}

/** concept_id → note count within the library window, same bounded honesty. */
export function tagNoteCounts(data: AppData): Map<string, number> {
  const map = new Map<string, number>();
  for (const n of data.notes ?? []) {
    for (const t of n.tags ?? [])
      map.set(t.concept_id, (map.get(t.concept_id) ?? 0) + 1);
  }
  return map;
}

export function buildWall(data: AppData, state: AppState) {
  const rows = scopedRows(data, state);
  const searching = Boolean(state.search.trim());
  const showPinnedGroup =
    state.nav.kind !== "pinned" &&
    !searching &&
    rows.some((n) => n.pinned === 1);
  const pinned = showPinnedGroup ? rows.filter((n) => n.pinned === 1) : [];
  const others = showPinnedGroup ? rows.filter((n) => n.pinned !== 1) : rows;

  let emptyTitle = "No notes yet";
  let emptySub = "Take a note above — it lands as a typed vault command.";
  if (searching) {
    emptyTitle = "No matches";
    emptySub = `No notes match “${state.search.trim()}”. Search covers titles and contents.`;
  } else if (state.nav.kind === "pinned") {
    emptyTitle = "Nothing pinned yet";
    emptySub = "Pin a note from its card or the editor to keep it up top.";
  } else if (state.nav.kind === "notebook") {
    emptyTitle = "This notebook is empty";
    emptySub =
      "Take a note above — it lands filed straight into this notebook.";
  } else if (state.nav.kind === "trash") {
    emptyTitle = "Trash is empty";
    emptySub = "Deleted notes stay recoverable here for 30 days.";
  }

  return {
    pinned,
    others,
    showPinnedGroup,
    isEmpty: rows.length === 0,
    emptyTitle,
    emptySub,
  };
}
