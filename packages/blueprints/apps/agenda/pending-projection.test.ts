// @vitest-environment jsdom
//
// Agenda's pending-write overlay (issue #738): the declaration's pure
// projections (mirrors pending-overlay.test.ts's per-app-declaration
// convention), plus one reload-survival behavioral test through
// `createLogic` — a queued RSVP the durable outbox reports on mount must
// still render as pending after a reload with no in-memory state at all.
import { describe, expect, test, vi } from "vitest";

import { createLogic } from "./logic.ts";
import { agendaPendingProjection } from "./pending-projection.ts";
import type { AppData, AppState } from "./types.ts";

function ctx(intentId: string) {
  return { intentId, rowId: `pending-${intentId}` };
}

describe("Agenda's pending-write projection", () => {
  test("propose upserts a new tentative core.event row under the minted id", () => {
    const mutations = agendaPendingProjection.actions.propose!(
      {
        summary: "Standup",
        dtstart: "2026-08-12T09:00:00Z",
        dtend: "2026-08-12T09:15:00Z",
        calendar_id: "cal-work",
      },
      ctx("intent-1")
    );
    expect(mutations).toStrictEqual([
      {
        op: "upsert",
        entity: "core.event",
        rowId: "pending-intent-1",
        values: {
          event_id: "pending-intent-1",
          status: "tentative",
          sequence: 0,
          summary: "Standup",
          dtstart: "2026-08-12T09:00:00Z",
          dtend: "2026-08-12T09:15:00Z",
        },
      },
    ]);
  });

  test("rsvp upserts the attendee's own row, keyed by the input's attendee_id", () => {
    const mutations = agendaPendingProjection.actions.rsvp!(
      {
        event_id: "event-1",
        party_id: "party-1",
        partstat: "accepted",
        attendee_id: "attendee-1",
      },
      ctx("intent-2")
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({
      op: "upsert",
      entity: "schedule.attendee",
      rowId: "attendee-1",
      values: { partstat: "accepted" },
    });
  });

  test("rsvp with no attendee_id projects nothing — there is no row to key the overlay on", () => {
    expect(
      agendaPendingProjection.actions.rsvp!(
        { event_id: "event-1", party_id: "party-1", partstat: "accepted" },
        ctx("intent-3")
      )
    ).toStrictEqual([]);
  });

  test("cancel-event flips status on the existing event row", () => {
    expect(
      agendaPendingProjection.actions["cancel-event"]!(
        { event_id: "event-1" },
        ctx("intent-4")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.event",
        rowId: "event-1",
        values: { status: "cancelled" },
      },
    ]);
  });

  test("edit-event projects only the fields present, honoring clear_* flags", () => {
    expect(
      agendaPendingProjection.actions["edit-event"]!(
        {
          event_id: "event-1",
          summary: "Renamed",
          clear_description: true,
          dtstart: "2026-08-12T10:00:00Z",
        },
        ctx("intent-5")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.event",
        rowId: "event-1",
        values: {
          summary: "Renamed",
          dtstart: "2026-08-12T10:00:00Z",
          description: null,
        },
      },
    ]);
  });

  test("edit-occurrence projects only scope:series — occurrence/future exceptions are not overlay-able", () => {
    expect(
      agendaPendingProjection.actions["edit-occurrence"]!(
        {
          event_id: "event-1",
          original_start: "2026-08-12",
          scope: "occurrence",
          action: "skip",
        },
        ctx("intent-6")
      )
    ).toStrictEqual([]);
    expect(
      agendaPendingProjection.actions["edit-occurrence"]!(
        {
          event_id: "event-1",
          original_start: "2026-08-12",
          scope: "series",
          action: "skip",
        },
        ctx("intent-7")
      )
    ).toStrictEqual([
      {
        op: "upsert",
        entity: "core.event",
        rowId: "event-1",
        values: { status: "cancelled" },
      },
    ]);
  });
});

function state(): AppState {
  return {
    view: "schedule",
    cursor: new Date("2026-08-12T00:00:00Z"),
    search: "",
    searchResults: null,
    hiddenCals: new Set(),
    detailEventId: null,
    createOpen: false,
    createPrefill: null,
    narrow: false,
    activityLog: new Map(),
    readFailedShown: false,
  };
}

function data(): AppData {
  return { events: [], miniEvents: [], calendars: [], calById: new Map() };
}

describe("Agenda pending-write reload survival", () => {
  test("a queued RSVP the durable outbox reports on mount renders pending with no prior in-memory state", async () => {
    const pendingWrites = vi.fn<
      NonNullable<typeof window.centraid.pendingWrites>
    >(async () => [
      {
        intentId: "intent-reload",
        action: "rsvp",
        state: "queued",
        input: {
          event_id: "event-1",
          party_id: "party-1",
          partstat: "accepted",
          attendee_id: "attendee-1",
        },
        mutations: [
          {
            op: "upsert",
            entity: "schedule.attendee",
            rowId: "attendee-1",
            values: {
              partstat: "accepted",
              responded_at: "2026-08-11T00:00:00.000Z",
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
    expect(byRowId.has("attendee-1")).toBe(true);
    expect(byRowId.get("attendee-1")).toMatchObject({
      action: "rsvp",
      status: "queued",
    });
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

function newLogic() {
  return createLogic({
    state: state(),
    data: data(),
    render: vi.fn<() => void>(),
    refresh: vi.fn<() => Promise<void>>(async () => undefined),
  });
}

describe("Agenda attention rows survive a reload (issue #738)", () => {
  test("a denied propose persists with its reason across a FRESH logic instance, then retries under a new id", async () => {
    const journal = attentionJournal();
    const write = vi.fn<typeof window.centraid.write>(async (opts) => {
      journal.rows.push({
        intentId: opts.intentId!,
        action: opts.action,
        status: "denied",
        reason: "That calendar is read-only on this device.",
        input: opts.input ?? {},
        mutations: (opts.optimistic ?? []) as never,
        settledAt: "2026-08-11T10:00:00.000Z",
      });
      return {
        status: "denied",
        reason: "That calendar is read-only on this device.",
      } as never;
    });
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {
        write,
        pendingWrites: async () => [],
        attentionWrites: async () => journal.rows.map((row) => ({ ...row })),
        dismissAttentionWrite: journal.dismissAttentionWrite,
      },
    });

    const first = newLogic();
    await first.proposeEvent({
      summary: "Standup",
      dtstart: "2026-08-12T09:00:00Z",
      dtend: "2026-08-12T09:15:00Z",
      calendar_id: "cal-work",
      start_tz: "UTC",
      end_tz: "UTC",
      recurrence_semantics: "zoned",
      reminders: [],
    });
    const deniedId = write.mock.calls[0]![0].intentId!;
    expect(first.attentionRows()).toMatchObject([
      {
        intentId: deniedId,
        action: "propose",
        status: "denied",
        reason: "That calendar is read-only on this device.",
      },
    ]);

    // ---- reload: a brand-new logic instance with no memory whatsoever ----
    const second = newLogic();
    expect(second.attentionRows()).toStrictEqual([]);
    await second.restorePending();
    // Row CONTENT, never a count: the refused event is back, still saying
    // what happened and still carrying the payload an answer needs.
    expect(second.attentionRows()).toMatchObject([
      {
        intentId: deniedId,
        action: "propose",
        status: "denied",
        reason: "That calendar is read-only on this device.",
        input: { summary: "Standup", calendar_id: "cal-work" },
      },
    ]);

    // ---- retry: same payload, FRESH intent id, old record forgotten ----
    await second.retryPending(deniedId);
    expect(journal.dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: deniedId,
    });
    const retried = write.mock.calls[1]![0];
    expect(retried.intentId).not.toBe(deniedId);
    expect(retried.input).toMatchObject({ summary: "Standup" });
    expect(second.attentionRows()).toMatchObject([
      { intentId: retried.intentId, action: "propose", status: "denied" },
    ]);
  });

  test("Edit reopens the create composer prefilled from the refused payload; only propose is editable", async () => {
    const journal = attentionJournal([
      {
        intentId: "intent-denied",
        action: "propose",
        status: "denied",
        reason: "That calendar is read-only on this device.",
        input: {
          summary: "Standup",
          description: "Daily sync",
          dtstart: "2026-08-12T09:00:00.000Z",
          dtend: "2026-08-12T09:15:00.000Z",
          calendar_id: "cal-work",
          rrule: "FREQ=WEEKLY",
        },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
      {
        intentId: "intent-rsvp",
        action: "rsvp",
        status: "denied",
        reason: "You are not on the guest list.",
        input: {
          event_id: "event-1",
          party_id: "party-1",
          partstat: "accepted",
          attendee_id: "attendee-1",
        },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
    ]);
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {
        pendingWrites: async () => [],
        attentionWrites: async () => journal.rows.map((row) => ({ ...row })),
        dismissAttentionWrite: journal.dismissAttentionWrite,
      },
    });
    const composerState = state();
    const logic = createLogic({
      state: composerState,
      data: data(),
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(async () => undefined),
    });
    await logic.restorePending();

    const [proposeRow, rsvpRow] = logic.attentionRows();
    // The event drawer edits the CANONICAL event, not this payload, so a
    // refused RSVP offers retry and discard alone rather than a surface that
    // shows something other than what was refused.
    expect(logic.isEditablePending(proposeRow!)).toBe(true);
    expect(logic.isEditablePending(rsvpRow!)).toBe(false);

    expect(logic.editPending("intent-denied")).toBe(true);
    expect(composerState.createOpen).toBe(true);
    expect(composerState.createPrefill).toMatchObject({
      summary: "Standup",
      description: "Daily sync",
      calendarId: "cal-work",
      rrule: "FREQ=WEEKLY",
    });
    expect(composerState.createPrefill!.start!.toISOString()).toBe(
      "2026-08-12T09:00:00.000Z"
    );
    // Taken for correction is taken: the durable record goes with it, so the
    // corrected resend cannot leave a duplicate behind on the next reload.
    expect(journal.dismissAttentionWrite).toHaveBeenCalledWith({
      intentId: "intent-denied",
    });
    expect(logic.attentionRows()).toMatchObject([{ intentId: "intent-rsvp" }]);
  });

  test("a discarded attention row stays discarded across a reload", async () => {
    const journal = attentionJournal([
      {
        intentId: "intent-denied",
        action: "propose",
        status: "denied",
        reason: "That calendar is read-only on this device.",
        input: { summary: "Standup", calendar_id: "cal-work" },
        mutations: [],
        settledAt: "2026-08-11T10:00:00.000Z",
      },
    ]);
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: {
        pendingWrites: async () => [],
        attentionWrites: async () => journal.rows.map((row) => ({ ...row })),
        dismissAttentionWrite: journal.dismissAttentionWrite,
      },
    });

    const before = newLogic();
    await before.restorePending();
    expect(before.attentionRows()).toMatchObject([
      { intentId: "intent-denied", status: "denied" },
    ]);
    expect(before.dismissPending("intent-denied")).toBe(true);
    expect(journal.rows).toStrictEqual([]);

    const after = newLogic();
    await after.restorePending();
    expect(after.attentionRows()).toStrictEqual([]);
  });

  test("an RSVP carries the attendee row version it was composed against, a propose carries none, and a conflict states both", async () => {
    const rowVersion = vi.fn<NonNullable<typeof window.centraid.rowVersion>>(
      async () => 3
    );
    const write = vi.fn<typeof window.centraid.write>(
      async () =>
        ({
          status: "conflict",
          reason: "Someone else changed this first.",
          conflict: {
            entity: "schedule.attendee",
            rowId: "attendee-1",
            expectedVersion: 3,
            actualVersion: 5,
          },
        }) as never
    );
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: { write, rowVersion, pendingWrites: async () => [] },
    });
    const logic = newLogic();

    await logic.act("rsvp", {
      event_id: "event-1",
      party_id: "party-1",
      partstat: "accepted",
      attendee_id: "attendee-1",
    });
    expect(rowVersion).toHaveBeenCalledWith({
      entity: "schedule.attendee",
      rowId: "attendee-1",
    });
    expect(write.mock.calls[0]![0].baseVersions).toStrictEqual([
      { entity: "schedule.attendee", rowId: "attendee-1", version: 3 },
    ]);
    // A conflict says WHICH versions disagreed — degrading it to a generic
    // error would waste the entire precondition.
    expect(logic.attentionRows()).toMatchObject([
      {
        action: "rsvp",
        status: "conflict",
        conflict: {
          entity: "schedule.attendee",
          rowId: "attendee-1",
          expectedVersion: 3,
          actualVersion: 5,
        },
      },
    ]);

    // A create has no existing row to be stale against.
    await logic.act("propose", {
      summary: "Standup",
      dtstart: "2026-08-12T09:00:00Z",
      dtend: "2026-08-12T09:15:00Z",
      calendar_id: "cal-work",
    });
    expect(write.mock.calls[1]![0].baseVersions).toBeUndefined();
  });
});
