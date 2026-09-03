import { Notification } from "electron";

import { loadSettings } from "./settings.js";

export const REMINDER_POLL_MS = 30_000;
const PROBE_TIMEOUT_MS = 8000;
const SEEN_TTL_MS = 48 * 60 * 60 * 1000;

interface DueReminder {
  key: string;
  kind: "task" | "event" | "tally" | "invite";
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
  if (minutesBefore === 0) return "now";
  if (minutesBefore < 60) return `${minutesBefore}m`;
  if (minutesBefore % 1440 === 0) return `${minutesBefore / 1440}d`;
  if (minutesBefore % 60 === 0) return `${minutesBefore / 60}h`;
  return `${minutesBefore}m`;
}

function notify(reminder: DueReminder): void {
  if (!Notification.isSupported()) return;
  const noun =
    reminder.kind === "task"
      ? "Task due"
      : reminder.kind === "event"
        ? "Event starting"
        : reminder.kind === "tally"
          ? "Expense ready to review"
          : "Household invitation";
  const body =
    reminder.kind === "task" || reminder.kind === "event"
      ? `${noun} — reminder set ${leadLabel(reminder.minutesBefore)} before.`
      : noun;
  const n = new Notification({
    title: reminder.title,
    body,
  });
  n.show();
}

async function fetchDueReminders(
  baseUrl: string,
  token: string | undefined
): Promise<DueReminder[]> {
  const res = await fetch(
    new URL("/centraid/_reminders/due", `${baseUrl}/`).toString(),
    {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }
  );
  if (!res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as {
    reminders?: DueReminder[];
  };
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
      .catch((error) => {
        process.stdout.write(
          `[reminder-monitor] tick failed: ${String(error)}\n`
        );
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}

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
