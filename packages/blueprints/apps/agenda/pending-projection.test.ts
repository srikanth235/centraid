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
