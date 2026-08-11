// @vitest-environment jsdom
//
// People's pending-write projection (issue #738) — pure declaration checks,
// same convention as apps/_shared/pending-overlay.test.ts and
// apps/agenda/pending-projection.test.ts — plus the reload-survival tests for
// the durable attention journal at the bottom (jsdom, because those drive the
// real `createLogic`).
import { beforeEach, describe, expect, test, vi } from "vitest";

import { createLogic } from "./logic.ts";
import { peoplePendingProjection } from "./pending-projection.ts";
import type { AppData, AppState } from "./types.ts";

function ctx(intentId: string) {
  return { intentId, rowId: `pending-${intentId}` };
}

describe("People's pending-write projection", () => {
  test("add-person mints a core.party row plus its 1:1 people.profile", () => {
    const mutations = peoplePendingProjection.actions["add-person"]!(
      { display_name: "Ada Lovelace", cadence_days: 30, role: "Friend" },
      ctx("intent-1")
    );
    expect(mutations).toStrictEqual([
      {
        op: "upsert",
        entity: "core.party",
        rowId: "pending-intent-1",
        values: {
          party_id: "pending-intent-1",
          kind: "person",
          display_name: "Ada Lovelace",
        },
      },
      {
        op: "upsert",
        entity: "people.profile",
        rowId: "pending-intent-1-profile",
        values: {
          profile_id: "pending-intent-1-profile",
          party_id: "pending-intent-1",
          cadence_days: 30,
          role: "Friend",
        },
      },
    ]);
  });

  test("add-person with no display_name projects nothing", () => {
    expect(
      peoplePendingProjection.actions["add-person"]!(
        { cadence_days: 30 },
        ctx("intent-2")
      )
    ).toStrictEqual([]);
  });

  test("edit-person always upserts core.party's display_name; people.profile only when profile_id rides along", () => {
    expect(
      peoplePendingProjection.actions["edit-person"]!(
        { party_id: "party-1", display_name: "Renamed" },
        ctx("intent-3")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.party",
        rowId: "party-1",
        values: { display_name: "Renamed" },
      },
    ]);

    expect(
      peoplePendingProjection.actions["edit-person"]!(
        {
          party_id: "party-1",
          display_name: "Renamed",
          role: "Colleague",
          profile_id: "profile-1",
        },
        ctx("intent-4")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.party",
        rowId: "party-1",
        values: { display_name: "Renamed" },
      },
      {
        op: "upsert",
        entity: "people.profile",
        rowId: "profile-1",
        values: { role: "Colleague" },
      },
    ]);
  });

  test("trash-person/restore-person flip people_profile.deleted_at, keyed by profile_id", () => {
    expect(
      peoplePendingProjection.actions["trash-person"]!(
        { party_id: "party-1", profile_id: "profile-1" },
        ctx("intent-5")
      )
    ).toMatchObject([
      { op: "upsert", entity: "people.profile", rowId: "profile-1" },
    ]);
    expect(
      peoplePendingProjection.actions["restore-person"]!(
        { party_id: "party-1", profile_id: "profile-1" },
        ctx("intent-6")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "people.profile",
        rowId: "profile-1",
        values: { deleted_at: null },
      },
    ]);
  });

  test("trash-person/restore-person without a profile_id project nothing — there is no row to key the overlay on", () => {
    expect(
      peoplePendingProjection.actions["trash-person"]!(
        { party_id: "party-1" },
        ctx("intent-7")
      )
    ).toStrictEqual([]);
  });

  test("log-interaction stamps last_contacted_at on the profile row", () => {
    expect(
      peoplePendingProjection.actions["log-interaction"]!(
        { party_id: "party-1", kind: "Call", profile_id: "profile-1" },
        ctx("intent-8")
      )
    ).toMatchObject([
      {
        op: "upsert",
        entity: "people.profile",
        rowId: "profile-1",
        values: { last_contacted_at: expect.any(String) },
      },
    ]);
  });

  test("star-person/unstar-person are deliberately undeclared", () => {
    expect(peoplePendingProjection.actions["star-person"]).toBeUndefined();
    expect(peoplePendingProjection.actions["unstar-person"]).toBeUndefined();
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
    view: "list",
    nav: { kind: "all" },
    chip: "all",
    sortKey: "name",
    sortDir: 1,
    search: "",
    searchResults: null,
    searchSeq: 0,
    selected: new Set(),
    detailsId: null,
    detailPerson: null,
    detailAdders: {},
    newMenuOpen: false,
    addModalOpen: false,
    addDraft: null,
    creatingList: false,
    renamingListId: null,
    narrow: false,
    peopleWindow: 200,
    peopleTruncated: false,
    journalData: null,
    dashboardData: null,
    visibleRows: [],
  };
}

function data(): AppData {
  return { people: [], trash: [], lists: [] };
}

function newLogic(appState: AppState = state()) {
  return createLogic({
    state: appState,
    data: data(),
    render: vi.fn<() => void>(),
    refresh: vi.fn<() => Promise<void>>(async () => undefined),
    renderRows: vi.fn<() => void>(),
    renderDetails: vi.fn<() => void>(),
    renderModal: vi.fn<() => void>(),
    renderNewMenu: vi.fn<() => void>(),
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

describe("People attention rows survive a reload (issue #738)", () => {
  beforeEach(() => {
    // logic.ts's `notice()` writes into the app's own banner; the real app
    // always has one, so the test gives it one rather than the code growing a
    // just-in-case guard.
    document.body.innerHTML = '<div id="noticeBanner" hidden></div>';
  });

  test("a denied add-person persists with its reason across a FRESH logic instance, then retries under a new id", async () => {
    const journal = attentionJournal();
    const write = vi.fn<typeof window.centraid.write>(async (opts) => {
      journal.rows.push({
        intentId: opts.intentId!,
        action: opts.action,
        status: "denied",
        reason: "This vault does not allow new people from this device.",
        input: opts.input ?? {},
        mutations: (opts.optimistic ?? []) as never,
        settledAt: "2026-08-11T10:00:00.000Z",
      });
      return {
        status: "denied",
        reason: "This vault does not allow new people from this device.",
      } as never;
    });
    stubJournal(journal, { write });

    const first = newLogic();
    await first.addPerson({
      name: "Ada Lovelace",
      role: "Mentor",
      listId: null,
      cadence: 30,
    });
    const deniedId = write.mock.calls[0]![0].intentId!;
    expect(first.attentionRows()).toMatchObject([
      {
        intentId: deniedId,
        action: "add-person",
        status: "denied",
        reason: "This vault does not allow new people from this device.",
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
        action: "add-person",
        status: "denied",
        reason: "This vault does not allow new people from this device.",
        input: { display_name: "Ada Lovelace", role: "Mentor" },
      },
    ]);

    // ---- retry: same payload, FRESH intent id, old record forgotten ----
    await second.retryPending(deniedId);
    expect(journal.dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: deniedId,
    });
    const retried = write.mock.calls[1]![0];
    expect(retried.intentId).not.toBe(deniedId);
    expect(retried.input).toMatchObject({ display_name: "Ada Lovelace" });
    expect(second.attentionRows()).toMatchObject([
      { intentId: retried.intentId, action: "add-person", status: "denied" },
    ]);
  });

  test("Edit reopens the Add-someone composer from the refused payload; an edit-person offers retry and discard only", async () => {
    const journal = attentionJournal([
      {
        intentId: "intent-add",
        action: "add-person",
        status: "denied",
        reason: "This vault does not allow new people from this device.",
        input: {
          display_name: "Ada Lovelace",
          role: "Mentor",
          cadence_days: 14,
          avatar_color: "#123456",
          list_id: "list-1",
        },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
      {
        intentId: "intent-edit",
        action: "edit-person",
        status: "denied",
        reason: "This person is read-only on this device.",
        input: { party_id: "party-1", display_name: "Ada L." },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
    ]);
    stubJournal(journal);
    const composerState = state();
    const logic = newLogic(composerState);
    await logic.restorePending();

    const [addRow, editRow] = logic.attentionRows();
    // The profile drawer is bound to the canonical person and saves field by
    // field, so a refused edit offers retry and discard rather than a surface
    // that would resave on the next blur.
    expect(logic.isEditablePending(addRow!)).toBe(true);
    expect(logic.isEditablePending(editRow!)).toBe(false);

    expect(logic.editPending("intent-add")).toBe(true);
    expect(composerState.addModalOpen).toBe(true);
    expect(composerState.addDraft).toStrictEqual({
      id: "intent-add",
      name: "Ada Lovelace",
      role: "Mentor",
      listId: "list-1",
      cadence: 14,
    });
    // Taken for correction is taken: the durable record goes with it, so the
    // corrected resend cannot leave a duplicate behind on the next reload.
    expect(journal.dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: "intent-add",
    });
    expect(logic.attentionRows()).toMatchObject([{ intentId: "intent-edit" }]);
  });

  test("a discarded attention row stays discarded across a reload", async () => {
    const journal = attentionJournal([
      {
        intentId: "intent-denied",
        action: "add-person",
        status: "denied",
        reason: "This vault does not allow new people from this device.",
        input: { display_name: "Ada Lovelace" },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
    ]);
    stubJournal(journal);

    const before = newLogic();
    await before.restorePending();
    expect(before.attentionRows()).toMatchObject([
      { intentId: "intent-denied", action: "add-person", status: "denied" },
    ]);
    expect(before.dismissPending("intent-denied")).toBe(true);
    expect(journal.rows).toStrictEqual([]);

    const after = newLogic();
    await after.restorePending();
    expect(after.attentionRows()).toStrictEqual([]);
  });

  test("an edit-person carries the party version it was composed against, an add carries none, and a conflict states both", async () => {
    const rowVersion = vi.fn<NonNullable<typeof window.centraid.rowVersion>>(
      async () => 5
    );
    const write = vi.fn<typeof window.centraid.write>(
      async () =>
        ({
          status: "conflict",
          reason: "Someone else changed this first.",
          conflict: {
            entity: "core.party",
            rowId: "party-1",
            expectedVersion: 5,
            actualVersion: 8,
          },
        }) as never
    );
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: { write, rowVersion, pendingWrites: async () => [] },
    });
    const logic = newLogic();

    await logic.act("edit-person", {
      party_id: "party-1",
      display_name: "Ada L.",
    });
    expect(rowVersion).toHaveBeenCalledWith({
      entity: "core.party",
      rowId: "party-1",
    });
    expect(write.mock.calls[0]![0].baseVersions).toStrictEqual([
      { entity: "core.party", rowId: "party-1", version: 5 },
    ]);
    // A conflict says WHICH versions disagreed — degrading it to a generic
    // error would waste the entire precondition.
    expect(logic.attentionRows()).toMatchObject([
      {
        action: "edit-person",
        status: "conflict",
        conflict: {
          entity: "core.party",
          rowId: "party-1",
          expectedVersion: 5,
          actualVersion: 8,
        },
      },
    ]);

    // A create has no existing row to be stale against.
    await logic.act("add-person", { display_name: "Grace Hopper" });
    expect(write.mock.calls[1]![0].baseVersions).toBeUndefined();
  });
});
