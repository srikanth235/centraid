/*
 * Task/event reminder monitor (main process).
 *
 * Neither Tasks nor Agenda had any time-based alert — a `remind_before_min`
 * or `reminders_json` field the owner set was silently inert. This module
 * closes that gap the same way gateway-monitor.ts already closes the
 * downtime-alert gap: poll a cheap gateway route, fire an OS notification
 * on what's new. The gateway's `/centraid/_reminders/due` is deliberately
 * stateless (recomputed live from `remind_before_min`/`reminders_json` each
 * call — see packages/gateway/src/reminders/due-reminders.ts); THIS module
 * owns "have I already notified for this one" — an in-memory, per-launch
 * Set of reminder keys, pruned so a long-running process doesn't grow it
 * forever.
 *
 * Lives in main, not the renderer, so reminders still fire while the window
 * is backgrounded or on another screen.
 */

import { Notification } from 'electron';
import { loadSettings } from './settings.js';

export const REMINDER_POLL_MS = 30_000;
const PROBE_TIMEOUT_MS = 8000;
/** Notified keys older than this are forgotten — bounds memory, not a re-fire risk (the gateway itself stops surfacing a reminder once it goes stale). */
const SEEN_TTL_MS = 48 * 60 * 60 * 1000;

interface DueReminder {
  key: string;
  kind: 'task' | 'event';
  id: string;
  title: string;
  at: string;
  minutesBefore: number;
}

let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<void> | undefined;
const seenAt = new Map<string, number>();

function pruneSeen(now: number): void {
  for (const [key, at] of seenAt) {
    if (now - at > SEEN_TTL_MS) seenAt.delete(key);
  }
}

function leadLabel(minutesBefore: number): string {
  if (minutesBefore === 0) return 'now';
  if (minutesBefore < 60) return `${minutesBefore}m`;
  if (minutesBefore % 1440 === 0) return `${minutesBefore / 1440}d`;
  if (minutesBefore % 60 === 0) return `${minutesBefore / 60}h`;
  return `${minutesBefore}m`;
}

function notify(reminder: DueReminder): void {
  if (!Notification.isSupported()) return;
  const noun = reminder.kind === 'task' ? 'Task due' : 'Event starting';
  const n = new Notification({
    title: reminder.title,
    body: `${noun} — reminder set ${leadLabel(reminder.minutesBefore)} before.`,
  });
  n.show();
}

async function fetchDueReminders(
  baseUrl: string,
  token: string | undefined,
): Promise<DueReminder[]> {
  const res = await fetch(new URL('/centraid/_reminders/due', `${baseUrl}/`).toString(), {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as { reminders?: DueReminder[] };
  return Array.isArray(body.reminders) ? body.reminders : [];
}

async function tick(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.gatewayUrl) return;
  const now = Date.now();
  pruneSeen(now);
  let due: DueReminder[];
  try {
    due = await fetchDueReminders(settings.gatewayUrl, settings.gatewayToken);
  } catch {
    // A probe failure here is silent — gateway-monitor.ts already owns
    // surfacing "the gateway is unreachable" to the owner.
    return;
  }
  for (const reminder of due) {
    if (seenAt.has(reminder.key)) continue;
    seenAt.set(reminder.key, now);
    notify(reminder);
  }
}

function runTick(): Promise<void> {
  if (!inFlight) {
    inFlight = tick()
      .catch((err) => {
        process.stdout.write(`[reminder-monitor] tick failed: ${String(err)}\n`);
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}

/** Start the reminder poller. Called once from main.ts after app ready. */
export function startReminderMonitor(): void {
  if (timer) return;
  timer = setInterval(() => void runTick(), REMINDER_POLL_MS);
  timer.unref?.();
  void runTick();
}

export function stopReminderMonitor(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
  seenAt.clear();
}
