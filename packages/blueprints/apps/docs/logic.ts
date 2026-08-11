import { createPendingOverlayModel } from "../_shared/pending-overlay.ts";
import type { PendingRowState } from "../_shared/pending-overlay.ts";
import { fmtBytes, typeMeta } from "./format.ts";
// Non-visual business logic: data/selection helpers, the plain-DOM popovers
// (kebab / move-to), every vault write (documents, folders, upload), and the
// pending-write overlay (issue #738).
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
  isPendingOffsite,
  outcomeMessage,
  runBulk as runBulkBase,
  statusLine,
} from "./kit.ts";
import { createMetadata } from "./metadata.ts";
import { docsPendingProjection } from "./pending-projection.ts";
import { createPopovers } from "./popovers.ts";
import type { AppData, AppState, DriveDoc, Folder } from "./types.ts";
import { stageDocumentFile } from "./upload.ts";
import { createVersions } from "./versions.ts";

const $ = (id: string) => document.querySelector<HTMLElement>(`#${id}`)!;
// Bytes stream to the blob staging route (issue #296) — no base64 through
// command JSON — so big documents fit; the route itself caps at 512 MB.
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

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
}

export function createLogic({
  state,
  data,
  render,
  refresh,
  openQuick,
}: LogicDeps) {
  // The shared pending-write overlay (issue #738): one model, created once,
  // that every write wraps through `act()` below. No app state carries
  // pending rows — `model.byRowId()` is the render-time source for the
  // grid/list pending-chip decoration app-root.tsx applies.
  // Discarding (or taking for a retry/edit) an attention row also clears its
  // DURABLE record through the engine's one port — a row that returns on the
  // next reload was never really discarded. The clear is fire-and-forget by
  // contract, so the failure is narrated here rather than swallowed.
  const model = createPendingOverlayModel(docsPendingProjection, {
    dismissDurable: (intentId) => {
      const forget = window.centraid.dismissAttentionWrite;
      if (!forget) return;
      void forget({ intentId }).catch(() =>
        notice("That change is gone from this view but may return on reload.")
      );
    },
  });

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

  /** Row id → pending state (document ids for rename/trash/restore, tag ids
   *  for move, concept ids for create-folder/rename-folder). */
  function pendingByRowId() {
    return model.byRowId();
  }

  /** The reload path (issue #738): rebuild from local truth alone. TWO
   *  durable sources, because a settled write leaves the outbox — the outbox
   *  for what is still in flight, the attention journal for what came back
   *  denied/conflicted/failed. Feature-detected: the visual-harness mock and
   *  older hosts lack both. */
  async function restorePending(): Promise<void> {
    const [durable, attention] = await Promise.all([
      window.centraid.pendingWrites?.() ?? [],
      window.centraid.attentionWrites?.() ?? [],
    ]);
    model.restore(durable);
    model.restoreAttention(attention);
    render();
  }

  /** The writes that settled without executing and still need an answer —
   *  what `components/Attention.tsx` renders above the drive. */
  function attentionRows(): PendingRowState[] {
    return model.attention();
  }

  /** Discard one — here and in the durable journal (the model's port). */
  function dismissPending(intentId: string): boolean {
    const dismissed = model.dismiss(intentId);
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
    const retry = model.takeForRetry(intentId);
    if (!retry) return undefined;
    render();
    const outcome = await act(retry.action, retry.input);
    render();
    return outcome;
  }

  /**
   * A refused write this app can reopen on a surface that shows the REFUSED
   * payload rather than the canonical row. The drive has three: the rename
   * prompt, the sidebar's new-folder field, and its rename-folder field —
   * each seeded with the name the vault would not take, so it can be
   * corrected before it is resent.
   *
   * `move`/`trash`/`restore`/`delete-folder` carry no text to correct (their
   * payload IS the row and the destination), so they offer retry and discard
   * alone rather than a surface with nothing on it.
   */
  const EDITABLE_PENDING_ACTIONS = new Set([
    "rename",
    "create-folder",
    "rename-folder",
  ]);

  function isEditablePending(row: PendingRowState): boolean {
    return EDITABLE_PENDING_ACTIONS.has(row.action) && row.input !== undefined;
  }

  async function editPending(intentId: string): Promise<void> {
    const entry = model.rows().find((row) => row.intentId === intentId);
    if (!entry || !isEditablePending(entry)) return;
    const refusedName = String(
      entry.action === "rename"
        ? (entry.input?.title ?? "")
        : (entry.input?.name ?? "")
    );
    if (entry.action === "rename") {
      // The rename surface IS a prompt (startRenameDoc) — seeding it with the
      // refused title is a real correction step, not a decoration.
      const documentId = entry.input?.document_id;
      const title = window.prompt?.("Rename document", refusedName);
      if (title == null) return; // cancelled: the row stays, untouched
      const trimmed = title.trim();
      if (!trimmed || typeof documentId !== "string") return;
      if (!model.takeForRetry(intentId)) return;
      const outcome = await act("rename", {
        document_id: documentId,
        title: trimmed,
      });
      if (narrate(outcome)) {
        statusLine("Renamed · receipted.");
        await refresh();
      } else render();
      return;
    }
    // The two sidebar fields: seed the draft, open the right one, and let the
    // member commit it as an ordinary create/rename.
    if (!model.takeForRetry(intentId)) return;
    state.folderNameDraft = refusedName;
    if (entry.action === "create-folder") {
      state.creatingFolder = true;
      state.renamingFolderId = null;
    } else {
      const folderId = entry.input?.folder_id;
      if (typeof folderId !== "string") return;
      state.renamingFolderId = folderId;
      state.creatingFolder = false;
    }
    render();
  }

  /** The seeded folder name was committed or abandoned — forget it, or the
   *  next open of either field would re-seed what the member just dealt
   *  with. */
  function clearFolderNameDraft(): void {
    if (state.folderNameDraft === null) return;
    state.folderNameDraft = null;
  }

  /** Fold one change-feed event into the pending model; true when it moved. */
  function applyPendingChange(detail: CentraidChangeDetail): boolean {
    return model.applyChangeDetail(detail);
  }

  // Every write goes through here, so the pending overlay tracks every write
  // uniformly: mint the intent id, project the app's declared optimistic
  // mutations, and fold the outcome (or the transport failure) into the
  // model. An action absent from pending-projection.ts (star/unstar, every
  // byte-custody action) projects nothing — `begin()` is then a no-op and
  // this is exactly the old fire-and-forget act().
  /**
   * The optimistic-concurrency precondition for one write (issue #738 P2):
   * the version of the row this device composed the change against, read
   * from the local replica. Without it a conflict cannot even occur — the
   * vault has nothing to compare — so this is what makes a `conflict`
   * outcome, and its expected-vs-actual row, reachable at all.
   *
   * The row is the one the write actually changes, and it is the same row
   * `pending-projection.ts` keys its overlay on. `create-folder` creates and
   * so has nothing to be stale against. `move` is the one edit deliberately
   * left unversioned: what it replaces is the document's folders-scheme
   * `core.tag` row, whose id the client only knows as `folder_tag_id` when
   * the read that carried it is still loaded — a precondition on the
   * DOCUMENT would name a row this write does not touch.
   */
  const VERSIONED_ROW_OF: Record<string, { entity: string; key: string }> = {
    rename: { entity: "core.document", key: "document_id" },
    trash: { entity: "core.document", key: "document_id" },
    restore: { entity: "core.document", key: "document_id" },
    "rename-folder": { entity: "core.concept", key: "folder_id" },
    "delete-folder": { entity: "core.concept", key: "folder_id" },
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
    const intentId = globalThis.crypto.randomUUID();
    const optimistic = model.begin(action, input, intentId);
    try {
      const baseVersions = await baseVersionsFor(action, input);
      const outcome = await window.centraid.write({
        action,
        input,
        intentId,
        ...(optimistic.length > 0 ? { optimistic } : {}),
        ...(baseVersions.length > 0 ? { baseVersions } : {}),
      });
      model.applyOutcome(outcome.invocationId ?? intentId, {
        status: outcome.status,
        ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        ...(outcome.conflict === undefined
          ? {}
          : { conflict: outcome.conflict }),
      });
      return outcome;
    } catch (error) {
      // Nothing reached the outbox — settle to `failed` instead of hanging
      // as `queued` forever.
      model.applyOutcome(intentId, { status: "failed" });
      notice(String((error as { message?: string })?.message ?? error));
      return undefined;
    }
  }

  // ---------- Data helpers ----------

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
    else
      r = String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
    return r * state.sortDir;
  }

  // The rows for the current view: nav (or search) → type filter → tag
  // filter → sort.
  function currentRows(): DriveDoc[] {
    const { nav, type, tag, search } = state;
    let list: DriveDoc[];
    if (search.trim()) {
      list = state.searchResults ?? []; // flat vault FTS matches across every folder
    } else if (nav.kind === "trash") {
      list = trashedFiles();
    } else {
      list = activeFiles();
      if (nav.kind === "starred") list = list.filter((f) => f.starred);
      if (nav.kind === "folder")
        list = list.filter((f) => (f.folder_id ?? null) === nav.folderId);
    }
    if (type !== "all")
      list = list.filter((f) => typeMeta(f.media_type).cat === type);
    // Free-form label filter (issue #352 phase 4) — same "all" escape hatch
    // and same idiom as the type chips above, alongside them rather than
    // replacing them (a document can be one type AND carry several labels).
    if (tag && tag !== "all")
      list = list.filter((f) => (f.tags ?? []).some((t) => t.label === tag));
    if (search.trim()) return list; // keep the vault's rank order for search
    if (nav.kind === "recent") {
      return [...list]
        .sort((a, b) =>
          String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
        )
        .slice(0, 8);
    }
    return [...list].sort(compareDocs);
  }

  // ---------- Selection ----------

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

  // ---------- Document writes ----------

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
    // Resolved to the real root id (rather than omitted) whenever it is
    // known — byte-identical to the command's own `folder_id ?? rootFolderId`
    // fallback, and it is what lets the `move` pending-write overlay (issue
    // #738, see pending-projection.ts) name the destination concept even for
    // a "back to the top level" move.
    const effectiveFolderId = folderId ?? data.root_folder_id;
    const input = (id: string): Record<string, unknown> => {
      const tagId = data.documents.find(
        (d) => d.document_id === id
      )?.folder_tag_id;
      return {
        document_id: id,
        ...(effectiveFolderId == null ? {} : { folder_id: effectiveFolderId }),
        ...(tagId ? { folder_tag_id: tagId } : {}),
      };
    };
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
  // notice banner, our friendly failure copy, and the old hard-wired tail —
  // clear the selection, then refresh.
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
  function clearSelected() {
    clearSelection();
    render();
  }

  // ---------- Folder writes ----------

  async function createFolder(name: string) {
    clearFolderNameDraft();
    const outcome = await act("create-folder", {
      name,
      ...(data.folder_scheme_id
        ? { folder_scheme_id: data.folder_scheme_id }
        : {}),
    });
    if (narrate(outcome)) {
      state.creatingFolder = false;
      statusLine(`Folder “${name}” created · receipted.`);
      await refresh();
    } else {
      render();
    }
  }
  async function renameFolder(folderId: string, name: string) {
    clearFolderNameDraft();
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
      if (
        state.nav.kind === "folder" &&
        state.nav.folderId === folder.folder_id
      )
        state.nav = { kind: "all" };
      statusLine("Folder deleted · receipted.");
      await refresh();
    }
  }
  function startRenameFolder(folderId: string) {
    state.renamingFolderId = folderId;
    clearFolderNameDraft();
    render();
  }
  function cancelCreateFolder() {
    state.creatingFolder = false;
    clearFolderNameDraft();
    render();
  }
  function cancelRenameFolder() {
    state.renamingFolderId = null;
    clearFolderNameDraft();
    render();
  }

  // ---------- Upload (picker + drag-and-drop) ----------

  // Each file's bytes stage into the vault's CAS via kit stageFileBytes
  // (issue #296); the upload action claims the returned sha — that claim is
  // the receipt.
  async function uploadFiles(fileList: FileList | File[]) {
    if (state.uploading) return;
    const files = [...fileList];
    if (files.length === 0) return;
    const folderId =
      state.nav.kind === "folder" ? (state.nav.folderId ?? null) : null;
    const skipped = files.filter((f) => f.size > MAX_UPLOAD_BYTES);
    const accepted = files.filter((f) => f.size <= MAX_UPLOAD_BYTES);
    const failures: string[] = [];
    if (skipped.length === 1)
      failures.push(
        `“${skipped[0]!.name}” is ${fmtBytes(skipped[0]!.size)} — files up to 512 MB travel well.`
      );
    else if (skipped.length > 1)
      failures.push(`Skipped ${skipped.length} files over 512 MB.`);

    state.uploading = true;
    let ok = 0;
    let parked = 0;
    let pendingOffsite = 0;
    // The visible progress and consent outcomes are a user-selected sequence;
    // stage and commit each file before moving to the next.
    const uploadNext = async (i: number): Promise<void> => {
      if (i >= accepted.length) return;
      const file = accepted[i]!;
      notice(`Uploading ${i + 1} of ${accepted.length}…`);
      let staged;
      try {
        staged = await stageDocumentFile(file);
      } catch {
        failures.push(`Could not read “${file.name}”.`);
        return uploadNext(i + 1);
      }
      const outcome = await act("upload", {
        staged_sha: staged.sha256,
        title: file.name,
        ...(folderId == null ? {} : { folder_id: folderId }),
      });
      if (outcome?.status === "executed") {
        if (isPendingOffsite(staged)) pendingOffsite += 1;
        else ok += 1;
      } else if (outcome?.status === "parked") parked += 1;
      else
        failures.push(
          `“${file.name}”: ${friendlyOutcome(outcome) ?? "the upload failed"}`
        );
      return uploadNext(i + 1);
    };
    await uploadNext(0);
    state.uploading = false;
    notice(failures.join(" "));
    if (accepted.length > 0) {
      const parts = [`Uploaded ${ok} of ${accepted.length} · receipted.`];
      if (parked > 0) parts.push(`${parked} waiting for approval.`);
      if (pendingOffsite > 0)
        parts.push(`${pendingOffsite} attached locally · pending offsite.`);
      statusLine(parts.join(" "));
    }
    await refresh();
  }

  // ---------- Content lifecycle (edit / replace / version history) ----------
  // A separate module purely for file-size hygiene — see versions.ts's own
  // header for why. It closes over this factory's own act/narrate/notice
  // rather than re-implementing them, so every outcome still narrates in
  // this app's voice.
  const { editDocument, replaceDocument, restoreVersion, loadHistory } =
    createVersions({
      data,
      refresh,
      act,
      narrate,
      notice,
    });

  // ---------- Metadata (tags + real activity) ----------
  // Another file-size split (metadata.ts) — closes over this factory's own
  // act/narrate/refresh rather than re-implementing them.
  const { addTag, removeTag, loadActivity } = createMetadata({
    refresh,
    act,
    narrate,
  });

  // ---------- Popovers (kebab + move) ----------
  // Another file-size split (popovers.ts) — closes over data.folders plus
  // the document-write functions just above, passed in rather than
  // re-implemented.
  const { openMovePopover, openDocMenu } = createPopovers({
    data,
    openQuick,
    moveDocs,
    startRenameDoc,
    toggleStar,
    trashDoc,
  });

  return {
    notice,
    narrate,
    act,
    pendingByRowId,
    restorePending,
    attentionRows,
    dismissPending,
    retryPending,
    editPending,
    isEditablePending,
    applyPendingChange,
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
    clearSelected,
    createFolder,
    renameFolder,
    deleteFolder,
    startRenameFolder,
    cancelCreateFolder,
    cancelRenameFolder,
    uploadFiles,
    editDocument,
    replaceDocument,
    restoreVersion,
    loadHistory,
    addTag,
    removeTag,
    loadActivity,
  };
}
