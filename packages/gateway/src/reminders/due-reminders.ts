// Reminders (the gap flagged in the Tasks/Agenda comparison: neither app had
// any time-based alert). Deliberately stateless on the gateway side — no
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

import { expandRecurrence } from "@centraid/time-engine";
import type { VaultDb } from "@centraid/vault";

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
  reminders_json: string;
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
 * Every task/event reminder whose fire time (`at` minus `minutesBefore`) has
 * arrived by `nowIso`, and hasn't gone stale (more than `staleAfterMinutes`
 * past its own `at`). Pure given `nowIso` — no wall-clock reads — so it's
 * directly unit-testable.
 */
export function computeDueReminders(
  db: VaultDb,
  nowIso: string,
  staleAfterMinutes = DEFAULT_STALE_AFTER_MINUTES,
  pendingInvitations: readonly PendingInvitation[] = []
): DueReminder[] {
  const now = Date.parse(nowIso);
  const out: DueReminder[] = [];

  const taskRows = db.vault
    .prepare(
      `SELECT task_id, title, due_at, remind_before_min FROM schedule_task
        WHERE status IN ('needs-action','in-process')
          AND due_at IS NOT NULL AND remind_before_min IS NOT NULL`
    )
    .all() as unknown as TaskReminderRow[];
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

  const eventRows = db.vault
    .prepare(
      `SELECT e.event_id AS event_id, e.summary AS summary, e.dtstart AS dtstart, x.reminders_json AS reminders_json
         FROM core_event e JOIN schedule_event_ext x ON x.event_id = e.event_id
        WHERE e.status != 'cancelled' AND x.reminders_json IS NOT NULL`
    )
    .all() as unknown as EventReminderRow[];
  for (const e of eventRows) {
    const startMs = Date.parse(e.dtstart);
    if (Number.isNaN(startMs)) continue;
    const staleAt = startMs + staleAfterMinutes * 60_000;
    for (const r of parseReminders(e.reminders_json)) {
      const fireAt = startMs - r.minutes_before * 60_000;
      if (fireAt <= now && now <= staleAt) {
        out.push({
          key: `event:${e.event_id}:${r.minutes_before}`,
          kind: "event",
          id: e.event_id,
          title: e.summary,
          at: e.dtstart,
          minutesBefore: r.minutes_before,
        });
      }
    }
  }

  // Active recurring expense templates whose next occurrence is due (and not
  // yet materialized) surface as Tally settle/review notifications.
  const day = nowIso.slice(0, 10);
  const rangeFrom = `${day}T00:00:00.000Z`;
  const rangeTo = new Date(Date.parse(rangeFrom) + 86_400_000).toISOString();
  const templates = db.vault
    .prepare(
      `SELECT template_id, description, rrule, anchor_start, time_zone,
              last_materialized_start
         FROM tally_recurring_expense
        WHERE status = 'active'`
    )
    .all() as Array<{
    template_id: string;
    description: string;
    rrule: string;
    anchor_start: string;
    time_zone: string;
    last_materialized_start: string | null;
  }>;
  for (const template of templates) {
    const next = expandRecurrence({
      rrule: template.rrule,
      start: template.anchor_start,
      rangeFrom,
      rangeTo,
      timeZone: template.time_zone,
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
    const already = db.vault
      .prepare(
        `SELECT 1 AS n FROM tally_expense
          WHERE recurring_template_id = ? AND spent_on = ? AND deleted_at IS NULL`
      )
      .get(template.template_id, spentOn);
    if (already) continue;
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
  db: VaultDb,
  nowIso: string
): string | undefined {
  const now = Date.parse(nowIso);
  let next = Number.POSITIVE_INFINITY;
  const taskRows = db.vault
    .prepare(
      `SELECT task_id, title, due_at, remind_before_min FROM schedule_task
        WHERE status IN ('needs-action','in-process')
          AND due_at IS NOT NULL AND remind_before_min IS NOT NULL`
    )
    .all() as unknown as TaskReminderRow[];
  for (const task of taskRows) {
    const fireAt = Date.parse(task.due_at) - task.remind_before_min * 60_000;
    if (Number.isFinite(fireAt) && fireAt > now && fireAt < next) next = fireAt;
  }
  const eventRows = db.vault
    .prepare(
      `SELECT e.event_id AS event_id, e.summary AS summary,
              e.dtstart AS dtstart, x.reminders_json AS reminders_json
         FROM core_event e JOIN schedule_event_ext x ON x.event_id = e.event_id
        WHERE e.status != 'cancelled' AND x.reminders_json IS NOT NULL`
    )
    .all() as unknown as EventReminderRow[];
  for (const event of eventRows) {
    const start = Date.parse(event.dtstart);
    if (!Number.isFinite(start)) continue;
    for (const reminder of parseReminders(event.reminders_json)) {
      const fireAt = start - reminder.minutes_before * 60_000;
      if (fireAt > now && fireAt < next) next = fireAt;
    }
  }
  return Number.isFinite(next) ? new Date(next).toISOString() : undefined;
}
