import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";

const SCHEDULE_KEY = "centraid:daily-brief-notification:v1";

export function nextBriefNotificationAt(now = new Date()): Date {
  const next = new Date(now);
  next.setHours(7, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

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
      // Intentionally empty.
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
