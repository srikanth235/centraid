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
