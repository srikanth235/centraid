// @vitest-environment jsdom
//
// Docs' pending-write projection (issue #738) — pure declaration checks, same
// convention as apps/_shared/pending-overlay.test.ts and
// apps/agenda/pending-projection.test.ts — plus the reload-survival tests for
// the durable attention journal at the bottom (jsdom, because those drive the
// real `createLogic`).
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createLogic } from "./logic.ts";
import { docsPendingProjection } from "./pending-projection.ts";
import type { AppData, AppState } from "./types.ts";

function ctx(intentId: string) {
  return { intentId, rowId: `pending-${intentId}` };
}

describe("Docs' pending-write projection", () => {
  test("rename upserts the wrapper's title", () => {
    expect(
      docsPendingProjection.actions.rename!(
        { document_id: "doc-1", title: "Renamed.pdf" },
        ctx("intent-1")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.document",
        rowId: "doc-1",
        values: { title: "Renamed.pdf" },
      },
    ]);
  });

  test("move deletes the old folder tag and upserts a new one under the minted id", () => {
    const mutations = docsPendingProjection.actions.move!(
      {
        document_id: "doc-1",
        folder_id: "folder-2",
        folder_tag_id: "tag-old",
      },
      ctx("intent-2")
    );
    expect(mutations).toStrictEqual([
      { op: "delete", entity: "core.tag", rowId: "tag-old" },
      {
        op: "upsert",
        entity: "core.tag",
        rowId: "pending-intent-2",
        values: {
          tag_id: "pending-intent-2",
          target_type: "core.document",
          target_id: "doc-1",
          concept_id: "folder-2",
          tagged_at: expect.any(String),
        },
      },
    ]);
  });

  test("move without a resolvable folder_id (root before it has ever loaded) still deletes the stale tag", () => {
    expect(
      docsPendingProjection.actions.move!(
        { document_id: "doc-1", folder_tag_id: "tag-old" },
        ctx("intent-3")
      )
    ).toStrictEqual([{ op: "delete", entity: "core.tag", rowId: "tag-old" }]);
  });

  test("trash/restore flip core.document's soft-delete pair", () => {
    expect(
      docsPendingProjection.actions.trash!(
        { document_id: "doc-1" },
        ctx("intent-4")
      )
    ).toMatchObject([
      { op: "upsert", entity: "core.document", rowId: "doc-1" },
    ]);
    expect(
      docsPendingProjection.actions.restore!(
        { document_id: "doc-1" },
        ctx("intent-5")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.document",
        rowId: "doc-1",
        values: { deleted_at: null, purge_at: null },
      },
    ]);
  });

  test("create-folder mints a concept under the real scheme, and projects nothing without one", () => {
    expect(
      docsPendingProjection.actions["create-folder"]!(
        { name: "Taxes", folder_scheme_id: "scheme-1" },
        ctx("intent-6")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.concept",
        rowId: "pending-intent-6",
        values: {
          concept_id: "pending-intent-6",
          scheme_id: "scheme-1",
          notation: "pending-intent-6",
          pref_label: "Taxes",
        },
      },
    ]);
    expect(
      docsPendingProjection.actions["create-folder"]!(
        { name: "Taxes" },
        ctx("intent-7")
      )
    ).toStrictEqual([]);
  });

  test("rename-folder upserts the concept's pref_label", () => {
    expect(
      docsPendingProjection.actions["rename-folder"]!(
        { folder_id: "folder-1", name: "New name" },
        ctx("intent-8")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.concept",
        rowId: "folder-1",
        values: { pref_label: "New name" },
      },
    ]);
  });

  test("star/unstar are deliberately undeclared", () => {
    expect(docsPendingProjection.actions.star).toBeUndefined();
    expect(docsPendingProjection.actions.unstar).toBeUndefined();
  });
});

// ─── the durable attention journal (issue #738 engine H) ────────────────────
//
// `restorePending()` reads TWO durable sources, because a settled write leaves
// the outbox: `pendingWrites()` for what is still in flight, and
// `attentionWrites()` for what came back denied/conflicted/failed. Without the
// second one a denied row lives only in this session's memory and dies on
// reload — the exact "anchored in app memory" failure the issue exists to end.

function state(): AppState {
  return {
    view: "grid",
    nav: { kind: "all" },
    sortKey: "added",
    sortDir: -1,
    type: "all",
    tag: "all",
    search: "",
    searchResults: null,
    searchSeq: 0,
    selected: new Set(),
    anchorIndex: null,
    detailsId: null,
    quickId: null,
    editingId: null,
    newMenuOpen: false,
    creatingFolder: false,
    renamingFolderId: null,
    folderNameDraft: null,
    narrow: false,
    uploading: false,
    visibleRows: [],
    driveWindow: 200,
    driveTruncated: false,
  };
}

function data(): AppData {
  return {
    folders: [],
    documents: [],
    root_folder_id: null,
    folder_scheme_id: "scheme-folders",
  };
}

function newLogic(appState: AppState = state()) {
  return createLogic({
    state: appState,
    data: data(),
    render: vi.fn<() => void>(),
    refresh: vi.fn<() => Promise<void>>(async () => undefined),
    openQuick: vi.fn<(id: string) => void>(),
  });
}

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

describe("Docs attention rows survive a reload (issue #738)", () => {
  beforeEach(() => {
    // logic.ts's `notice()` writes into the app's own banner; the real app
    // always has one, so the test gives it one rather than the code growing a
    // just-in-case guard.
    document.body.innerHTML = '<div id="noticeBanner" hidden></div>';
  });

  test("a denied trash persists with its reason across a FRESH logic instance, then retries under a new id", async () => {
    const journal = attentionJournal();
    const write = vi.fn<typeof window.centraid.write>(async (opts) => {
      journal.rows.push({
        intentId: opts.intentId!,
        action: opts.action,
        status: "denied",
        reason: "This document is in use elsewhere in your vault.",
        input: opts.input ?? {},
        mutations: (opts.optimistic ?? []) as never,
        settledAt: "2026-08-11T10:00:00.000Z",
      });
      return {
        status: "denied",
        reason: "This document is in use elsewhere in your vault.",
      } as never;
    });
    stubJournal(journal, { write });

    const first = newLogic();
    await first.act("trash", { document_id: "doc-1" });
    const deniedId = write.mock.calls[0]![0].intentId!;
    expect(first.attentionRows()).toMatchObject([
      {
        intentId: deniedId,
        action: "trash",
        status: "denied",
        reason: "This document is in use elsewhere in your vault.",
      },
    ]);

    // ---- reload: a brand-new logic instance with no memory whatsoever ----
    const second = newLogic();
    expect(second.attentionRows()).toStrictEqual([]);
    await second.restorePending();
    // Row CONTENT, never a count.
    expect(second.attentionRows()).toMatchObject([
      {
        intentId: deniedId,
        action: "trash",
        status: "denied",
        reason: "This document is in use elsewhere in your vault.",
        input: { document_id: "doc-1" },
      },
    ]);

    // ---- retry: same payload, FRESH intent id, old record forgotten ----
    await second.retryPending(deniedId);
    expect(journal.dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: deniedId,
    });
    const retried = write.mock.calls[1]![0];
    expect(retried.intentId).not.toBe(deniedId);
    expect(retried.input).toStrictEqual({ document_id: "doc-1" });
    expect(second.attentionRows()).toMatchObject([
      { intentId: retried.intentId, action: "trash", status: "denied" },
    ]);
  });

  test("Edit seeds the sidebar's folder-name field from the refused name; a trash offers retry and discard only", async () => {
    const journal = attentionJournal([
      {
        intentId: "intent-folder",
        action: "create-folder",
        status: "denied",
        reason: "A folder with that name already exists here.",
        input: { name: "Taxes", folder_scheme_id: "scheme-folders" },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
      {
        intentId: "intent-trash",
        action: "trash",
        status: "denied",
        reason: "This document is in use elsewhere in your vault.",
        input: { document_id: "doc-1" },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
    ]);
    stubJournal(journal);
    const composerState = state();
    const logic = newLogic(composerState);
    await logic.restorePending();

    const [folderRow, trashRow] = logic.attentionRows();
    // A trash carries no text to correct — its payload IS the row — so it
    // offers retry and discard rather than an empty surface.
    expect(logic.isEditablePending(folderRow!)).toBe(true);
    expect(logic.isEditablePending(trashRow!)).toBe(false);

    await logic.editPending("intent-folder");
    expect(composerState.creatingFolder).toBe(true);
    expect(composerState.folderNameDraft).toBe("Taxes");
    // Taken for correction is taken: the durable record goes with it, so the
    // corrected resend cannot leave a duplicate behind on the next reload.
    expect(journal.dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: "intent-folder",
    });
    expect(logic.attentionRows()).toMatchObject([{ intentId: "intent-trash" }]);
  });

  test("a discarded attention row stays discarded across a reload", async () => {
    const journal = attentionJournal([
      {
        intentId: "intent-denied",
        action: "rename",
        status: "denied",
        reason: "This document is read-only on this device.",
        input: { document_id: "doc-1", title: "Renamed.pdf" },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
    ]);
    stubJournal(journal);

    const before = newLogic();
    await before.restorePending();
    expect(before.attentionRows()).toMatchObject([
      { intentId: "intent-denied", action: "rename", status: "denied" },
    ]);
    expect(before.dismissPending("intent-denied")).toBe(true);
    expect(journal.rows).toStrictEqual([]);

    const after = newLogic();
    await after.restorePending();
    expect(after.attentionRows()).toStrictEqual([]);
  });

  test("a rename carries the document version it was composed against, a create-folder carries none, and a conflict states both", async () => {
    const rowVersion = vi.fn<NonNullable<typeof window.centraid.rowVersion>>(
      async () => 2
    );
    const write = vi.fn<typeof window.centraid.write>(
      async () =>
        ({
          status: "conflict",
          reason: "Someone else changed this first.",
          conflict: {
            entity: "core.document",
            rowId: "doc-1",
            expectedVersion: 2,
            actualVersion: 3,
          },
        }) as never
    );
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: { write, rowVersion, pendingWrites: async () => [] },
    });
    const logic = newLogic();

    await logic.act("rename", { document_id: "doc-1", title: "Renamed.pdf" });
    expect(rowVersion).toHaveBeenCalledWith({
      entity: "core.document",
      rowId: "doc-1",
    });
    expect(write.mock.calls[0]![0].baseVersions).toStrictEqual([
      { entity: "core.document", rowId: "doc-1", version: 2 },
    ]);
    // A conflict says WHICH versions disagreed — degrading it to a generic
    // error would waste the entire precondition.
    expect(logic.attentionRows()).toMatchObject([
      {
        action: "rename",
        status: "conflict",
        conflict: {
          entity: "core.document",
          rowId: "doc-1",
          expectedVersion: 2,
          actualVersion: 3,
        },
      },
    ]);

    // A create has no existing row to be stale against.
    await logic.act("create-folder", {
      name: "Taxes",
      folder_scheme_id: "scheme-folders",
    });
    expect(write.mock.calls[1]![0].baseVersions).toBeUndefined();
  });
});
