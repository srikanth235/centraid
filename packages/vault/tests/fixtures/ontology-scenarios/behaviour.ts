// BEHAVIOUR — the scenarios wave 0c landed (#996).
//
// One invariant boundary and one occurrence key. A skipped occurrence must be
// gone under every reading of the same wall clock; completing a task from two
// apps must be one completion; and an impossible task must be refused with the
// same sentence whichever door it arrives through.

import {
  applyRecurrenceExceptions,
  expandRecurrence,
  occurrenceExceptionsOf,
  recurrenceExceptionsOf,
} from "@centraid/core/time";

import type { InvokeOutcome } from "../../../src/gateway/types.js";
import type {
  ScenarioCheck,
  ScenarioContext,
  ScenarioDefinition,
} from "./types.js";

interface Reading {
  readonly name: string;
  readonly semantics: "zoned" | "floating" | "all-day";
  readonly tz: string | undefined;
  readonly dtstart: string;
  readonly dtend: string;
}

/**
 * The five readings the same skip has to survive. The DST row starts the day
 * before Europe/London springs forward, so day two is on the other side of the
 * transition: the wall clock repeats and the instant does not, which is exactly
 * the case a UTC-keyed exception used to lose.
 *
 * Each reading gets its own WEEK because all five series live in one vault
 * here, and `schedule.propose_event` refuses a busy overlap across calendars.
 * Nothing about the skip depends on the date.
 */
const READINGS: readonly Reading[] = [
  {
    name: "UTC",
    semantics: "zoned",
    tz: "Etc/UTC",
    dtstart: "2026-03-02T09:00:00.000Z",
    dtend: "2026-03-02T10:00:00.000Z",
  },
  {
    name: "a non-UTC zone",
    semantics: "zoned",
    tz: "Asia/Kolkata",
    dtstart: "2026-03-09T03:30:00.000Z",
    dtend: "2026-03-09T04:30:00.000Z",
  },
  {
    name: "a DST boundary",
    semantics: "zoned",
    tz: "Europe/London",
    dtstart: "2026-03-28T09:00:00.000Z",
    dtend: "2026-03-28T10:00:00.000Z",
  },
  {
    name: "floating",
    semantics: "floating",
    tz: undefined,
    dtstart: "2026-04-06T09:00",
    dtend: "2026-04-06T10:00",
  },
  {
    name: "all-day",
    semantics: "all-day",
    tz: undefined,
    dtstart: "2026-04-13",
    dtend: "2026-04-14",
  },
];

const RRULE = "FREQ=DAILY;COUNT=4";

function calendarId(ctx: ScenarioContext): string {
  return ctx.row<{ calendar_id: string }>(
    "SELECT calendar_id FROM schedule_calendar LIMIT 1"
  )!.calendar_id;
}

/** Create a daily series under one reading, skip day two, and read the series
 *  back the way every agenda surface reads it: through the occurrence key. */
function skipDayTwo(ctx: ScenarioContext, reading: Reading): ScenarioCheck[] {
  const eventId = ctx.execute<{ event_id: string }>("schedule.propose_event", {
    summary: `Standup (${reading.name})`,
    dtstart: reading.dtstart,
    dtend: reading.dtend,
    calendar_id: calendarId(ctx),
    recurrence_semantics: reading.semantics,
    rrule: RRULE,
    ...(reading.tz === undefined ? {} : { start_tz: reading.tz }),
  }).event_id;
  const expanded = expandRecurrence({
    rrule: RRULE,
    start: reading.dtstart,
    rangeFrom: reading.dtstart,
    rangeTo: "2026-05-01T00:00:00.000Z",
    ...(reading.tz === undefined ? {} : { timeZone: reading.tz }),
    semantics: reading.semantics,
  });
  // The KEY, not the instant: for a zoned series those are two different
  // strings, which is why a UTC-keyed matcher lost every skip (ONT-25).
  const dayTwoKey = expanded[1]!.wallStart;
  ctx.execute("schedule.edit_event_occurrence", {
    event_id: eventId,
    original_start_local: dayTwoKey,
    scope: "occurrence",
    action: "skip",
  });
  const exceptions = occurrenceExceptionsOf(
    ctx.rows<Record<string, unknown>>(
      `SELECT * FROM schedule_recurrence_exception
        WHERE target_type = 'core.event' AND target_id = ?`,
      eventId
    ),
    { seriesType: "core.event", seriesId: eventId }
  );
  const shown = applyRecurrenceExceptions(
    expanded,
    recurrenceExceptionsOf(exceptions)
  );
  return [
    {
      claim: `${reading.name}: the exception is stored on the series' own wall clock`,
      actual: exceptions.map((exception) => exception.key.localStart),
      expected: [dayTwoKey],
    },
    {
      claim: `${reading.name}: day two is gone and the other three are not`,
      actual: shown.map((instance) => instance.wallStart),
      expected: [
        expanded[0]!.wallStart,
        expanded[2]!.wallStart,
        expanded[3]!.wallStart,
      ],
    },
  ];
}

function personTask(ctx: ScenarioContext): {
  partyId: string;
  taskId: string;
} {
  const partyId = ctx.execute<{ party_id: string }>("people.add_person", {
    display_name: "Mum",
    cadence_days: 30,
  }).party_id;
  const taskId = ctx.execute<{ task_id: string }>("people.add_task", {
    party_id: partyId,
    text: "Call Mum",
  }).task_id;
  return { partyId, taskId };
}

function statusOf(
  ctx: ScenarioContext,
  taskId: string
): { status: string; completed_at: string | null; series_id: string | null } {
  return ctx.row<{
    status: string;
    completed_at: string | null;
    series_id: string | null;
  }>(
    "SELECT status, completed_at, series_id FROM schedule_task WHERE task_id = ?",
    taskId
  )!;
}

export const BEHAVIOUR_SCENARIOS: readonly ScenarioDefinition[] = [
  {
    id: "ONT-25/one-occurrence-key",
    drift: "ONT-25",
    title:
      "create, skip day two, query — under five readings of one wall clock",
    surfaces: ["Agenda (web) — upcoming", "Agenda (phone) — the day list"],
    run(ctx): ScenarioCheck[] {
      return READINGS.flatMap((reading) => skipDayTwo(ctx, reading));
    },
  },
  {
    id: "ONT-27/one-completion",
    drift: "ONT-27",
    title: "completing from People and then from Tasks is one completion",
    surfaces: ["People — the person's tasks", "Tasks — the list"],
    run(ctx): ScenarioCheck[] {
      const { taskId } = personTask(ctx);
      const before = statusOf(ctx, taskId);
      ctx.execute("people.complete_task", { task_id: taskId });
      const afterPeople = statusOf(ctx, taskId);
      ctx.clock.advance(60_000);
      // The toggle this replaced would have REOPENED it here, because its
      // answer depended on a state the caller never read (ONT-27).
      ctx.execute("schedule.set_task_status", {
        task_id: taskId,
        status: "completed",
      });
      const afterTasks = statusOf(ctx, taskId);
      ctx.execute("people.reopen_task", { task_id: taskId });
      const reopened = statusOf(ctx, taskId);
      return [
        {
          claim: "the task starts open",
          actual: before.status,
          expected: "needs-action",
        },
        {
          claim: "completing twice, from two apps, is one completion",
          actual: [afterTasks.status, afterTasks.completed_at],
          expected: ["completed", afterPeople.completed_at],
        },
        {
          claim: "reopening is not completing",
          actual: [reopened.status, reopened.completed_at],
          expected: ["needs-action", null],
        },
      ];
    },
  },
  {
    id: "ONT-27/the-successor-is-still-about-the-person",
    drift: "ONT-27",
    title: "a recurring person task rolls over once, and keeps its links",
    surfaces: ["People — the person's tasks", "Tasks — the recurring series"],
    run(ctx): ScenarioCheck[] {
      const { partyId, taskId } = personTask(ctx);
      ctx.execute("schedule.edit_task", {
        task_id: taskId,
        due_at: "2026-03-02T09:00:00.000Z",
        rrule: "FREQ=WEEKLY",
      });
      const first = ctx.execute<{
        next_task_id?: string;
        series_id: string | null;
      }>("people.complete_task", { task_id: taskId });
      const nextTaskId = first.next_task_id!;
      // ONE roll-over: completing again from the other app spawns nothing.
      const second = ctx.execute<{ next_task_id?: string }>(
        "schedule.set_task_status",
        { task_id: taskId, status: "completed" }
      );
      // The series' OWN open occurrences: other scenarios share this vault.
      const open = ctx.row<{ n: number }>(
        `SELECT count(*) AS n FROM schedule_task
          WHERE status = 'needs-action' AND series_id = ?`,
        taskId
      )!;
      const about = ctx.row<{ n: number }>(
        `SELECT count(*) AS n FROM core_link
          WHERE from_type = 'schedule.task' AND from_id = ?
            AND to_type = 'core.party' AND to_id = ? AND valid_to IS NULL`,
        nextTaskId,
        partyId
      )!;
      return [
        {
          claim: "the repeating task spawns exactly one successor",
          actual: [typeof nextTaskId, second.next_task_id, open.n],
          expected: ["string", undefined, 1],
        },
        {
          claim: "both occurrences carry the head's series identity",
          actual: [
            statusOf(ctx, taskId).series_id,
            statusOf(ctx, nextTaskId).series_id,
          ],
          expected: [taskId, taskId],
        },
        {
          claim: "the successor is still about Mum",
          actual: about.n,
          expected: 1,
        },
      ];
    },
  },
  {
    id: "ONT-26/one-invariant-boundary",
    drift: "ONT-26",
    title:
      "the same impossible task, refused by the command and by the row editor",
    surfaces: ["Tasks — the editor", "Atlas — the row editor"],
    run(ctx): ScenarioCheck[] {
      const taskId = ctx.execute<{ task_id: string }>("schedule.add_task", {
        title: "Buy milk",
      }).task_id;
      const selfParentByCommand = ctx.invoke("schedule.edit_task", {
        task_id: taskId,
        parent_task_id: taskId,
      });
      const selfParentByAtlas = ctx.invoke("atlas.update_row", {
        table: "schedule.task",
        id: taskId,
        set: { parent_task_id: taskId },
      });
      const bananaByCommand = ctx.invoke("schedule.add_task", {
        title: "Nonsense",
        due_at: "banana",
      });
      const bananaByAtlas = ctx.invoke("atlas.update_row", {
        table: "schedule.task",
        id: taskId,
        set: { due_at: "banana" },
      });
      const impossibleDay = ctx.invoke("schedule.add_task", {
        title: "February 31",
        due_at: "2026-02-31T09:00:00.000Z",
      });
      const reason = (outcome: InvokeOutcome): string =>
        (outcome as { reason?: string }).reason ?? "";
      return [
        {
          claim: "a task may not be its own parent, by either door",
          actual: [selfParentByCommand.status, selfParentByAtlas.status],
          expected: ["failed", "failed"],
        },
        {
          claim:
            "`due_at: banana` is refused by either door, with one sentence",
          actual: [
            bananaByCommand.status,
            bananaByAtlas.status,
            reason(bananaByCommand) === reason(bananaByAtlas),
          ],
          expected: ["failed", "failed", true],
        },
        {
          claim: "February 31 is not a day",
          actual: impossibleDay.status,
          expected: "failed",
        },
      ];
    },
  },
];
