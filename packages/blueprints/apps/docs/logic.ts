// Non-visual business logic: data/selection helpers, the plain-DOM popovers
// (kebab / move-to), and every vault write (documents, folders, upload).
//
// This is NOT a component — no JSX, no props-in/props-out contract — but it
// still must never own a second copy of mutable state. `createLogic()` is a
// factory app.tsx calls once at boot, closing over the exact `state`/`data`
// objects app.tsx owns (passed by reference: app.tsx mutates their
// properties in place, never reassigns the bindings, so this module always
// sees the live values) plus the two orchestration entry points, `render`
// and `refresh`, that only app.tsx can define (they touch the JSX-rendering
// roots). Everything returned here is then wired into app.tsx's render
// functions as props/callbacks, exactly like any other value flowing down.
import {
  outcomeMessage,
  runBulk as runBulkBase,
  statusLine,
} from "@centraid/design/elements";

import { applyFilters } from "./filters.ts";
import { typeMeta } from "./format.ts";
import { createMetadata } from "./metadata.ts";
import { createPopovers } from "./popovers.ts";
import { FOLDERS, RECENT, STARRED, TRASH, folderIdFrom } from "./shelves.ts";
import type { AppData, AppState, DriveDoc, Folder } from "./types.ts";
import { createUploads } from "./uploads.ts";
import { createVersions } from "./versions.ts";

const $ = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;

/**
 * HOW MANY ROWS **Recently changed** SHOWS.
 *
 * It is a WINDOW on the drive, not a filter over it: the shelf answers "what
 * did I touch last", and a list of everything sorted by date is the All shelf
 * with a different sort. Exported because the navigation rail's count has to
 * be the number this shelf will actually draw — a rail saying 1,908 over a
 * shelf showing 8 is the count/header disagreement v16 §3 calls a defect.
 */
export const RECENT_WINDOW = 8;
// Bytes stream to the blob staging route (#296) — no base64 through
// command JSON — so big documents fit; the route itself caps at 512 MB.

// The vault speaks in predicates; the drive speaks in plain language. The
// gateway's contract checker (packages/vault/src/gateway/contract.ts) always
// stringifies a failed precondition as `"${name}: ${column} ${op} ${value}"`
// (e.g. "folder_is_empty: n eq 0"), never the bare name — so the lookup below
// keys off the substring before the first ": " rather than the whole string,
// or every entry here would be permanently dead and every failure would show
// the raw predicate/SQL detail instead of this app's own copy.
const FRIENDLY_PREDICATES: Record<string, string> = {
  not_rented_elsewhere:
    "This file is in use elsewhere in your vault (an attachment, a note, an avatar…) — remove it there first.",
  folder_is_empty:
    "Empty the folder first — move or trash its documents (including trashed ones) and delete its subfolders.",
  name_unused_among_siblings: "A folder with that name already exists here.",
};

function predicateName(predicate: unknown): string {
  const s = String(predicate ?? "");
  const i = s.indexOf(":");
  return i === -1 ? s : s.slice(0, i);
}

interface LogicDeps {
  state: AppState;
  data: AppData;
  render: () => void;
  refresh: () => Promise<void> | void;
  openQuick: (id: string) => void;
  /** The row menu names Details and Version history among its verbs, so the
   *  routes behind them are passed in the same way Quick Look already is. */
  openDetails: (id: string) => void;
  openVersions: (id: string) => void;
}

export function createLogic({
  state,
  data,
  render,
  refresh,
  openQuick,
  openDetails,
  openVersions,
}: LogicDeps) {
  function notice(text?: string) {
    const b = $("noticeBanner");
    b.textContent = text || "";
    b.hidden = !text;
  }

  function friendlyOutcome(outcome: VaultOutcome | undefined): string | null {
    return (
      FRIENDLY_PREDICATES[predicateName(outcome?.predicate)] ??
      outcomeMessage(outcome)
    );
  }

  // Returns true when the write executed; otherwise narrates parked / failed
  // / denied honestly and returns false.
  function narrate(outcome: VaultOutcome | undefined): boolean {
    if (outcome?.status === "executed") {
      notice("");
      return true;
    }
    if (outcome?.status === "parked") {
      notice("Sent to the owner for confirmation — it lands once approved.");
    } else if (outcome?.status === "failed") {
      notice(
        FRIENDLY_PREDICATES[predicateName(outcome.predicate)] ??
          `The vault refused: ${outcome.predicate ?? outcome.reason ?? "a precondition failed"}.`
      );
    } else if (outcome?.status === "denied") {
      notice(`Denied by consent: ${outcome.reason ?? ""}`);
    }
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

  // ────────── Data helpers ──────────

  function folderById(id: string | null | undefined): Folder | undefined {
    return data.folders.find((f) => f.folder_id === id);
  }
  // A "selector" closure over `data`, threaded down as a prop wherever a
  // component needs a folder's name (List rows, Details, QuickLook) instead
  // of each one re-deriving the folders map.
  function folderName(id: string | null | undefined): string {
    return id == null ? "Documents" : (folderById(id)?.name ?? "a folder");
  }
  function activeFiles(): DriveDoc[] {
    return data.documents.filter((f) => !f.trashed);
  }
  function trashedFiles(): DriveDoc[] {
    return data.documents.filter((f) => f.trashed);
  }

  // One comparator per sortable column head (`SortKey`). `changed` reads
  // `updated_at`, which is the date the row PRINTS — a set ordered by one date
  // while showing another is the sort lying about itself.
  function compareDocs(a: DriveDoc, b: DriveDoc): number {
    let r = 0;
    if (state.sortKey === "size") r = (a.byte_size ?? 0) - (b.byte_size ?? 0);
    else if (state.sortKey === "name")
      r = String(a.title ?? "").localeCompare(
        String(b.title ?? ""),
        undefined,
        {
          numeric: true,
          sensitivity: "base",
        }
      );
    // Owner is a stable no-op while this drive projects ONE vault: every row
    // belongs to the member, so nothing reorders. It is the comparator the day
    // a shared space puts somebody else's documents in the same set, and
    // leaving it out would make the column the one head that cannot be pressed.
    else if (state.sortKey === "owner") r = 0;
    else if (state.sortKey === "kind")
      // The word in the column, not the raw media type: "PDF" and "Image" are
      // what the member is grouping by, and two media types that print the
      // same word must land together.
      r = typeMeta(a.media_type, a.title).name.localeCompare(
        typeMeta(b.media_type, b.title).name,
        undefined,
        { sensitivity: "base" }
      );
    else
      r = String(a.updated_at ?? "").localeCompare(String(b.updated_at ?? ""));
    return r * state.sortDir;
  }

  // The rows for the current view: nav (or search) → type filter → tag
  // filter → sort.
  function currentRows(): DriveDoc[] {
    const { shelf, tag, search } = state;
    const folderId = folderIdFrom(shelf);
    let list: DriveDoc[];
    if (search.trim()) {
      list = state.searchResults ?? []; // flat vault FTS matches across every folder
    } else if (shelf === TRASH) {
      list = trashedFiles();
    } else {
      list = activeFiles();
      if (shelf === STARRED) list = list.filter((f) => f.starred);
      if (folderId)
        list = list.filter((f) => (f.folder_id ?? null) === folderId);
    }
    // §4.2's filter row, composed after the chips and before the sort: each
    // axis narrows what the last one left, which is exactly a chain of
    // predicates and deliberately not a score (filters.ts).
    list = applyFilters(list, state.filters);
    // Free-form label filter (#352) — same "all" escape hatch
    // and same idiom as the type chips above, alongside them rather than
    // replacing them (a document can be one type AND carry several labels).
    if (tag && tag !== "all")
      list = list.filter((f) => (f.tags ?? []).some((t) => t.label === tag));
    if (search.trim()) return list; // keep the vault's rank order for search
    if (shelf === RECENT) {
      return [...list]
        .sort((a, b) =>
          String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
        )
        .slice(0, RECENT_WINDOW);
    }
    return [...list].sort(compareDocs);
  }

  // ────────── Selection ──────────

  function clearSelection() {
    state.selected.clear();
    state.anchorIndex = null;
  }
  function selectedDocs(): DriveDoc[] {
    return data.documents.filter((d) => state.selected.has(d.document_id));
  }
  function toggleSelect(id: string, index: number, shift: boolean) {
    const sel = state.selected;
    if (shift && state.anchorIndex != null) {
      const [a, b] = [
        Math.min(state.anchorIndex, index),
        Math.max(state.anchorIndex, index),
      ];
      const on = !sel.has(id);
      for (let i = a; i <= b; i += 1) {
        const rid = state.visibleRows[i]?.document_id;
        if (!rid) continue;
        if (on) sel.add(rid);
        else sel.delete(rid);
      }
    } else {
      if (sel.has(id)) sel.delete(id);
      else sel.add(id);
      state.anchorIndex = index;
    }
    render();
  }
  function toggleAllVisible(rows: DriveDoc[], allSelected: boolean) {
    if (allSelected) for (const d of rows) state.selected.delete(d.document_id);
    else for (const d of rows) state.selected.add(d.document_id);
    state.anchorIndex = null;
    render();
  }

  // ────────── Document writes ──────────

  async function trashDoc(doc: DriveDoc) {
    const outcome = await act("trash", { document_id: doc.document_id });
    if (!narrate(outcome)) return;
    if (state.detailsId === doc.document_id) state.detailsId = null;
    statusLine(`Moved to trash · receipted.`, {
      undoLabel: "Undo",
      onUndo: async () => {
        const back = await act("restore", { document_id: doc.document_id });
        if (narrate(back)) await refresh();
      },
    });
    await refresh();
  }

  async function restoreDoc(doc: DriveDoc) {
    const outcome = await act("restore", { document_id: doc.document_id });
    if (narrate(outcome)) {
      statusLine("Restored to its folder · receipted.");
      await refresh();
    }
  }

  // One star across the vault: the flags-scheme tag on the document
  // wrapper, so favorites from Photos and stars from here are the same
  // judgment.
  async function toggleStar(doc: DriveDoc) {
    const outcome = await act(doc.starred ? "unstar" : "star", {
      document_id: doc.document_id,
    });
    if (narrate(outcome)) {
      statusLine(
        doc.starred ? "Star removed · receipted." : "Starred · receipted."
      );
      await refresh();
    }
  }

  async function moveDocs(
    ids: string[],
    folderId: string | null,
    name: string
  ) {
    const input = (id: string): Record<string, unknown> => ({
      document_id: id,
      ...(folderId == null ? {} : { folder_id: folderId }),
    });
    if (ids.length === 1) {
      const outcome = await act("move", input(ids[0]!));
      if (!narrate(outcome)) return;
      statusLine(`Moved to ${name} · receipted.`);
      clearSelection();
      await refresh();
      return;
    }
    await runBulk(ids, (id) => act("move", input(id)), {
      progress: "Moving",
      done: "Moved",
      suffix: ` to ${name}`,
    });
  }

  async function startRenameDoc(doc: DriveDoc) {
    const title = window.prompt?.("Rename document", doc.title ?? "");
    if (title == null) return;
    const trimmed = title.trim();
    if (!trimmed || trimmed === doc.title) return;
    const outcome = await act("rename", {
      document_id: doc.document_id,
      title: trimmed,
    });
    if (narrate(outcome)) {
      statusLine("Renamed · receipted.");
      await refresh();
    }
  }

  // Loop an action over many rows (kit runBulk) in this app's voice: our
  // notice banner, our friendly failure copy, and the fixed tail — clear the
  // selection, then refresh.
  const runBulk = (
    ids: string[],
    run: (id: string) => Promise<VaultOutcome | undefined>,
    opts: { progress: string; done: string; suffix?: string }
  ) =>
    runBulkBase(ids, run, {
      ...opts,
      notice,
      friendly: friendlyOutcome,
      after: async () => {
        clearSelection();
        await refresh();
      },
    });

  function restoreSelected() {
    return runBulk(
      [...state.selected],
      (id) => act("restore", { document_id: id }),
      {
        progress: "Restoring",
        done: "Restored",
      }
    );
  }
  function trashSelected() {
    return runBulk(
      [...state.selected],
      (id) => act("trash", { document_id: id }),
      {
        progress: "Trashing",
        done: "Trashed",
      }
    );
  }
  function moveSelected(anchor: HTMLElement) {
    openMovePopover(anchor, selectedDocs());
  }
  /**
   * Star the selection — or unstar it, when every picked document already
   * carries a star.
   *
   * ONE VERB FOR THE WHOLE SET, decided before anything is written: a bar that
   * toggled each row independently would leave a mixed selection exactly as
   * mixed as it found it, which is not what pressing one button once means.
   * Mixed becomes starred, which is the reading of "Star" that adds rather
   * than removes.
   */
  function starSelected() {
    const docs = selectedDocs();
    const unstar = docs.length > 0 && docs.every((d) => d.starred);
    return runBulk(
      docs.map((d) => d.document_id),
      (id) => act(unstar ? "unstar" : "star", { document_id: id }),
      {
        progress: unstar ? "Removing stars" : "Starring",
        done: unstar ? "Star removed" : "Starred",
      }
    );
  }
  /** Is every picked document already starred? The bar reads this to name its
   *  own verb, so the label and what the press does cannot disagree. */
  function selectionAllStarred(): boolean {
    const docs = selectedDocs();
    return docs.length > 0 && docs.every((d) => d.starred);
  }
  function clearSelected() {
    clearSelection();
    render();
  }

  // ────────── Folder writes ──────────

  async function createFolder(name: string) {
    const outcome = await act("create-folder", { name });
    if (narrate(outcome)) {
      state.creatingFolder = false;
      statusLine(`Folder “${name}” created · receipted.`);
      await refresh();
    } else {
      render();
    }
  }
  async function renameFolder(folderId: string, name: string) {
    const outcome = await act("rename-folder", { folder_id: folderId, name });
    if (narrate(outcome)) {
      state.renamingFolderId = null;
      statusLine("Folder renamed · receipted.");
      await refresh();
    } else {
      render();
    }
  }
  async function deleteFolder(folder: Folder) {
    const outcome = await act("delete-folder", { folder_id: folder.folder_id });
    if (narrate(outcome)) {
      // The shelf the member was on has just ceased to exist. They fall back
      // to FOLDERS, not All: the folder was reached from there, and a silent
      // jump to the drive's root would drop them somewhere they did not ask
      // to be (view-state.ts, rule 2).
      if (folderIdFrom(state.shelf) === folder.folder_id) state.shelf = FOLDERS;
      statusLine("Folder deleted · receipted.");
      await refresh();
    }
  }
  function startRenameFolder(folderId: string) {
    state.renamingFolderId = folderId;
    render();
  }
  function cancelCreateFolder() {
    state.creatingFolder = false;
    render();
  }
  function cancelRenameFolder() {
    state.renamingFolderId = null;
    render();
  }

  // ────────── Upload (picker + drag-and-drop) ──────────
  // A separate module for the same reason versions.ts and metadata.ts are:
  // file-size hygiene on a seam that is real. It closes over this factory's
  // own state/act/notice/render/refresh, so the queue and every refusal still
  // speak in this app's voice.
  const { uploadFiles } = createUploads({
    state,
    render,
    refresh,
    act,
    friendlyOutcome,
    notice,
  });

  // ────────── Content lifecycle (edit / replace / version history) ──────────
  // A separate module purely for file-size hygiene — see versions.ts's own
  // header for why. It closes over this factory's own act/narrate/notice
  // rather than re-implementing them, so every outcome still narrates in
  // this app's voice.
  const { replaceDocument, restoreVersion, loadHistory } = createVersions({
    refresh,
    act,
    narrate,
    notice,
  });

  // ────────── Metadata (tags + real activity) ──────────
  // Another file-size split (metadata.ts) — closes over this factory's own
  // act/narrate/refresh rather than re-implementing them.
  const { addTag, removeTag, loadActivity } = createMetadata({
    refresh,
    act,
    narrate,
  });

  // ────────── Popovers (kebab + move) ──────────
  // Another file-size split (popovers.ts) — closes over data.folders plus
  // the document-write functions just above, passed in rather than
  // re-implemented.
  const { openMovePopover, openDocMenu } = createPopovers({
    data,
    openQuick,
    openDetails,
    openVersions,
    moveDocs,
    startRenameDoc,
    toggleStar,
    trashDoc,
    restoreDoc,
  });

  return {
    notice,
    narrate,
    act,
    friendlyOutcome,
    folderById,
    folderName,
    activeFiles,
    trashedFiles,
    currentRows,
    clearSelection,
    selectedDocs,
    toggleSelect,
    toggleAllVisible,
    openMovePopover,
    openDocMenu,
    trashDoc,
    restoreDoc,
    toggleStar,
    moveDocs,
    startRenameDoc,
    runBulk,
    restoreSelected,
    trashSelected,
    moveSelected,
    starSelected,
    selectionAllStarred,
    clearSelected,
    createFolder,
    renameFolder,
    deleteFolder,
    startRenameFolder,
    cancelCreateFolder,
    cancelRenameFolder,
    uploadFiles,
    replaceDocument,
    restoreVersion,
    loadHistory,
    addTag,
    removeTag,
    loadActivity,
  };
}
