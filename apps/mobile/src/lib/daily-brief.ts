import { ROUTES } from "@centraid/protocol";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";

import { authHeader, fetchJson, requireGatewayBase } from "./gateway";

export interface DailyBrief {
  date: string;
  events: Array<{ id: string; title: string; at: string }>;
  tasks: Array<{ id: string; title: string; dueAt: string }>;
  newPhotos: number;
  balanceMinor: number;
  currency: string;
}

const SCHEDULE_KEY = "centraid:daily-brief-notification:v1";

function localDayRange(now = new Date()): {
  date: string;
  from: string;
  to: string;
  timeZone: string;
} {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return {
    date: [
      start.getFullYear(),
      String(start.getMonth() + 1).padStart(2, "0"),
      String(start.getDate()).padStart(2, "0"),
    ].join("-"),
    from: start.toISOString(),
    to: end.toISOString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

export async function fetchDailyBrief(now = new Date()): Promise<DailyBrief> {
  const base = await requireGatewayBase();
  const params = new URLSearchParams(localDayRange(now));
  return fetchJson<DailyBrief>(`${base}${ROUTES.briefToday}?${params}`, {
    headers: authHeader(),
  });
}

export function nextBriefNotificationAt(now = new Date()): Date {
  const next = new Date(now);
  next.setHours(7, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** Keep one content-minimized 07:00 local notification armed, without prompting. */
export async function scheduleDailyBriefNotification(
  now = new Date()
): Promise<void> {
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;
  const next = nextBriefNotificationAt(now);
  const day = next.toISOString().slice(0, 10);
  const raw = await AsyncStorage.getItem(SCHEDULE_KEY).catch(() => null);
  if (raw) {
    try {
      const prior = JSON.parse(raw) as { day?: string };
      if (prior.day === day) return;
    } catch {
      // Replace malformed device bookkeeping below.
    }
  }
  const id = await Notifications.scheduleNotificationAsync({
    content: {
      title: "Your daily brief is ready",
      body: "See today’s events, due tasks, new photos, and household balance.",
      data: { route: "Home", kind: "daily-brief" },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: next,
    },
  });
  await AsyncStorage.setItem(SCHEDULE_KEY, JSON.stringify({ day, id })).catch(
    () => undefined
  );
}
