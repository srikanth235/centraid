import { beforeEach, describe, expect, test } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { bootstrapVault } from "../bootstrap.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential } from "../gateway/types.js";
import { uuidv7 } from "../ids.js";
import { registerScheduleCommands } from "./schedule.js";
import { registerTaskCommands } from "./tasks.js";

let db: VaultDb;
let gateway: Gateway;
let owner: Credential;
let calendarId: string;

describe("schedule organization commands", () => {
  beforeEach(() => {
    db = openVaultDb();
    const boot = bootstrapVault(db, { ownerName: "Priya" });
    gateway = createGateway(db);
    registerScheduleCommands(gateway);
    registerTaskCommands(gateway);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
    calendarId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO schedule_calendar
          (calendar_id, owner_party_id, name, default_tz, visibility)
         VALUES (?, ?, 'Home', 'Asia/Kolkata', 'private')`
      )
      .run(calendarId, boot.ownerPartyId);
  });
  function invoke(command: string, input: Record<string, unknown>) {
    return gateway.invoke(owner, {
      command,
      input,
      purpose: "dpv:ServiceProvision",
    });
  }

  function recurringEvent(): string {
    const result = invoke("schedule.propose_event", {
      summary: "Weekly planning",
      dtstart: "2026-07-06T03:30:00.000Z",
      dtend: "2026-07-06T04:00:00.000Z",
      start_tz: "Asia/Kolkata",
      calendar_id: calendarId,
      rrule: "FREQ=WEEKLY",
    });
    expect(result.status).toBe("executed");
    return (result as { output: { event_id: string } }).output.event_id;
  }

  test("full event editing updates content, time semantics, calendar details, and roster", () => {
    const eventId = recurringEvent();
    const guestId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_party
          (party_id, kind, display_name, created_at, updated_at)
         VALUES (?, 'person', 'Asha', ?, ?)`
      )
      .run(guestId, new Date().toISOString(), new Date().toISOString());

    const result = invoke("schedule.edit_event", {
      event_id: eventId,
      summary: "Weekly household planning",
      description: "Bring the list",
      dtstart: "2026-07-06T03:45:00.000Z",
      dtend: "2026-07-06T04:30:00.000Z",
      start_tz: "Asia/Kolkata",
      end_tz: "Europe/London",
      recurrence_semantics: "zoned",
      conferencing_uri: "https://meet.example.test/household",
      reminders: [{ minutes_before: 15 }],
      attendee_party_ids: [guestId],
    });

    expect(result.status).toBe("executed");
    expect(
      db.vault
        .prepare(
          `SELECT summary, description, dtstart, dtend, start_tz, end_tz,
                  recurrence_semantics, sequence
             FROM core_event WHERE event_id = ?`
        )
        .get(eventId)
    ).toMatchObject({
      summary: "Weekly household planning",
      description: "Bring the list",
      dtstart: "2026-07-06T03:45:00.000Z",
      dtend: "2026-07-06T04:30:00.000Z",
      start_tz: "Asia/Kolkata",
      end_tz: "Europe/London",
      recurrence_semantics: "zoned",
      sequence: 1,
    });
    expect(
      db.vault
        .prepare("SELECT party_id FROM schedule_attendee WHERE event_id = ?")
        .all(eventId)
    ).toStrictEqual([expect.objectContaining({ party_id: guestId })]);
  });

  test("occurrence and future edits persist stable exception identities", () => {
    const eventId = recurringEvent();
    for (const [scope, original, start] of [
      ["occurrence", "2026-07-13T03:30:00.000Z", "2026-07-13T05:30:00.000Z"],
      ["future", "2026-07-20T03:30:00.000Z", "2026-07-20T04:30:00.000Z"],
    ]) {
      expect(
        invoke("schedule.edit_event_occurrence", {
          event_id: eventId,
          original_start: original,
          scope,
          action: "override",
          dtstart: start,
        }).status
      ).toBe("executed");
    }
    const rows = db.vault
      .prepare(
        `SELECT original_start_local, recurrence_semantics, action, override_json
           FROM schedule_recurrence_exception
          WHERE target_id = ? ORDER BY original_start_local`
      )
      .all(eventId) as {
      original_start_local: string;
      recurrence_semantics: string;
      action: string;
      override_json: string;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.original_start_local)).toStrictEqual([
      "2026-07-13T09:00:00",
      "2026-07-20T09:00:00",
    ]);
    expect(rows.every((row) => row.recurrence_semantics === "zoned")).toBe(
      true
    );
    expect(JSON.parse(rows[1]!.override_json)).toMatchObject({
      scope: "future",
      start: "2026-07-20T04:30:00.000Z",
    });
  });

  test("this-occurrence override keeps every field that was set", () => {
    const eventId = recurringEvent();
    const guestId = uuidv7();
    db.vault
      .prepare(
        `INSERT INTO core_party
          (party_id, kind, display_name, created_at, updated_at)
         VALUES (?, 'person', 'Asha', ?, ?)`
      )
      .run(guestId, new Date().toISOString(), new Date().toISOString());

    expect(
      invoke("schedule.edit_event_occurrence", {
        event_id: eventId,
        original_start: "2026-07-13T03:30:00.000Z",
        scope: "occurrence",
        action: "override",
        summary: "Planning (moved)",
        dtstart: "2026-07-13T05:30:00.000Z",
        dtend: "2026-07-13T06:00:00.000Z",
        recurrence_semantics: "zoned",
        calendar_id: calendarId,
        reminders: [{ minutes_before: 15 }],
        conferencing_uri: "https://meet.example.test/planning",
        attendee_party_ids: [guestId],
      }).status
    ).toBe("executed");

    const row = db.vault
      .prepare(
        `SELECT override_json FROM schedule_recurrence_exception
          WHERE target_id = ? AND original_start_local = ?`
      )
      .get(eventId, "2026-07-13T09:00:00") as { override_json: string };
    expect(JSON.parse(row.override_json)).toMatchObject({
      scope: "occurrence",
      summary: "Planning (moved)",
      start: "2026-07-13T05:30:00.000Z",
      end: "2026-07-13T06:00:00.000Z",
      recurrence_semantics: "zoned",
      calendar_id: calendarId,
      reminders: [{ minutes_before: 15 }],
      conferencing_uri: "https://meet.example.test/planning",
      attendee_party_ids: [guestId],
    });
  });

  test("series-scope edit can cancel or retarget the whole series", () => {
    const eventId = recurringEvent();
    expect(
      invoke("schedule.edit_event_occurrence", {
        event_id: eventId,
        original_start: "2026-07-06T03:30:00.000Z",
        scope: "series",
        action: "override",
        summary: "Weekly planning (retargeted)",
        dtstart: "2026-07-06T04:00:00.000Z",
        dtend: "2026-07-06T04:30:00.000Z",
      }).status
    ).toBe("executed");
    expect(
      db.vault
        .prepare(
          "SELECT summary, dtstart, sequence FROM core_event WHERE event_id = ?"
        )
        .get(eventId)
    ).toMatchObject({
      summary: "Weekly planning (retargeted)",
      dtstart: "2026-07-06T04:00:00.000Z",
      sequence: 1,
    });

    expect(
      invoke("schedule.edit_event_occurrence", {
        event_id: eventId,
        original_start: "2026-07-06T04:00:00.000Z",
        scope: "series",
        action: "skip",
      }).status
    ).toBe("executed");
    expect(
      db.vault
        .prepare("SELECT status, sequence FROM core_event WHERE event_id = ?")
        .get(eventId)
    ).toMatchObject({ status: "cancelled", sequence: 2 });

    expect(
      invoke("schedule.edit_event_occurrence", {
        event_id: eventId,
        original_start: "2026-07-06T04:00:00.000Z",
        scope: "series",
        action: "skip",
      }).status
    ).toBe("executed");
    expect(
      db.vault
        .prepare("SELECT sequence FROM core_event WHERE event_id = ?")
        .get(eventId)
    ).toMatchObject({ sequence: 2 });
  });

  test("projects, sections, and task order form a durable organization spine", () => {
    const projectResult = invoke("schedule.save_project", {
      name: "House",
      area: "Personal",
      sort_order: 2,
    });
    const projectId = (projectResult as { output: { project_id: string } })
      .output.project_id;
    const sectionResult = invoke("schedule.save_section", {
      project_id: projectId,
      name: "Next",
      sort_order: 1,
    });
    const sectionId = (sectionResult as { output: { section_id: string } })
      .output.section_id;
    const taskResult = invoke("schedule.add_task", {
      title: "Replace filter",
      due_at: "2026-08-01T09:00:00.000Z",
      rrule: "FREQ=MONTHLY",
    });
    const taskId = (taskResult as { output: { task_id: string } }).output
      .task_id;

    expect(
      invoke("schedule.organize_task", {
        task_id: taskId,
        project_id: projectId,
        section_id: sectionId,
        sort_order: 7,
        recurrence_anchor: "completion",
        tz: "Asia/Kolkata",
      }).status
    ).toBe("executed");
    expect(
      db.vault
        .prepare(
          `SELECT project_id, section_id, sort_order, recurrence_anchor,
                  tz FROM schedule_task WHERE task_id = ?`
        )
        .get(taskId)
    ).toMatchObject({
      project_id: projectId,
      section_id: sectionId,
      sort_order: 7,
      recurrence_anchor: "completion",
      tz: "Asia/Kolkata",
    });
  });

  test("a completion-relative monthly task anchors its next occurrence to completion", () => {
    const taskResult = invoke("schedule.add_task", {
      title: "Review household budget",
      due_at: "2026-07-01T03:30:00.000Z",
      rrule: "FREQ=MONTHLY",
    });
    const taskId = (taskResult as { output: { task_id: string } }).output
      .task_id;
    expect(
      invoke("schedule.organize_task", {
        task_id: taskId,
        clear_project: true,
        sort_order: 0,
        recurrence_anchor: "completion",
        tz: "Asia/Kolkata",
      }).status
    ).toBe("executed");

    useFakeClock(new Date("2026-07-29T12:15:00.000Z"));
    const completed = invoke("schedule.set_task_status", {
      task_id: taskId,
      status: "completed",
    });
    expect(completed.status).toBe("executed");
    expect(
      (completed as { output: { next_due_at?: string } }).output.next_due_at
    ).toBe("2026-08-29T12:15:00.000Z");
  });
});
