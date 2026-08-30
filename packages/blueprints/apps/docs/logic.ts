// Non-visual business logic; never a second copy of mutable state.
// `createLogic()` closes over app.tsx's `state`/`data` BY REFERENCE: app.tsx
// mutates their properties and never reassigns the bindings.
import {
  outcomeMessage,
  runBulk as runBulkBase,
  statusLine,
} from "@centraid/design/elements";

import { pruneSelection } from "../_shared/selection-engine.ts";
import { applyFilters } from "./filters.ts";
import { typeMeta } from "./format.ts";
import { createMetadata } from "./metadata.ts";
import { createPopovers } from "./popovers.ts";
import { FOLDERS, RECENT, STARRED, TRASH, folderIdFrom } from "./shelves.ts";
import type { AppData, AppState, DriveDoc, Folder } from "./types.ts";
import { createUploads } from "./uploads.ts";
import { createVersions } from "./versions.ts";

const $ = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;

/** A WINDOW, not a filter: the nav rail's count must be the number this shelf
 *  draws (v16 §3). */
export const RECENT_WINDOW = 8;

// The gateway stringifies a failed precondition as `"name: column op value"`,
// so the lookup keys off the substring before ": ".
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

  // True when the write executed; otherwise narrates parked/failed/denied.
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

  // ─── data helpers ─────

  function folderById(id: string | null | undefined): Folder | undefined {
    return data.folders.find((f) => f.folder_id === id);
  }
  function folderName(id: string | null | undefined): string {
    return id == null ? "Documents" : (folderById(id)?.name ?? "a folder");
  }
  function activeFiles(): DriveDoc[] {
    return data.documents.filter((f) => !f.trashed);
  }
  function trashedFiles(): DriveDoc[] {
    return data.documents.filter((f) => f.trashed);
  }

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
    // A no-op while this drive projects ONE vault, but dropping it leaves
    // Owner the one unpressable head.
    else if (state.sortKey === "owner") r = 0;
    else if (state.sortKey === "kind")
      // The word in the column: two media types printing it land together.
      r = typeMeta(a.media_type, a.title).name.localeCompare(
        typeMeta(b.media_type, b.title).name,
        undefined,
        { sensitivity: "base" }
      );
    else
      r = String(a.updated_at ?? "").localeCompare(String(b.updated_at ?? ""));
    return r * state.sortDir;
  }

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
    // §4.2: a chain of predicates, deliberately not a score (filters.ts).
    list = applyFilters(list, state.filters);
    // Free-form labels (#352) sit ALONGSIDE the type chips, never replace.
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

  // ─── selection ─────

  function clearSelection() {
    state.selected.clear();
    state.anchorIndex = null;
  }
  /** The selection AS THE MEMBER CAN SEE IT (#883): the FILTERED set, never the
   *  whole table, so a shelf change cannot carry off-screen rows into a batch
   *  write. Pruned in step, so this and the bar's count agree. */
  function selectedDocs(): DriveDoc[] {
    return state.visibleRows.filter((d) => state.selected.has(d.document_id));
  }

  /** Drop keys the current filter no longer shows: a filter change is the only
   *  thing that can strand a key, and the only thing that recomputes this. */
  function pruneVisibleSelection(): void {
    if (state.selected.size === 0) return;
    const kept = pruneSelection(
      state.selected,
      state.visibleRows.map((row) => row.document_id)
    );
    if (kept.size === state.selected.size) return;
    state.selected.clear();
    for (const key of kept) state.selected.add(key);
    state.anchorIndex = null;
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

  // ─── document writes ─────

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

  // One star across the vault: a Photos favorite is this same judgment.
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
  /** ONE VERB FOR THE SET, decided before any write; mixed becomes starred. */
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
  function selectionAllStarred(): boolean {
    const docs = selectedDocs();
    return docs.length > 0 && docs.every((d) => d.starred);
  }
  function clearSelected() {
    clearSelection();
    render();
  }

  // ─── folder writes ─────

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
      // Fall back to FOLDERS, not All (view-state.ts, rule 2).
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

  // ─── upload ─────
  // Closes over this factory's state/act/notice, so refusals keep one voice.
  const { uploadFiles } = createUploads({
    state,
    render,
    refresh,
    act,
    friendlyOutcome,
    notice,
  });

  // ─── content lifecycle ─────
  const { replaceDocument, restoreVersion, loadHistory } = createVersions({
    refresh,
    act,
    narrate,
    notice,
  });

  // ─── metadata ─────
  const { addTag, removeTag, loadActivity } = createMetadata({
    refresh,
    act,
    narrate,
  });

  // ─── popovers ─────
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
    pruneVisibleSelection,
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
