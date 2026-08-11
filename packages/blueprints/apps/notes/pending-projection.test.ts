// @vitest-environment jsdom
//
// Notes' pending-write overlay (issue #738): the declaration's pure
// projections (mirrors pending-overlay.test.ts's per-app-declaration
// convention), plus one reload-survival behavioral test through
// `createLogic` — a queued create the durable outbox reports on mount must
// still render as pending after a reload with no in-memory state at all.
import { describe, expect, test, vi } from "vitest";

import { createLogic } from "./logic.ts";
import { notesPendingProjection } from "./pending-projection.ts";
import type { AppData, AppState } from "./types.ts";

function ctx(intentId: string) {
  return { intentId, rowId: `pending-${intentId}` };
}

describe("Notes pending-write projection", () => {
  test("create-note projects the content item and the note that points at it", () => {
    const mutations = notesPendingProjection.actions["create-note"]!(
      {
        title: "Grocery list",
        body_text: "- milk\n- eggs",
        format: "markdown",
      },
      ctx("intent-1")
    );
    expect(mutations).toStrictEqual([
      {
        op: "upsert",
        entity: "core.content_item",
        rowId: "pending-intent-1-body",
        values: expect.objectContaining({
          content_id: "pending-intent-1-body",
          media_type: "text/markdown",
          content_uri: `data:text/markdown;charset=utf-8,${encodeURIComponent("- milk\n- eggs")}`,
          byte_size: "- milk\n- eggs".length,
        }),
      },
      {
        op: "upsert",
        entity: "knowledge.note",
        rowId: "pending-intent-1",
        values: expect.objectContaining({
          note_id: "pending-intent-1",
          title: "Grocery list",
          body_content_id: "pending-intent-1-body",
          format: "markdown",
          pinned: 0,
        }),
      },
    ]);
  });

  test("create-note into a notebook also projects the collection_entry placement", () => {
    const mutations = notesPendingProjection.actions["create-note"]!(
      { title: "Filed", body_text: "hi", notebook_id: "notebook-1" },
      ctx("intent-2")
    );
    expect(mutations).toHaveLength(3);
    expect(mutations[2]).toMatchObject({
      op: "upsert",
      entity: "core.collection_entry",
      rowId: "pending-intent-2-entry",
      values: {
        collection_id: "notebook-1",
        target_type: "knowledge.note",
        target_id: "pending-intent-2",
      },
    });
  });

  test("edit-note without body_text projects only the note row's changed fields", () => {
    expect(
      notesPendingProjection.actions["edit-note"]!(
        { note_id: "note-1", title: "Renamed", pinned: 1 },
        ctx("intent-3")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "knowledge.note",
        rowId: "note-1",
        values: expect.objectContaining({
          title: "Renamed",
          pinned: 1,
        }),
      },
    ]);
  });

  test("edit-note with body_text also projects a fresh content item", () => {
    const mutations = notesPendingProjection.actions["edit-note"]!(
      { note_id: "note-1", body_text: "new body" },
      ctx("intent-4")
    );
    expect(mutations).toHaveLength(2);
    expect(mutations[0]).toMatchObject({
      op: "upsert",
      entity: "core.content_item",
      rowId: "pending-intent-4-body",
    });
    expect(mutations[1]).toMatchObject({
      op: "upsert",
      entity: "knowledge.note",
      rowId: "note-1",
      values: { body_content_id: "pending-intent-4-body" },
    });
  });

  test("move-note registers the pending row without guessing at notebook_ids", () => {
    expect(
      notesPendingProjection.actions["move-note"]!(
        { note_id: "note-1", notebook_id: "notebook-2" },
        ctx("intent-5")
      )
    ).toStrictEqual([
      { op: "upsert", entity: "knowledge.note", rowId: "note-1", values: {} },
    ]);
  });

  test("delete-note soft-deletes with a 30-day purge stamp, matching the real command", () => {
    const mutations = notesPendingProjection.actions["delete-note"]!(
      { note_id: "note-1" },
      ctx("intent-6")
    );
    expect(mutations).toHaveLength(1);
    const [mutation] = mutations as [
      {
        op: "upsert";
        entity: string;
        rowId: string;
        values: Record<string, unknown>;
      },
    ];
    expect(mutation.entity).toBe("knowledge.note");
    expect(mutation.rowId).toBe("note-1");
    expect(mutation.values.deleted_at).toBeTypeOf("string");
    expect(mutation.values.purge_at).toBeTypeOf("string");
  });

  test("rename-notebook upserts the known field", () => {
    expect(
      notesPendingProjection.actions["rename-notebook"]!(
        { notebook_id: "notebook-1", name: "Trips" },
        ctx("intent-7")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.collection",
        rowId: "notebook-1",
        values: { name: "Trips" },
      },
    ]);
  });

  test("delete-notebook registers the pending row without vanishing it", () => {
    expect(
      notesPendingProjection.actions["delete-notebook"]!(
        { notebook_id: "notebook-1" },
        ctx("intent-8")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.collection",
        rowId: "notebook-1",
        values: {},
      },
    ]);
  });

  test("create-notebook is deliberately undeclared", () => {
    expect(notesPendingProjection.actions["create-notebook"]).toBeUndefined();
  });
});

function state(): AppState {
  return {
    nav: { kind: "all" },
    view: "masonry",
    search: "",
    searchResults: null,
    libraryWindow: 200,
    libraryTruncated: false,
    editorId: null,
    narrow: false,
    editingNotebookId: null,
    creatingNotebook: false,
    readFailedShown: false,
    quickAddDraft: null,
  };
}

function data(): AppData {
  return { notes: [], trash: [], notebooks: [], tags: [], window: 200 };
}

describe("Notes pending-write reload survival", () => {
  test("a queued create the durable outbox reports on mount renders pending with no prior in-memory state", async () => {
    const pendingWrites = vi.fn<
      NonNullable<typeof window.centraid.pendingWrites>
    >(async () => [
      {
        intentId: "intent-reload",
        action: "create-note",
        state: "queued",
        input: { title: "Grocery list", body_text: "- milk" },
        mutations: [
          {
            op: "upsert",
            entity: "core.content_item",
            rowId: "pending-intent-reload-body",
            values: {
              content_id: "pending-intent-reload-body",
              media_type: "text/plain",
              content_uri: "data:text/plain;charset=utf-8,-%20milk",
              sha256: "pending-intent-reload-body",
              byte_size: 6,
              created_at: "2026-08-11T00:00:00.000Z",
            },
          },
          {
            op: "upsert",
            entity: "knowledge.note",
            rowId: "pending-intent-reload",
            values: {
              note_id: "pending-intent-reload",
              title: "Grocery list",
              body_content_id: "pending-intent-reload-body",
              format: "plain",
              pinned: 0,
              created_at: "2026-08-11T00:00:00.000Z",
              updated_at: "2026-08-11T00:00:00.000Z",
            },
          },
        ],
      },
    ]);
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: { pendingWrites },
    });

    const render = vi.fn<() => void>();
    // A fresh logic instance — the model starts empty; `restorePending()` is
    // the ONLY path that can populate it, exactly the reload journey.
    const logic = createLogic({
      state: state(),
      data: data(),
      render,
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });

    expect(logic.pendingByRowId().size).toBe(0);
    await logic.restorePending();

    expect(pendingWrites).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledWith();
    const byRowId = logic.pendingByRowId();
    expect(byRowId.has("pending-intent-reload")).toBe(true);
    expect(byRowId.get("pending-intent-reload")).toMatchObject({
      action: "create-note",
      status: "queued",
    });

    // Wall.tsx's decoration path: the row this write projects now belongs to
    // the library's normal query rows (overlay-composed) — the model only
    // needs to answer "is this row pending" for it.
    const libraryData = data();
    libraryData.notes = [
      {
        note_id: "pending-intent-reload",
        title: "Grocery list",
      },
    ];
    expect(byRowId.get(libraryData.notes[0]!.note_id)).toBeDefined();
  });

  test("restorePending() is a safe no-op when the host has no pendingWrites (visual-harness mock)", async () => {
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {},
    });
    const render = vi.fn<() => void>();
    const logic = createLogic({
      state: state(),
      data: data(),
      render,
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await expect(logic.restorePending()).resolves.toBeUndefined();
    expect(logic.pendingByRowId().size).toBe(0);
  });
});

// ─── the durable attention journal (issue #738 engine H) ────────────────────
//
// `restorePending()` reads TWO durable sources, because a settled write leaves
// the outbox: `pendingWrites()` for what is still in flight, and
// `attentionWrites()` for what came back denied/conflicted/failed. Without the
// second one a denied row lives only in this session's memory and dies on
// reload — the exact "anchored in app memory" failure the issue exists to end.

/** A stand-in for the client's durable attention journal. */
function attentionJournal(seed: CentraidAttentionWrite[] = []) {
  const rows = [...seed];
  const dismissAttentionWrite = vi.fn<
    NonNullable<typeof window.centraid.dismissAttentionWrite>
  >(async ({ intentId }) => {
    const at = rows.findIndex((row) => row.intentId === intentId);
    if (at < 0) return false;
    rows.splice(at, 1);
    return true;
  });
  return { rows, dismissAttentionWrite };
}

function stubJournal(
  journal: ReturnType<typeof attentionJournal>,
  extra: Record<string, unknown> = {}
) {
  Object.defineProperty(window, "centraid", {
    configurable: true,
    value: {
      pendingWrites: async () => [],
      attentionWrites: async () => journal.rows.map((row) => ({ ...row })),
      dismissAttentionWrite: journal.dismissAttentionWrite,
      ...extra,
    },
  });
}

describe("Notes attention rows survive a reload (issue #738)", () => {
  test("a denied create-note persists with its reason across a FRESH logic instance, then retries under a new id", async () => {
    const journal = attentionJournal();
    const write = vi.fn<typeof window.centraid.write>(async (opts) => {
      journal.rows.push({
        intentId: opts.intentId!,
        action: opts.action,
        status: "denied",
        reason: "This notebook is read-only on this device.",
        input: opts.input ?? {},
        mutations: (opts.optimistic ?? []) as never,
        settledAt: "2026-08-11T10:00:00.000Z",
      });
      return {
        status: "denied",
        reason: "This notebook is read-only on this device.",
      } as never;
    });
    stubJournal(journal, { write });

    const first = createLogic({
      state: state(),
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });
    await first.submitQuickAdd({ title: "Grocery list", body: "- [ ] milk" });
    const deniedId = write.mock.calls[0]![0].intentId!;
    expect(first.attentionRows()).toMatchObject([
      {
        intentId: deniedId,
        action: "create-note",
        status: "denied",
        reason: "This notebook is read-only on this device.",
      },
    ]);

    // ---- reload: a brand-new logic instance with no memory whatsoever ----
    const second = createLogic({
      state: state(),
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });
    expect(second.attentionRows()).toStrictEqual([]);
    await second.restorePending();
    // Row CONTENT, never a count: the refused note is back, still saying what
    // happened and still carrying the payload an answer needs.
    expect(second.attentionRows()).toMatchObject([
      {
        intentId: deniedId,
        action: "create-note",
        status: "denied",
        reason: "This notebook is read-only on this device.",
        input: { title: "Grocery list", body_text: "- [ ] milk" },
      },
    ]);

    // ---- retry: same payload, FRESH intent id, old record forgotten ----
    await second.retryPending(deniedId);
    expect(journal.dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: deniedId,
    });
    const retried = write.mock.calls[1]![0];
    expect(retried.intentId).not.toBe(deniedId);
    expect(retried.input).toMatchObject({ title: "Grocery list" });
    expect(second.attentionRows()).toMatchObject([
      { intentId: retried.intentId, action: "create-note", status: "denied" },
    ]);
  });

  test("Edit seeds the quick-add composer from the refused payload; an edit-note offers retry and discard only", async () => {
    const journal = attentionJournal([
      {
        intentId: "intent-create",
        action: "create-note",
        status: "denied",
        reason: "This notebook is read-only on this device.",
        input: {
          title: "Grocery list",
          body_text: "- [ ] milk",
          format: "markdown",
        },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
      {
        intentId: "intent-edit",
        action: "edit-note",
        status: "denied",
        reason: "This note is read-only on this device.",
        input: { note_id: "note-1", title: "Renamed" },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
    ]);
    stubJournal(journal);
    const composerState = state();
    composerState.nav = { kind: "trash" };
    const logic = createLogic({
      state: composerState,
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });
    await logic.restorePending();

    const [createRow, editRow] = logic.attentionRows();
    // The editor is bound to the canonical note and autosaves what it shows,
    // so a refused edit offers retry and discard rather than a surface that
    // would resend on the next keystroke.
    expect(logic.isEditablePending(createRow!)).toBe(true);
    expect(logic.isEditablePending(editRow!)).toBe(false);

    expect(logic.editPending("intent-create")).toBe(true);
    expect(composerState.quickAddDraft).toStrictEqual({
      id: "intent-create",
      title: "Grocery list",
      body: "- [ ] milk",
    });
    // …and the scope moved to one where the quick-add card actually renders
    // (`showQuickAdd` hides it in pinned/trash), so the draft is not seeded
    // into a card the member cannot see.
    expect(composerState.nav).toStrictEqual({ kind: "all" });
    // Taken for correction is taken: the durable record goes with it, so the
    // corrected resend cannot leave a duplicate behind on the next reload.
    expect(journal.dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: "intent-create",
    });
    expect(logic.attentionRows()).toMatchObject([{ intentId: "intent-edit" }]);
  });

  test("a discarded attention row stays discarded across a reload", async () => {
    const journal = attentionJournal([
      {
        intentId: "intent-denied",
        action: "create-note",
        status: "denied",
        reason: "This notebook is read-only on this device.",
        input: { title: "Grocery list", body_text: "- [ ] milk" },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
    ]);
    stubJournal(journal);

    const before = createLogic({
      state: state(),
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });
    await before.restorePending();
    expect(before.attentionRows()).toMatchObject([
      { intentId: "intent-denied", status: "denied" },
    ]);
    expect(before.dismissPending("intent-denied")).toBe(true);
    expect(journal.rows).toStrictEqual([]);

    const after = createLogic({
      state: state(),
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });
    await after.restorePending();
    expect(after.attentionRows()).toStrictEqual([]);
  });

  test("an edit-note carries the note version it was composed against, a create carries none, and a conflict states both", async () => {
    const rowVersion = vi.fn<NonNullable<typeof window.centraid.rowVersion>>(
      async () => 9
    );
    const write = vi.fn<typeof window.centraid.write>(
      async () =>
        ({
          status: "conflict",
          reason: "Someone else changed this first.",
          conflict: {
            entity: "knowledge.note",
            rowId: "note-1",
            expectedVersion: 9,
            actualVersion: 11,
          },
        }) as never
    );
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: { write, rowVersion, pendingWrites: async () => [] },
    });
    const logic = createLogic({
      state: state(),
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });

    await logic.editNoteAutosave("note-1", { title: "Renamed" });
    expect(rowVersion).toHaveBeenCalledWith({
      entity: "knowledge.note",
      rowId: "note-1",
    });
    expect(write.mock.calls[0]![0].baseVersions).toStrictEqual([
      { entity: "knowledge.note", rowId: "note-1", version: 9 },
    ]);
    // A conflict says WHICH versions disagreed — degrading it to a generic
    // error would waste the entire precondition.
    expect(logic.attentionRows()).toMatchObject([
      {
        action: "edit-note",
        status: "conflict",
        conflict: {
          entity: "knowledge.note",
          rowId: "note-1",
          expectedVersion: 9,
          actualVersion: 11,
        },
      },
    ]);

    // A create has no existing row to be stale against.
    await logic.act("create-note", { title: "Fresh", body_text: "" });
    expect(write.mock.calls[1]![0].baseVersions).toBeUndefined();
  });
});
