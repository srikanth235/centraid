// BEHAVIOUR SCENARIOS (#996, wave 0c; rulings R21, ONT-25 and ONT-27).
//
// Written through the real command path and read back the way a surface reads
// it — through the occurrence adapter every reader now consumes, and through
// the stored rows the queries select. Never by asserting on a column the
// change is about.
//
//   1. CREATE, SKIP DAY TWO, QUERY. Under five readings of the same wall
//      clock: UTC, a non-UTC zone, a DST boundary, floating, and all-day. The
//      exception is stored keyed on the series-local wall clock; the readers
//      spelled that key three different ways and matched nothing, so the
//      skipped occurrence came back on every surface.
//   2. COMPLETING FROM PEOPLE AND COMPLETING FROM TASKS IS ONE COMPLETION.
//      Two apps, one operation: the second call is not a reopen, the series
//      rolls over exactly once, and the successor is still about the person.

import { beforeEach, afterEach, describe, expect, test } from "vitest";

import {
  applyRecurrenceExceptions,
  expandRecurrence,
  occurrenceExceptionsOf,
  occurrenceKeyToken,
  recurrenceExceptionsOf,
} from "@centraid/core/time";

import { bootstrapVault } from "../bootstrap.js";
import type { BootstrapResult } from "../bootstrap.js";
import { registerPeopleCommands } from "../commands/people.js";
import { registerScheduleCommands } from "../commands/schedule.js";
import { registerTaskCommands } from "../commands/tasks.js";
import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import { createGateway } from "../gateway/gateway.js";
import type { Gateway } from "../gateway/gateway.js";
import type { Credential, InvokeOutcome } from "../gateway/types.js";

let db: VaultDb;
let gw: Gateway;
let boot: BootstrapResult;
let owner: Credential;

interface Reading {
  name: string;
  semantics: "zoned" | "floating" | "all-day";
  tz: string | undefined;
  /** Day one of the series, in the reading's own vocabulary. */
  dtstart: string;
  dtend: string;
  /** Day two — the occurrence the scenario skips. */
  dayTwo: string;
}

/**
 * The five readings the same skip has to survive. The DST row starts the day
 * before Europe/London springs forward, so day two is on the other side of the
 * transition: the wall clock repeats and the instant does not, which is
 * exactly the case a UTC-keyed exception used to lose.
 */
const READINGS: readonly Reading[] = [
  {
    name: "UTC",
    semantics: "zoned",
    tz: "Etc/UTC",
    dtstart: "2026-03-02T09:00:00.000Z",
    dtend: "2026-03-02T10:00:00.000Z",
    dayTwo: "2026-03-03T09:00:00.000Z",
  },
  {
    name: "a non-UTC zone",
    semantics: "zoned",
    tz: "Asia/Kolkata",
    dtstart: "2026-03-02T03:30:00.000Z",
    dtend: "2026-03-02T04:30:00.000Z",
    dayTwo: "2026-03-03T03:30:00.000Z",
  },
  {
    name: "a DST boundary",
    semantics: "zoned",
    tz: "Europe/London",
    dtstart: "2026-03-28T09:00:00.000Z",
    dtend: "2026-03-28T10:00:00.000Z",
    dayTwo: "2026-03-29T08:00:00.000Z",
  },
  {
    name: "floating",
    semantics: "floating",
    tz: undefined,
    dtstart: "2026-03-02T09:00",
    dtend: "2026-03-02T10:00",
    dayTwo: "2026-03-03T09:00",
  },
  {
    name: "all-day",
    semantics: "all-day",
    tz: undefined,
    dtstart: "2026-03-02",
    dtend: "2026-03-03",
    dayTwo: "2026-03-03",
  },
];

describe("wave 0c behaviour scenarios", () => {
  beforeEach(() => {
    db = openVaultDb();
    boot = bootstrapVault(db, { ownerName: "Priya" });
    gw = createGateway(db);
    registerScheduleCommands(gw);
    registerTaskCommands(gw);
    registerPeopleCommands(gw);
    owner = {
      kind: "device",
      deviceId: boot.deviceId,
      deviceKey: boot.deviceKey,
    };
  });

  afterEach(() => {
    db.close();
  });

  function invoke(
    command: string,
    input: Record<string, unknown>
  ): InvokeOutcome {
    return gw.invoke(owner, { command, input });
  }

  function calendarId(): string {
    const row = db.vault
      .prepare("SELECT calendar_id FROM schedule_calendar LIMIT 1")
      .get() as { calendar_id: string } | undefined;
    expect(row, "the bootstrapped vault has a calendar").toBeDefined();
    return row!.calendar_id;
  }

  /** Every stored exception row, as the readers see them: keys, not columns. */
  function storedExceptions(eventId: string) {
    const rows = db.vault
      .prepare(
        `SELECT * FROM schedule_recurrence_exception
          WHERE target_type = 'core.event' AND target_id = ?`
      )
      .all(eventId) as Record<string, unknown>[];
    return occurrenceExceptionsOf(rows, {
      seriesType: "core.event",
      seriesId: eventId,
    });
  }

  test.each(READINGS)(
    "create, skip day two, query — $name",
    (reading: Reading) => {
      const created = invoke("schedule.propose_event", {
        summary: `Standup (${reading.name})`,
        dtstart: reading.dtstart,
        dtend: reading.dtend,
        calendar_id: calendarId(),
        recurrence_semantics: reading.semantics,
        rrule: "FREQ=DAILY;COUNT=4",
        ...(reading.tz === undefined ? {} : { start_tz: reading.tz }),
      });
      expect(created.status, JSON.stringify(created)).toBe("executed");
      const eventId = (created as { output: { event_id: string } }).output
        .event_id;

      // The occurrence the member skipped, named the way the surface names it:
      // the series' own wall clock for day two.
      const expanded = expandRecurrence({
        rrule: "FREQ=DAILY;COUNT=4",
        start: reading.dtstart,
        rangeFrom: reading.dtstart,
        rangeTo: "2026-05-01T00:00:00.000Z",
        ...(reading.tz === undefined ? {} : { timeZone: reading.tz }),
        semantics: reading.semantics,
      });
      expect(expanded).toHaveLength(4);
      // The KEY, not the instant: `original_start_local` is the series' own
      // wall clock, and for a zoned series those are two different strings.
      const dayTwoKey = expanded[1]!.wallStart;

      const skipped = invoke("schedule.edit_event_occurrence", {
        event_id: eventId,
        original_start_local: dayTwoKey,
        scope: "occurrence",
        action: "skip",
      });
      expect(skipped.status, JSON.stringify(skipped)).toBe("executed");

      // Read back through the ONE adapter, which is what `upcoming.ts`,
      // `useAgenda.ts`, the home tile and Tally's dashboard now all use.
      const exceptions = storedExceptions(eventId);
      expect(exceptions).toHaveLength(1);
      expect(exceptions[0]!.key.localStart).toBe(dayTwoKey);
      expect(exceptions[0]!.key.semantics).toBe(reading.semantics);
      expect(occurrenceKeyToken(exceptions[0]!.key)).toContain(eventId);

      const shown = applyRecurrenceExceptions(
        expanded,
        recurrenceExceptionsOf(exceptions)
      );
      expect(shown).toHaveLength(3);
      expect(
        shown.some((instance) => instance.wallStart === dayTwoKey),
        "the skipped occurrence is gone"
      ).toBe(false);
      // Days one, three and four are untouched.
      expect(shown.map((instance) => instance.wallStart)).toStrictEqual([
        expanded[0]!.wallStart,
        expanded[2]!.wallStart,
        expanded[3]!.wallStart,
      ]);
    }
  );

  // ── People-complete-then-Tasks-complete is ONE completion ───────────────

  function addPersonTask(): { partyId: string; taskId: string } {
    const person = invoke("people.add_person", {
      display_name: "Mum",
      cadence_days: 30,
    });
    expect(person.status, JSON.stringify(person)).toBe("executed");
    const partyId = (person as { output: { party_id: string } }).output
      .party_id;
    const task = invoke("people.add_task", {
      party_id: partyId,
      text: "Call Mum",
    });
    expect(task.status, JSON.stringify(task)).toBe("executed");
    return {
      partyId,
      taskId: (task as { output: { task_id: string } }).output.task_id,
    };
  }

  function statusOf(taskId: string): {
    status: string;
    completed_at: string | null;
    series_id: string | null;
  } {
    return db.vault
      .prepare(
        "SELECT status, completed_at, series_id FROM schedule_task WHERE task_id = ?"
      )
      .get(taskId) as {
      status: string;
      completed_at: string | null;
      series_id: string | null;
    };
  }

  test("completing from People and then from Tasks is one completion", () => {
    const { taskId } = addPersonTask();
    expect(statusOf(taskId).status).toBe("needs-action");

    expect(invoke("people.complete_task", { task_id: taskId }).status).toBe(
      "executed"
    );
    const afterPeople = statusOf(taskId);
    expect(afterPeople.status).toBe("completed");

    // The toggle this replaced would have REOPENED it here, because its answer
    // depended on a state the caller never read (#996, ONT-27).
    expect(
      invoke("schedule.set_task_status", {
        task_id: taskId,
        status: "completed",
      }).status
    ).toBe("executed");
    const afterTasks = statusOf(taskId);
    expect(afterTasks.status).toBe("completed");
    expect(afterTasks.completed_at).toBe(afterPeople.completed_at);
  });

  test("a recurring person task rolls over once, and the successor is still about the person", () => {
    const { partyId, taskId } = addPersonTask();
    // Make it a series through the ordinary task edit path.
    expect(
      invoke("schedule.edit_task", {
        task_id: taskId,
        due_at: "2026-03-02T09:00:00.000Z",
        rrule: "FREQ=WEEKLY",
      }).status
    ).toBe("executed");

    const first = invoke("people.complete_task", { task_id: taskId });
    expect(first.status, JSON.stringify(first)).toBe("executed");
    const output = (
      first as {
        output: { next_task_id?: string; series_id: string | null };
      }
    ).output;
    expect(
      output.next_task_id,
      "a repeating task spawns its successor"
    ).toBeDefined();
    const nextTaskId = output.next_task_id!;

    // ONE roll-over: completing again from the other app spawns nothing.
    const second = invoke("schedule.set_task_status", {
      task_id: taskId,
      status: "completed",
    });
    expect(second.status).toBe("executed");
    expect(
      (second as { output: { next_task_id?: string } }).output.next_task_id
    ).toBeUndefined();
    const open = db.vault
      .prepare(
        "SELECT count(*) AS n FROM schedule_task WHERE status = 'needs-action'"
      )
      .get() as { n: number };
    expect(open.n).toBe(1);

    // The series identity, and the `about` link the successor inherits.
    const done = statusOf(taskId);
    const next = statusOf(nextTaskId);
    expect(done.series_id).toBe(taskId);
    expect(next.series_id).toBe(taskId);
    const about = db.vault
      .prepare(
        `SELECT count(*) AS n FROM core_link
          WHERE from_type = 'schedule.task' AND from_id = ?
            AND to_type = 'core.party' AND to_id = ? AND valid_to IS NULL`
      )
      .get(nextTaskId, partyId) as { n: number };
    expect(about.n, "the successor is still about Mum").toBe(1);
  });

  test("reopening is not completing, and neither is a toggle", () => {
    const { taskId } = addPersonTask();
    expect(invoke("people.complete_task", { task_id: taskId }).status).toBe(
      "executed"
    );
    expect(invoke("people.reopen_task", { task_id: taskId }).status).toBe(
      "executed"
    );
    const reopened = statusOf(taskId);
    expect(reopened.status).toBe("needs-action");
    expect(reopened.completed_at).toBeNull();
    // Reopening twice is still reopened — every operation here is idempotent.
    expect(invoke("people.reopen_task", { task_id: taskId }).status).toBe(
      "executed"
    );
    expect(statusOf(taskId).status).toBe("needs-action");
  });
});
