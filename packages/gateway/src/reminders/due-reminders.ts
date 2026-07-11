// Reminders (the gap flagged in the Tasks/Agenda comparison: neither app had
// any time-based alert). Deliberately stateless on the gateway side — no
// "already fired" bookkeeping here, no resident timer. Each call is a pure
// read of the vault's own `remind_before_min` (schedule_task) and
// `reminders_json` (schedule_event_ext) columns against `now`, returning
// every reminder whose fire time has arrived and hasn't gone stale. The
// caller (the desktop main process's poller) owns de-duplication — it
// remembers which `key`s it already surfaced an OS notification for, the
// same posture as gateway-monitor.ts's in-memory downtime-alert state.

import type { VaultDb } from '@centraid/vault';

export interface DueReminder {
  /** Stable per-reminder id: de-dup key for the poller. */
  key: string;
  kind: 'task' | 'event';
  id: string;
  title: string;
  /** ISO instant the reminder is anchored to (due_at or dtstart). */
  at: string;
  /** Minutes before `at` this reminder was set to fire. */
  minutesBefore: number;
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
        typeof r === 'object' &&
        r !== null &&
        typeof (r as { minutes_before?: unknown }).minutes_before === 'number',
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
): DueReminder[] {
  const now = Date.parse(nowIso);
  const out: DueReminder[] = [];

  const taskRows = db.vault
    .prepare(
      `SELECT task_id, title, due_at, remind_before_min FROM schedule_task
        WHERE status IN ('needs-action','in-process')
          AND due_at IS NOT NULL AND remind_before_min IS NOT NULL`,
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
        kind: 'task',
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
        WHERE e.status != 'cancelled' AND x.reminders_json IS NOT NULL`,
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
          kind: 'event',
          id: e.event_id,
          title: e.summary,
          at: e.dtstart,
          minutesBefore: r.minutes_before,
        });
      }
    }
  }

  return out.sort((a, b) => a.at.localeCompare(b.at));
}
