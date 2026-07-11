// Non-visual business logic: vault IO (write/act), notebook navigation,
// notebook CRUD with the vault's predicates translated to sentences, the
// quick-add/pin/move/delete note commands, parked-write tracking and search.
// `createLogic` closes over app.jsx's own `state`/`data` (mutated in place,
// never reassigned) plus the render/refresh entry points app.jsx defines —
// the same factory shape tasks/logic.js uses. The pure derivations
// (`sidebarCounts`/`buildWall`) need no closure and are exported standalone
// so components can call them too.
import { debounce, outcomeMessage, toast } from './kit.js';
import { deriveTitle } from './format.js';

export function createLogic({ state, data, render, refresh }) {
  function notice(text) {
    const el = document.getElementById('noticeBanner');
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

  // Executed clears the banner and tells the caller to refresh; parked is
  // narrated by the caller (toast + the calm accent-rail/pending-chip
  // treatment, not the banner — a designed calm state, not an error);
  // failed/denied surface the plain-language reason, translating a known
  // predicate through `friendly` when the caller supplies one.
  function narrate(outcome, friendly) {
    if (outcome?.status === 'executed') {
      notice('');
      return true;
    }
    if (outcome?.status === 'parked') {
      notice('');
      return false;
    }
    if (outcome?.status === 'failed' && friendly) {
      const predicate = String(outcome.predicate ?? outcome.reason ?? '');
      const known = Object.keys(friendly).find((k) => predicate.includes(k));
      if (known) {
        notice(friendly[known]);
        return false;
      }
    }
    notice(outcomeMessage(outcome) ?? '');
    return false;
  }

  function markPending(action, input, outcome) {
    if (action === 'create-note') {
      state.pendingCreates.push({
        key:
          outcome?.invocationId ??
          `pending-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        title: deriveTitle(input.title, input.body_text),
        notebookId: input.notebook_id ?? null,
      });
      return;
    }
    const noteId = input.note_id ?? input.subject_id;
    if (noteId && ['edit-note', 'move-note', 'delete-note', 'attach'].includes(action)) {
      state.pendingNoteIds.add(noteId);
    }
    if (input.notebook_id && (action === 'rename-notebook' || action === 'delete-notebook')) {
      state.pendingNotebookIds.add(input.notebook_id);
    }
  }

  function clearPending() {
    state.pendingNoteIds.clear();
    state.pendingNotebookIds.clear();
    state.pendingCreates = [];
  }

  // The generic write: narrate, mark pending on park, refresh (full re-read)
  // on anything that changed vault-visible shape. Discrete, infrequent
  // actions (pin, move, delete, notebook CRUD, attach/detach) all go through
  // this — a refetch per click is cheap and keeps counts/wall consistent.
  async function write(action, input, { friendly } = {}) {
    let outcome;
    try {
      outcome = await window.centraid.write({ action, input });
    } catch (err) {
      notice(String(err?.message ?? err));
      return undefined;
    }
    const executed = narrate(outcome, friendly);
    if (outcome?.status === 'parked') {
      markPending(action, input, outcome);
      toast('Sent to the owner for confirmation.');
    }
    if (executed || outcome?.status === 'denied') await refresh();
    else render();
    return outcome;
  }

  // Like write(), but returns the raw outcome so shared helpers (kit.js
  // wireAttachInput) can narrate and refresh on their own.
  async function act(action, input) {
    try {
      return await window.centraid.write({ action, input });
    } catch (err) {
      notice(String(err?.message ?? err));
      return undefined;
    }
  }

  // The editor's continuous autosave (debounced while typing) is the one
  // high-frequency write path: a full library refetch every ~700 keystrokes
  // would be wasteful and would flicker the whole card wall mid-type, so a
  // successful save patches the already-loaded row in place instead — the
  // same optimization the pre-React app.js made in its own performSave().
  // Parked/failed autosaves are still narrated in the banner; only the
  // "refetch everything" step is skipped.
  async function editNoteAutosave(noteId, patch) {
    let outcome;
    try {
      outcome = await window.centraid.write({
        action: 'edit-note',
        input: { note_id: noteId, ...patch },
      });
    } catch (err) {
      notice(String(err?.message ?? err));
      return undefined;
    }
    if (outcome?.status === 'executed') {
      notice('');
      const note = findNote(noteId);
      if (note) {
        if (patch.title != null) note.title = patch.title;
        if (patch.body_text != null) note.body = patch.body_text;
        note.updated_at = new Date().toISOString();
      }
    } else if (outcome?.status === 'parked') {
      notice('');
      state.pendingNoteIds.add(noteId);
    } else {
      notice(outcomeMessage(outcome) ?? '');
    }
    render();
    return outcome;
  }

  function findNote(noteId) {
    return (data.notes ?? []).find((n) => n.note_id === noteId) ?? null;
  }

  function notebookName(notebookId) {
    return (data.notebooks ?? []).find((nb) => nb.notebook_id === notebookId)?.name ?? '';
  }

  // ---------- Navigation ----------

  function selectNav(nav) {
    state.nav = nav;
    state.editingNotebookId = null;
    state.creatingNotebook = false;
    if (state.search) {
      state.search = '';
      state.searchResults = null;
    }
    document.getElementById('shell')?.classList.remove('side-open');
    render();
  }

  function openEditor(noteId) {
    state.editorId = noteId;
    render();
  }
  function closeEditor() {
    state.editorId = null;
    render();
  }

  // ---------- Quick add ----------

  async function submitQuickAdd({ title, body }) {
    const t = String(title ?? '').trim();
    const b = String(body ?? '').trim();
    if (!t && !b) {
      notice('Write something first — a title or a first line is enough.');
      return false;
    }
    const finalTitle = t || b.split('\n')[0].slice(0, 80);
    const input = { title: finalTitle, body_text: b || t, format: 'markdown' };
    if (state.nav.kind === 'notebook') input.notebook_id = state.nav.notebookId;
    const outcome = await write('create-note', input);
    if (outcome?.status === 'executed') {
      const newId = outcome.output?.note_id;
      toast('Note created · receipt', {
        undoLabel: newId ? 'Undo' : undefined,
        onUndo: newId ? () => write('delete-note', { note_id: newId }) : undefined,
      });
    }
    return outcome?.status === 'executed' || outcome?.status === 'parked';
  }

  // ---------- Note actions ----------

  async function togglePin(note) {
    const nextPinned = note.pinned === 1 ? 0 : 1;
    const outcome = await write('edit-note', { note_id: note.note_id, pinned: nextPinned });
    if (outcome?.status === 'executed')
      toast(nextPinned ? 'Pinned · receipt' : 'Unpinned · receipt');
    return outcome;
  }

  async function moveNote(noteId, notebookId) {
    const input = { note_id: noteId };
    if (notebookId) input.notebook_id = notebookId;
    const outcome = await write('move-note', input);
    if (outcome?.status === 'executed') toast(notebookId ? 'Moved · receipt' : 'Unfiled · receipt');
    return outcome;
  }

  async function deleteNote(note) {
    const outcome = await write('delete-note', { note_id: note.note_id });
    if (outcome?.status === 'executed') {
      // No restore/undelete command exists in the manifest — delete-note is
      // the only lifecycle step there is. Offering a client-side "Undo" here
      // would fake a vault state that was never asserted, so — unlike
      // create's — this toast never carries one (see tasks/logic.js's
      // cancelTask comment for the analogous case: schedule.task has no
      // delete either, only the closest honest substitute).
      if (state.editorId === note.note_id) state.editorId = null;
      toast(`Deleted “${String(note.title ?? '').slice(0, 40)}”`);
    }
    return outcome;
  }

  // ---------- Notebooks ----------
  // The vault's predicates, translated. Rename refuses a name already used
  // by another of the owner's notebooks; delete refuses while children exist.
  const RENAME_NOTEBOOK_FRIENDLY = {
    name_unused_by_owner: 'You already have a notebook with that name.',
  };
  const CREATE_NOTEBOOK_FRIENDLY = {
    name_unused: 'You already have a notebook with that name.',
  };
  const DELETE_NOTEBOOK_FRIENDLY = {
    notebook_has_no_children:
      'This notebook still has notebooks inside it — delete or move those first.',
  };

  // Each of these three mutates state AFTER `write()` has already resolved
  // (and `write()`'s own executed/refresh path has already rendered once
  // with the OLD state) — so every branch below needs its own explicit
  // render() to actually reach the screen; without it the nav switch /
  // form-close / editing-clear silently sits in `state` until some later,
  // unrelated render happens to flush it.
  async function createNotebook(name) {
    const n = String(name ?? '').trim();
    if (!n) return undefined;
    const outcome = await write(
      'create-notebook',
      { name: n },
      { friendly: CREATE_NOTEBOOK_FRIENDLY },
    );
    if (outcome?.status === 'executed') {
      state.nav = { kind: 'notebook', notebookId: outcome.output?.notebook_id };
      state.creatingNotebook = false;
      toast('Notebook created · receipt');
      render();
    }
    return outcome;
  }

  async function renameNotebook(notebookId, name) {
    const outcome = await write(
      'rename-notebook',
      { notebook_id: notebookId, name },
      { friendly: RENAME_NOTEBOOK_FRIENDLY },
    );
    if (outcome?.status === 'executed') {
      state.editingNotebookId = null;
      toast('Notebook renamed · receipt');
      render();
    }
    return outcome;
  }

  async function deleteNotebook(notebookId) {
    const outcome = await write(
      'delete-notebook',
      { notebook_id: notebookId },
      { friendly: DELETE_NOTEBOOK_FRIENDLY },
    );
    if (outcome?.status === 'executed') {
      const unfiled = Number(outcome.output?.notes_unfiled ?? 0);
      if (state.nav.kind === 'notebook' && state.nav.notebookId === notebookId) {
        state.nav = { kind: 'all' };
        render();
      }
      toast(`Notebook deleted — ${unfiled} ${unfiled === 1 ? 'note' : 'notes'} unfiled`);
    }
    return outcome;
  }

  // ---------- Attachments (kit.js renderAttachments / wireAttachInput) ----------

  let attachTarget = null;
  const setAttachTarget = (noteId) => {
    attachTarget = noteId;
  };
  const getAttachTarget = () => attachTarget;

  async function removeAttachment(attachmentId) {
    const outcome = await act('detach', { attachment_id: attachmentId });
    if (narrate(outcome) || outcome?.status === 'denied') await refresh();
    else render();
    return outcome;
  }

  // ---------- Tags ----------

  async function addTag(noteId, label) {
    const l = String(label ?? '').trim();
    if (!l) return undefined;
    const outcome = await act('add-tag', { note_id: noteId, label: l });
    if (narrate(outcome) || outcome?.status === 'denied') await refresh();
    else render();
    return outcome;
  }

  async function removeTag(tagId) {
    const outcome = await act('remove-tag', { tag_id: tagId });
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
      notice('');
      render();
      return;
    }
    const seq = ++searchSeq;
    let rows = [];
    // A denied/broken search must not look like "no matches" — the same
    // honesty app.jsx's refresh() already gives the library read.
    let deniedMessage = '';
    try {
      const res = await window.centraid.read({ query: 'search', input: { term: raw } });
      if (res?.vaultDenied) {
        deniedMessage = res.vaultDenied.message || 'The vault denied this search.';
      } else {
        rows = res?.notes ?? [];
      }
    } catch {
      deniedMessage = 'Couldn’t reach the vault — retrying when you come back.';
    }
    if (seq !== searchSeq) return;
    state.searchResults = rows;
    notice(deniedMessage);
    render();
  }, 120);

  function clearSearch() {
    searchSeq += 1;
    state.search = '';
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
    createNotebook,
    renameNotebook,
    deleteNotebook,
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

import { checkStats } from './format.js';

/** Sidebar summary. `all`/`checks` are bounded by the library window (honest
 * about the projection's own edge — see data.window/truncated); `pinned`
 * is exact (the library query always includes every pinned note beside the
 * window) and `notebooks` is exact (notebooks are never windowed). */
export function sidebarCounts(data) {
  const notes = data.notes ?? [];
  return {
    all: notes.length,
    pinned: notes.filter((n) => n.pinned === 1).length,
    notebooks: (data.notebooks ?? []).length,
    checks: notes.reduce((sum, n) => {
      const s = checkStats(n.body);
      return sum + (s.total - s.done);
    }, 0),
  };
}

/** The rows the active nav scope shows: the vault's ranked search matches
 * while a term is active (the library copy is only the browse view), else
 * the library window — either narrowed to the active notebook/pinned scope. */
export function scopedRows(data, state) {
  let rows = state.search.trim() ? (state.searchResults ?? []) : (data.notes ?? []);
  if (state.nav.kind === 'pinned') rows = rows.filter((n) => n.pinned === 1);
  else if (state.nav.kind === 'notebook') {
    rows = rows.filter((n) => (n.notebook_ids ?? []).includes(state.nav.notebookId));
  } else if (state.nav.kind === 'tag') {
    rows = rows.filter((n) => (n.tags ?? []).some((t) => t.concept_id === state.nav.conceptId));
  }
  return rows;
}

/** notebook_id → note count within the library window — the same bounded
 * honesty as sidebarCounts' `all`/`checks`. */
export function notebookNoteCounts(data) {
  const map = new Map();
  for (const n of data.notes ?? []) {
    for (const id of n.notebook_ids ?? []) map.set(id, (map.get(id) ?? 0) + 1);
  }
  return map;
}

/** concept_id → note count within the library window, same bounded honesty. */
export function tagNoteCounts(data) {
  const map = new Map();
  for (const n of data.notes ?? []) {
    for (const t of n.tags ?? []) map.set(t.concept_id, (map.get(t.concept_id) ?? 0) + 1);
  }
  return map;
}

export function buildWall(data, state) {
  const rows = scopedRows(data, state);
  const searching = Boolean(state.search.trim());
  const showPinnedGroup =
    state.nav.kind !== 'pinned' && !searching && rows.some((n) => n.pinned === 1);
  const pinned = showPinnedGroup ? rows.filter((n) => n.pinned === 1) : [];
  const others = showPinnedGroup ? rows.filter((n) => n.pinned !== 1) : rows;

  let emptyTitle = 'No notes yet';
  let emptySub = 'Take a note above — it lands as a typed vault command.';
  if (searching) {
    emptyTitle = 'No matches';
    emptySub = `No notes match “${state.search.trim()}”. Search covers titles and contents.`;
  } else if (state.nav.kind === 'pinned') {
    emptyTitle = 'Nothing pinned yet';
    emptySub = 'Pin a note from its card or the editor to keep it up top.';
  } else if (state.nav.kind === 'notebook') {
    emptyTitle = 'This notebook is empty';
    emptySub = 'Take a note above — it lands filed straight into this notebook.';
  }

  return { pinned, others, showPinnedGroup, isEmpty: rows.length === 0, emptyTitle, emptySub };
}
