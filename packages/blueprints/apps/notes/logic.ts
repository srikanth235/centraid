// governance: allow-repo-hygiene file-size-limit #864 keyed save flush and lazy history belong with the other writes
import { debounce, outcomeMessage } from "@centraid/design/elements";

import { coalesceByKey } from "./draft-writes.ts";
import { checkStats, deriveTitle, promote, UNTITLED_NOTE } from "./format.ts";
import { sendLineToTasks } from "./send-to-tasks.ts";
import { NOTE, TRASH, notebookIdFrom } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type {
  AppData,
  AppState,
  LinkTarget,
  Note,
  NoteVersion,
} from "./types.ts";
import { RENAME_REFUSAL, notebookDeleted } from "./view-copy.ts";

type Friendly = Record<string, string>;

const NOTEBOOK_NAME_FRIENDLY: Friendly = {
  name_unused_by_owner: RENAME_REFUSAL,
  name_unused: RENAME_REFUSAL,
};

const DELETE_NOTEBOOK_FRIENDLY: Friendly = {
  notebook_has_no_children:
    "Delete or move the notebooks inside this one first",
};

function predicateOf(outcome: VaultOutcome | undefined): string {
  return String(outcome?.predicate ?? outcome?.reason ?? "");
}

export interface LogicDeps {
  state: AppState;
  data: AppData;
  render: () => void;
  refresh: () => Promise<void> | void;
  status: (text: string, undo?: () => void) => void;
  go: (shelf: ShelfId) => void;
}

export function createLogic({
  state,
  data,
  render,
  refresh,
  status,
  go,
}: LogicDeps) {
  function notice(text: string): void {
    const el = document.querySelector<HTMLElement>("#noticeBanner");
    if (!el) return;
    el.textContent = text;
    el.hidden = !text;
  }

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
      const predicate = predicateOf(outcome);
      const known = Object.keys(friendly).find((key) =>
        predicate.includes(key)
      );
      if (known) {
        status(friendly[known]!);
        return false;
      }
    }
    const message = outcomeMessage(outcome) ?? "";
    if (message) status(message);
    return false;
  }

  async function act(
    action: string,
    input: Record<string, unknown>
  ): Promise<VaultOutcome | undefined> {
    try {
      return await window.centraid.write({ action, input });
    } catch (error) {
      notice(String((error as { message?: string })?.message ?? error));
      return undefined;
    }
  }

  const persistSave = async (
    noteId: string,
    patch: { title?: string; body_text?: string }
  ): Promise<void> => {
    const outcome = await act("edit-note", { note_id: noteId, ...patch });
    const note = findNote(noteId);
    if (outcome?.status === "executed") {
      notice("");
      if (note) {
        if (patch.title != null) note.title = patch.title;
        if (patch.body_text != null) {
          note.body = patch.body_text;
          note.preview = promote({
            title: "",
            body: patch.body_text,
          }).preview;
          note.check = checkStats(patch.body_text);
        }
        note.updated_at = new Date().toISOString();
      }
    } else if (outcome?.status === "parked") {
      notice("");
      state.queued += 1;
    } else {
      narrate(outcome);
    }
    render();
  };

  const { run: saveNote, flush: flushSave } = coalesceByKey(
    persistSave,
    (noteId) => noteId,
    600,
    (previous, next) => {
      const merged: [string, { title?: string; body_text?: string }] = [
        previous[0],
        { ...previous[1], ...next[1] },
      ];
      return merged;
    }
  );

  async function write(
    action: string,
    input: Record<string, unknown>,
    friendly?: Friendly
  ): Promise<VaultOutcome | undefined> {
    await flushSave();
    const outcome = await act(action, input);
    narrate(outcome, friendly);
    if (outcome?.status === "parked") state.queued += 1;
    if (outcome) await refresh();
    else render();
    return outcome;
  }

  function findNote(noteId: string): Note | null {
    return (
      [...data.notes, ...data.trash, ...data.journal].find(
        (note) => note.note_id === noteId
      ) ?? null
    );
  }

  function notebookName(notebookId: string): string {
    return (
      data.notebooks.find((book) => book.notebook_id === notebookId)?.name ?? ""
    );
  }

  async function openNote(noteId: string): Promise<void> {
    state.noteId = noteId;
    state.versions = null;
    go(NOTE);
    await flushSave();
    const note = findNote(noteId);
    const history = loadHistory(noteId);
    if (!note || typeof note.body === "string") {
      await history;
      return;
    }
    let answer: { body?: unknown; vaultDenied?: unknown } | undefined;
    try {
      answer = await window.centraid.read({
        query: "note",
        input: { note_id: noteId },
      });
    } catch {
      await history;
      return;
    }
    if (state.noteId !== noteId) {
      await history;
      return;
    }
    const fresh = findNote(noteId);
    if (fresh && answer && !answer.vaultDenied) {
      fresh.body = typeof answer.body === "string" ? answer.body : "";
      render();
    }
    await history;
  }

  async function loadHistory(noteId: string): Promise<void> {
    let answer: { versions?: NoteVersion[] } | undefined;
    try {
      answer = await window.centraid.read({
        query: "history",
        input: { note_id: noteId },
      });
    } catch {
      if (state.noteId != null && state.noteId !== noteId) return;
      state.versions = null;
      render();
      return;
    }
    if (state.noteId != null && state.noteId !== noteId) return;
    state.versions = answer?.versions ?? [];
    render();
  }

  async function createNote(seed = ""): Promise<string | null> {
    const input: Record<string, unknown> = {
      title: deriveTitle("", seed) || UNTITLED_NOTE,
      body_text: seed || " ",
      format: "markdown",
    };
    const notebookId = notebookIdFrom(state.shelf);
    if (notebookId) input.notebook_id = notebookId;
    const outcome = await write("create-note", input);
    const noteId = outcome?.output?.note_id;
    if (typeof noteId === "string" && noteId) {
      await openNote(noteId);
      return noteId;
    }
    return null;
  }

  async function togglePin(note: Note): Promise<void> {
    const pinned = note.pinned === 1 ? 0 : 1;
    await write("edit-note", { note_id: note.note_id, pinned });
  }

  async function moveNote(
    noteId: string,
    notebookId: string | null
  ): Promise<void> {
    const input: Record<string, unknown> = { note_id: noteId };
    if (notebookId) input.notebook_id = notebookId;
    await write("move-note", input);
  }

  async function deleteNote(note: Note): Promise<void> {
    const outcome = await write("delete-note", { note_id: note.note_id });
    if (outcome?.status !== "executed") return;
    if (state.noteId === note.note_id) state.noteId = null;
    status("Moved to trash", () => void restoreNote(note.note_id));
  }

  async function restoreNote(noteId: string): Promise<void> {
    const outcome = await write("restore-note", { note_id: noteId });
    if (outcome?.status === "executed") status("Restored in place");
  }

  async function restoreVersion(
    noteId: string,
    contentId: string
  ): Promise<void> {
    const outcome = await write("restore-note-version", {
      note_id: noteId,
      content_id: contentId,
    });
    if (outcome?.status !== "executed") return;
    const note = findNote(noteId);
    if (note) delete note.body;
    await loadHistory(noteId);
    await openNote(noteId);
  }

  async function createNotebook(name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) return;
    const outcome = await write(
      "create-notebook",
      { name: trimmed },
      NOTEBOOK_NAME_FRIENDLY
    );
    if (outcome?.status === "executed") state.creatingNotebook = false;
    render();
  }

  async function renameNotebook(
    notebookId: string,
    name: string
  ): Promise<void> {
    const outcome = await write(
      "rename-notebook",
      { notebook_id: notebookId, name: name.trim() },
      NOTEBOOK_NAME_FRIENDLY
    );
    if (outcome?.status === "executed") state.renamingNotebookId = null;
    render();
  }

  async function deleteNotebook(notebookId: string): Promise<void> {
    const outcome = await write(
      "delete-notebook",
      { notebook_id: notebookId },
      DELETE_NOTEBOOK_FRIENDLY
    );
    if (outcome?.status !== "executed") return;
    status(notebookDeleted(Number(outcome.output?.notes_unfiled ?? 0)));
    if (notebookIdFrom(state.shelf) === notebookId) go(null);
  }

  async function addTag(noteId: string, label: string): Promise<void> {
    const trimmed = label.trim();
    if (!trimmed) return;
    await write("add-tag", { note_id: noteId, label: trimmed });
  }

  async function removeTag(tagId: string): Promise<void> {
    await write("remove-tag", { tag_id: tagId });
  }

  async function linkNote(
    noteId: string,
    target: LinkTarget,
    anchor: {
      exact: string;
      prefix: string;
      suffix: string;
      start: number;
    } | null
  ): Promise<void> {
    const input: Record<string, unknown> = {
      note_id: noteId,
      target_type: target.type,
      target_id: target.id,
    };
    if (anchor && anchor.exact) {
      input.exact = anchor.exact;
      input.prefix = anchor.prefix;
      input.suffix = anchor.suffix;
      input.start = anchor.start;
    }
    await write("link", input);
  }

  async function attachFile(noteId: string, file: File): Promise<void> {
    const dataUri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("error", () => reject(new Error("unreadable")));
      reader.addEventListener("load", () =>
        resolve(String(reader.result ?? ""))
      );
      reader.readAsDataURL(file);
    }).catch(() => "");
    if (!dataUri) {
      status("That file could not be read on this device");
      return;
    }
    await write("attach", {
      subject_id: noteId,
      data_uri: dataUri,
      title: file.name,
      role: "embed",
    });
  }

  async function removeAttachment(attachmentId: string): Promise<void> {
    await write("detach", { attachment_id: attachmentId });
  }

  async function toggleCheck(noteId: string, line: number): Promise<void> {
    const note = findNote(noteId);
    if (!note || typeof note.body !== "string") return;
    const lines = note.body.split("\n");
    const source = lines[line];
    if (source === undefined) return;
    const match = /^(?<lead>\s*[-*] \[)(?<mark> |x|X)(?<tail>\].*)$/u.exec(
      source
    );
    if (!match) return;
    const done = /x/iu.test(match.groups?.mark ?? "");
    lines[line] =
      `${match.groups?.lead ?? ""}${done ? " " : "x"}${match.groups?.tail ?? ""}`;
    const body = lines.join("\n");
    note.body = body;
    note.check = checkStats(body);
    render();
    saveNote(noteId, { body_text: body });
  }

  const runSearch = debounce(async (term: string) => {
    const trimmed = term.trim();
    state.search = trimmed;
    if (!trimmed) {
      state.searchResults = null;
      state.searchStatus = "resting";
      render();
      return;
    }
    const seq = ++state.searchSeq;
    state.searchStatus = "searching";
    render();
    let rows: Note[] = [];
    let reached = true;
    try {
      const answer = await window.centraid.read<{
        notes?: Note[];
        vaultDenied?: unknown;
      }>({ query: "search", input: { term: trimmed } });
      if (answer?.vaultDenied) reached = false;
      else rows = answer?.notes ?? [];
    } catch {
      reached = false;
    }
    if (seq !== state.searchSeq) return;
    state.searchResults = reached ? rows : null;
    state.searchStatus = reached ? "ready" : "unreachable";
    render();
  }, 150);

  function clearSearch(): void {
    state.searchSeq += 1;
    state.search = "";
    state.searchResults = null;
    state.searchStatus = "resting";
    render();
  }

  const probeTargets = debounce(async (term: string) => {
    const trimmed = term.trim();
    state.powerbox.term = trimmed;
    if (!trimmed) {
      state.powerbox.targets = [];
      render();
      return;
    }
    try {
      const answer = await window.centraid.read<{ targets?: LinkTarget[] }>({
        query: "link-targets",
        input: { term: trimmed },
      });
      state.powerbox.targets = answer?.targets ?? [];
    } catch {
      state.powerbox.targets = [];
    }
    render();
  }, 120);

  return {
    notice,
    narrate,
    act,
    write,
    findNote,
    notebookName,
    openNote,
    loadHistory,
    createNote,
    saveNote,
    flushSave,
    togglePin,
    moveNote,
    deleteNote,
    restoreNote,
    restoreVersion,
    createNotebook,
    renameNotebook,
    deleteNotebook,
    addTag,
    removeTag,
    linkNote,
    attachFile,
    removeAttachment,
    toggleCheck,
    sendLineToTasks: (noteId: string, line: number, text: string) =>
      sendLineToTasks(write, status, { noteId, line, text }),
    runSearch,
    clearSearch,
    probeTargets,
  };
}

export function rowsFor(
  data: AppData,
  state: AppState,
  shelf: ShelfId
): Note[] {
  if (shelf === TRASH) return data.trash;
  let rows = state.search.trim()
    ? (state.searchResults ?? [])
    : (data.notes ?? []);
  const notebookId = notebookIdFrom(shelf);
  if (notebookId)
    rows = rows.filter((note) =>
      (note.notebook_ids ?? []).includes(notebookId)
    );
  if (
    state.search.trim() &&
    state.searchScope === "notebook" &&
    state.scopeNotebookId
  ) {
    const scopeId = state.scopeNotebookId;
    rows = rows.filter((note) => (note.notebook_ids ?? []).includes(scopeId));
  }
  if (state.unfiledOnly)
    rows = rows.filter((note) => (note.notebook_ids ?? []).length === 0);
  if (state.conceptId) {
    const conceptId = state.conceptId;
    rows = rows.filter((note) =>
      (note.tags ?? []).some((tag) => tag.concept_id === conceptId)
    );
  }
  return rows.toSorted(
    (a, b) =>
      (b.pinned ?? 0) - (a.pinned ?? 0) ||
      String(b.updated_at).localeCompare(String(a.updated_at))
  );
}

export function notebookCounts(data: AppData): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of data.notes) {
    for (const id of note.notebook_ids ?? [])
      counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export function unfiledCount(data: AppData): number {
  return data.notes.filter((note) => (note.notebook_ids ?? []).length === 0)
    .length;
}

export function tagCounts(data: AppData): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of data.notes) {
    for (const tag of note.tags ?? [])
      counts.set(tag.concept_id, (counts.get(tag.concept_id) ?? 0) + 1);
  }
  return counts;
}
