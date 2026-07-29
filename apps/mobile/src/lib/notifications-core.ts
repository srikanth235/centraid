import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";

import { authHeader } from "./gateway";
import * as NotificationModel from "./notification-model";
import type { DueReminder } from "./notification-model";

const DELIVERED_KEYS = "centraid:delivered-reminder-keys:v1";

export async function installNotificationCategories(): Promise<void> {
  await Promise.all([
    Notifications.setNotificationCategoryAsync(
      NotificationModel.TASK_CATEGORY,
      [
        {
          identifier: NotificationModel.COMPLETE_TASK,
          buttonTitle: "Complete",
          options: { opensAppToForeground: false },
        },
        {
          identifier: NotificationModel.SNOOZE_TASK,
          buttonTitle: "Snooze 10m",
          options: { opensAppToForeground: false },
        },
        {
          identifier: NotificationModel.OPEN_ITEM,
          buttonTitle: "Open",
          options: { opensAppToForeground: true },
        },
      ]
    ),
    Notifications.setNotificationCategoryAsync(
      NotificationModel.EVENT_CATEGORY,
      [
        {
          identifier: NotificationModel.OPEN_ITEM,
          buttonTitle: "Open event",
          options: { opensAppToForeground: true },
        },
      ]
    ),
    Notifications.setNotificationCategoryAsync(
      NotificationModel.TALLY_CATEGORY,
      [
        {
          identifier: NotificationModel.SETTLE_BALANCE,
          buttonTitle: "Settle",
          options: { opensAppToForeground: true },
        },
        {
          identifier: NotificationModel.OPEN_ITEM,
          buttonTitle: "Open",
          options: { opensAppToForeground: true },
        },
      ]
    ),
    Notifications.setNotificationCategoryAsync(
      NotificationModel.INVITE_CATEGORY,
      [
        {
          identifier: NotificationModel.OPEN_ITEM,
          buttonTitle: "Review invite",
          options: { opensAppToForeground: true },
        },
      ]
    ),
  ]);
}

/**
 * After a content-free remote wake, pull due rows over the authenticated local
 * channel and schedule content-bearing OS notifications on the device.
 */
export async function syncDueNotifications(
  baseUrl: string,
  vaultId: string
): Promise<void> {
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;
  const response = await fetch(new URL("/centraid/_reminders/due", baseUrl), {
    headers: { ...authHeader(), "x-centraid-vault": vaultId },
  });
  if (!response.ok) return;
  const body = (await response.json()) as { reminders?: DueReminder[] };
  const raw = await AsyncStorage.getItem(DELIVERED_KEYS).catch(() => null);
  let deliveredValues: string[] = [];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed))
        deliveredValues = parsed.filter(
          (value): value is string => typeof value === "string"
        );
    } catch {
      // Delivery bookkeeping is a bounded cache; due state is canonical.
    }
  }
  const delivered = new Set(deliveredValues);
  const pending = (body.reminders ?? []).filter(
    (reminder) => !delivered.has(reminder.key)
  );
  await Promise.all(
    pending.map((reminder) =>
      Notifications.scheduleNotificationAsync({
        content: NotificationModel.notificationContent(reminder),
        trigger: null,
      })
    )
  );
  for (const reminder of pending) delivered.add(reminder.key);
  // Bound device bookkeeping; stale duplicates after a very long horizon are
  // harmless because completed/cancelled rows no longer appear as due.
  await AsyncStorage.setItem(
    DELIVERED_KEYS,
    JSON.stringify([...delivered].slice(-2_000))
  ).catch(() => undefined);
}
