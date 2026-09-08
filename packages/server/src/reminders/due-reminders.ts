// Reminders. Deliberately stateless on the gateway side — no
// "already fired" bookkeeping here, no resident timer. Each call is a pure
// read of the vault's own `remind_before_min` (schedule_task) and
// `reminders_json` (schedule_event_ext) columns against `now`, returning
// every reminder whose fire time has arrived and hasn't gone stale. The
// caller (the desktop main process's poller) owns de-duplication — it
// remembers which `key`s it already surfaced an OS notification for, the
// same posture as gateway-monitor.ts's in-memory downtime-alert state.
//
// Tally recurring materialization previews and outstanding household pairing
// tickets ride the same feed so mobile categories for those kinds can fire.

import { expandRecurrence, inspectRrule } from "@centraid/core/time";
import type { RecurrenceSemantics } from "@centraid/core/time";
import type { Credential, ReadRequest, ReadResult } from "@centraid/vault";

/*
 * THROUGH THE GATEWAY (#916, review-A 8.1). Reminders are life data, so every
 * read below is a `gateway.read` on the owner's own credential — resolved,
 * receipt written — and never SQL against a physical table. The one join the
 * old query did (`core_event` × `schedule_event_ext`) is folded here over two
 * windowed reads; `bun run lint:vault-sql` is what keeps it that way.
 */

/** The gateway surface the reminder feed needs — the whole of it. */
export interface ReminderVaultReader {
  read: (cred: Credential, request: ReadRequest) => ReadResult;
}

function rowsOf<T>(result: ReadResult): T[] {
  return (result.rows ?? []) as unknown as T[];
}

interface EventExtRow {
  event_id: string;
  reminders_json: string;
}

interface EventCoreRow {
  event_id: string;
  summary: string;
  dtstart: string;
  rrule: string | null;
  start_tz: string | null;
  recurrence_semantics: string | null;
}

/** The live reminder-bearing events, one read per table, joined here. */
function reminderEvents(
  vault: ReminderVaultReader,
  cred: Credential
): EventReminderRow[] {
  const read = (request: ReadRequest): ReadResult => vault.read(cred, request);
  const exts = rowsOf<EventExtRow>(
    read({
      entity: "schedule.event_ext",
      where: [{ column: "reminders_json", op: "not-null" }],
    })
  );
  if (exts.length === 0) return [];
  const remindersByEvent = new Map(
    exts.map((ext) => [ext.event_id, ext.reminders_json] as const)
  );
  // Trash is invisible, not merely un-listed (#916, review-A 8.2).
  return rowsOf<EventCoreRow>(
    read({
      entity: "core.event",
      where: [
        { column: "event_id", op: "in", value: [...remindersByEvent.keys()] },
        { column: "status", op: "ne", value: "cancelled" },
        { column: "deleted_at", op: "is-null" },
      ],
    })
  ).flatMap((event) => {
    const remindersJson = remindersByEvent.get(event.event_id);
    return remindersJson === undefined ? [] : [{ ...event, remindersJson }];
  });
}

/** The live, reminder-bearing tasks. */
function reminderTasks(
  vault: ReminderVaultReader,
  cred: Credential
): TaskReminderRow[] {
  return rowsOf<TaskReminderRow>(
    vault.read(cred, {
      entity: "schedule.task",
      where: [
        { column: "status", op: "in", value: ["needs-action", "in-process"] },
        { column: "deleted_at", op: "is-null" },
        { column: "due_at", op: "not-null" },
        { column: "remind_before_min", op: "not-null" },
      ],
    })
  );
}

export interface DueReminder {
  /** Stable per-reminder id: de-dup key for the poller. */
  key: string;
  kind: "task" | "event" | "tally" | "invite";
  id: string;
  title: string;
  /** ISO instant the reminder is anchored to (due_at or dtstart). */
  at: string;
  /** Minutes before `at` this reminder was set to fire. */
  minutesBefore: number;
}

export interface PendingInvitation {
  ticketId: string;
  ownerLabel: string;
  createdAt: string;
  expiresAt: number;
}

/** A reminder older than this (past its `at`) is stale — no longer surfaced. */
const DEFAULT_STALE_AFTER_MINUTES = 24 * 60;

interface TaskReminderRow {
  task_id: string;
  title: string;
  due_at: string;
  remind_before_min: number;
}

interface EventReminderRow {
  event_id: string;
  summary: string;
  dtstart: string;
  rrule: string | null;
  start_tz: string | null;
  recurrence_semantics: string | null;
  remindersJson: string;
}

function occurrenceStarts(
  event: EventReminderRow,
  rangeFrom: string,
  rangeTo: string
): { at: string; originalStart: string }[] {
  if (!event.rrule) {
    return [{ at: event.dtstart, originalStart: event.dtstart }];
  }
  // A refused rule names no occurrence; the fallback below would misfire.
  if (!inspectRrule(event.rrule).ok) return [];
  const semantics = (event.recurrence_semantics ??
    "zoned") as RecurrenceSemantics;
  const instances = expandRecurrence({
    rrule: event.rrule,
    start: event.dtstart,
    rangeFrom,
    rangeTo,
    timeZone: event.start_tz ?? "Etc/UTC",
    semantics,
    maxInstances: 32,
  });
  if (instances.length === 0) {
    return [{ at: event.dtstart, originalStart: event.dtstart }];
  }
  return instances.map((instance) => ({
    at: instance.start,
    originalStart: instance.originalStart,
  }));
}

function instantMs(value: string): number {
  return Date.parse(value.includes("T") ? value : `${value}T00:00:00.000Z`);
}

function parseReminders(json: string): { minutes_before: number }[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is { minutes_before: number } =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as { minutes_before?: unknown }).minutes_before === "number"
    );
  } catch {
    return [];
  }
}

/**
 * The reminder-bearing rows one scan works from. Read ONCE per scan: since
 * #916 every read here is a `gateway.read`, and a gateway read appends a
 * receipt — so a re-read is not a free SELECT, it is another durable row.
 */
interface ReminderSources {
  tasks: TaskReminderRow[];
  events: EventReminderRow[];
}

function readReminderSources(
  vault: ReminderVaultReader,
  cred: Credential
): ReminderSources {
  // Trash is invisible, not merely un-listed (#916, review-A 8.2): every read
  // here clamps `deleted_at IS NULL`, or a task the owner threw away keeps
  // ringing until its purge lapses.
  return {
    tasks: reminderTasks(vault, cred),
    events: reminderEvents(vault, cred),
  };
}

/**
 * Every task/event reminder whose fire time (`at` minus `minutesBefore`) has
 * arrived by `nowIso`, and hasn't gone stale (more than `staleAfterMinutes`
 * past its own `at`). Pure given `nowIso` — no wall-clock reads — so it's
 * directly unit-testable.
 */
export function computeDueReminders(
  vault: ReminderVaultReader,
  cred: Credential,
  nowIso: string,
  staleAfterMinutes = DEFAULT_STALE_AFTER_MINUTES,
  pendingInvitations: readonly PendingInvitation[] = []
): DueReminder[] {
  return dueFrom(
    readReminderSources(vault, cred),
    vault,
    cred,
    nowIso,
    staleAfterMinutes,
    pendingInvitations
  );
}

function dueFrom(
  sources: ReminderSources,
  vault: ReminderVaultReader,
  cred: Credential,
  nowIso: string,
  staleAfterMinutes: number,
  pendingInvitations: readonly PendingInvitation[]
): DueReminder[] {
  const now = Date.parse(nowIso);
  const out: DueReminder[] = [];

  const taskRows = sources.tasks;
  for (const t of taskRows) {
    const dueMs = Date.parse(t.due_at);
    if (Number.isNaN(dueMs)) continue;
    const fireAt = dueMs - t.remind_before_min * 60_000;
    const staleAt = dueMs + staleAfterMinutes * 60_000;
    if (fireAt <= now && now <= staleAt) {
      out.push({
        key: `task:${t.task_id}:${t.remind_before_min}`,
        kind: "task",
        id: t.task_id,
        title: t.title,
        at: t.due_at,
        minutesBefore: t.remind_before_min,
      });
    }
  }

  const eventRows = sources.events;
  for (const e of eventRows) {
    const leads = parseReminders(e.remindersJson);
    if (leads.length === 0) continue;
    const maxLead = Math.max(...leads.map((lead) => lead.minutes_before));
    const rangeFrom = new Date(now - staleAfterMinutes * 60_000).toISOString();
    const rangeTo = new Date(now + (maxLead + 1) * 60_000).toISOString();
    for (const occurrence of occurrenceStarts(e, rangeFrom, rangeTo)) {
      const startMs = instantMs(occurrence.at);
      if (Number.isNaN(startMs)) continue;
      const staleAt = startMs + staleAfterMinutes * 60_000;
      for (const r of leads) {
        const fireAt = startMs - r.minutes_before * 60_000;
        if (fireAt <= now && now <= staleAt) {
          out.push({
            key: e.rrule
              ? `event:${e.event_id}:${occurrence.originalStart}:${r.minutes_before}`
              : `event:${e.event_id}:${r.minutes_before}`,
            kind: "event",
            id: e.event_id,
            title: e.summary,
            at: occurrence.at,
            minutesBefore: r.minutes_before,
          });
        }
      }
    }
  }

  // Active recurring expense templates whose next occurrence is due (and not
  // yet materialized) surface as Tally settle/review notifications.
  const day = nowIso.slice(0, 10);
  const rangeFrom = `${day}T00:00:00.000Z`;
  const rangeTo = new Date(Date.parse(rangeFrom) + 86_400_000).toISOString();
  const templates = rowsOf<{
    template_id: string;
    description: string;
    rrule: string;
    anchor_start: string;
    tz: string;
    last_materialized_start: string | null;
  }>(
    vault.read(cred, {
      entity: "tally.recurring_expense",
      where: [{ column: "status", op: "eq", value: "active" }],
    })
  );
  for (const template of templates) {
    const next = expandRecurrence({
      rrule: template.rrule,
      start: template.anchor_start,
      rangeFrom,
      rangeTo,
      timeZone: template.tz,
      maxInstances: 2,
    })[0];
    if (!next) continue;
    if (
      template.last_materialized_start !== null &&
      template.last_materialized_start >= next.originalStart
    ) {
      continue;
    }
    const spentOn = next.start.slice(0, 10);
    const already = rowsOf<{ expense_id: string }>(
      vault.read(cred, {
        entity: "tally.expense",
        where: [
          {
            column: "recurring_template_id",
            op: "eq",
            value: template.template_id,
          },
          { column: "spent_on", op: "eq", value: spentOn },
          { column: "deleted_at", op: "is-null" },
        ],
        limit: 1,
      })
    );
    if (already.length > 0) continue;
    const at = next.start.includes("T")
      ? next.start.endsWith("Z") || /[+-]\d{2}:\d{2}$/u.test(next.start)
        ? next.start
        : `${next.start}Z`
      : `${next.start}T09:00:00.000Z`;
    const atMs = Date.parse(at);
    if (Number.isNaN(atMs)) continue;
    const staleAt = atMs + staleAfterMinutes * 60_000;
    if (atMs <= now && now <= staleAt) {
      out.push({
        key: `tally:${template.template_id}:${next.originalStart}`,
        kind: "tally",
        id: template.template_id,
        title: template.description,
        at,
        minutesBefore: 0,
      });
    }
  }

  for (const invite of pendingInvitations) {
    if (invite.expiresAt <= now) continue;
    out.push({
      key: `invite:${invite.ticketId}`,
      kind: "invite",
      id: invite.ticketId,
      title: invite.ownerLabel
        ? `Invite for ${invite.ownerLabel}`
        : "Pairing invitation",
      at: invite.createdAt,
      minutesBefore: 0,
    });
  }

  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Earliest future fire instant, used by the gateway's durable wake scheduler. */
export function nextReminderFireAt(
  vault: ReminderVaultReader,
  cred: Credential,
  nowIso: string
): string | undefined {
  return nextFireFrom(readReminderSources(vault, cred), nowIso);
}

/**
 * One scan, both answers (#916). The push relay needs what is due NOW and when
 * to wake NEXT, at the same instant; asking for them separately re-read
 * `schedule.task` and `schedule.event_ext` a second time with the same `now` —
 * duplicate work on base, and since #916 two extra receipt commits per idle
 * tick on top of it. The two answers now come off one read of the sources, so
 * they can also never disagree about what the vault held.
 */
export function scanReminders(
  vault: ReminderVaultReader,
  cred: Credential,
  nowIso: string,
  staleAfterMinutes = DEFAULT_STALE_AFTER_MINUTES,
  pendingInvitations: readonly PendingInvitation[] = []
): { due: DueReminder[]; nextFireAt: string | undefined } {
  const sources = readReminderSources(vault, cred);
  return {
    due: dueFrom(
      sources,
      vault,
      cred,
      nowIso,
      staleAfterMinutes,
      pendingInvitations
    ),
    nextFireAt: nextFireFrom(sources, nowIso),
  };
}

function nextFireFrom(
  sources: ReminderSources,
  nowIso: string
): string | undefined {
  const now = Date.parse(nowIso);
  let next = Number.POSITIVE_INFINITY;
  for (const task of sources.tasks) {
    const fireAt = Date.parse(task.due_at) - task.remind_before_min * 60_000;
    if (Number.isFinite(fireAt) && fireAt > now && fireAt < next) next = fireAt;
  }
  for (const event of sources.events) {
    const leads = parseReminders(event.remindersJson);
    if (leads.length === 0) continue;
    const rangeTo = new Date(now + 120 * 86_400_000).toISOString();
    for (const occurrence of occurrenceStarts(event, nowIso, rangeTo)) {
      const start = instantMs(occurrence.at);
      if (!Number.isFinite(start)) continue;
      for (const reminder of leads) {
        const fireAt = start - reminder.minutes_before * 60_000;
        if (fireAt > now && fireAt < next) next = fireAt;
      }
    }
  }
  return Number.isFinite(next) ? new Date(next).toISOString() : undefined;
}
