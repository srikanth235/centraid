import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { AppState } from "react-native";

import { planBirthdayNotifications } from "./birthday-notifications";
import type { BirthdayPerson } from "./birthday-notifications";
import { authHeader } from "./gateway";
import * as NotificationModel from "./notification-model";
import type { DueReminder } from "./notification-model";
import { planNotifications } from "./notifications-plan";
import type { MobileNotificationsPull } from "./notifications-plan";

const DELIVERED_KEYS = "centraid:delivered-reminder-keys:v1";
/** Written when the OS accepts the future-dated trigger, not on banner display (#834). */
const SCHEDULED_BIRTHDAY_KEYS = "centraid:scheduled-birthday-keys:v1";
const DELIVERED_NOTIFICATION_KEYS = "centraid:delivered-notification-keys:v1";
/** A quiet pull seeds an empty ledger; empty must not read as "never seeded". */
const SEEDED_NOTIFICATION_LEDGER =
  "centraid:delivered-notification-keys:seeded:v1";

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
    Notifications.setNotificationCategoryAsync(
      NotificationModel.BIRTHDAY_CATEGORY,
      [
        {
          identifier: NotificationModel.OPEN_ITEM,
          buttonTitle: "Open person",
          options: { opensAppToForeground: true },
        },
      ]
    ),
    Notifications.setNotificationCategoryAsync(
      NotificationModel.NOTIFICATIONS_CATEGORY,
      [
        {
          identifier: NotificationModel.OPEN_ITEM,
          buttonTitle: "Open Notifications",
          options: { opensAppToForeground: true },
        },
      ]
    ),
  ]);
}

/** The OS prompt is the one contextual consent gesture; boot/background paths never prompt. */
export async function requestNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (current.canAskAgain === false) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/** I/O shell — seed/notify and foreground/background decisions live in `planNotifications`; `appState` injected for testability. */
export async function syncNotifications(
  baseUrl: string,
  vaultId: string,
  appState: { currentState: string } = AppState
): Promise<void> {
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;
  const response = await fetch(
    new URL("/centraid/_vault/notifications", baseUrl),
    {
      headers: { ...authHeader(), "x-centraid-vault": vaultId },
    }
  );
  if (!response.ok) return;
  const notifications = (await response.json()) as MobileNotificationsPull;
  const [rawLedger, rawSeeded] = await Promise.all([
    AsyncStorage.getItem(DELIVERED_NOTIFICATION_KEYS).catch(() => null),
    AsyncStorage.getItem(SEEDED_NOTIFICATION_LEDGER).catch(() => null),
  ]);
  let prior: string[] = [];
  if (rawLedger) {
    try {
      const parsed: unknown = JSON.parse(rawLedger);
      if (Array.isArray(parsed))
        prior = parsed.filter(
          (value): value is string => typeof value === "string"
        );
    } catch {
      // Device bookkeeping is disposable; the authenticated pull is truth.
    }
  }
  const plan = planNotifications({
    notifications,
    delivered: prior,
    seeded: rawSeeded === "1",
    appActive: appState.currentState === "active",
  });
  await Promise.all(
    plan.notifications.map((row) =>
      Notifications.scheduleNotificationAsync({
        content: {
          title: row.title,
          body: row.body,
          categoryIdentifier: NotificationModel.NOTIFICATIONS_CATEGORY,
          data: {
            kind: "notifications",
            url: "centraid://settings/notifications",
          },
        },
        trigger: null,
      })
    )
  );
  if (plan.nextDelivered) {
    await AsyncStorage.setItem(
      DELIVERED_NOTIFICATION_KEYS,
      JSON.stringify(plan.nextDelivered)
    ).catch(() => undefined);
  }
  if (plan.seeded)
    await AsyncStorage.setItem(SEEDED_NOTIFICATION_LEDGER, "1").catch(
      () => undefined
    );
}

/**
 * Birthday delivery is the phone's alone. Planning lives entirely in
 * `planBirthdayNotifications` (people come from the agenda replica — nothing
 * here reaches the network); this is the I/O shell. Triggers are future-dated,
 * so the ledger records what has been SCHEDULED and a re-run never doubles a
 * banner (#834).
 */
export async function scheduleBirthdayNotifications(
  people: readonly BirthdayPerson[],
  leadDays?: number
): Promise<number> {
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return 0;
  const raw = await AsyncStorage.getItem(SCHEDULED_BIRTHDAY_KEYS).catch(
    () => null
  );
  let scheduledValues: string[] = [];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed))
        scheduledValues = parsed.filter(
          (value): value is string => typeof value === "string"
        );
    } catch {
      // Device bookkeeping is disposable; the vault's rows are canonical.
    }
  }
  const scheduled = new Set(scheduledValues);
  const plan = planBirthdayNotifications({
    delivered: scheduled,
    now: new Date(),
    people,
    ...(leadDays === undefined ? {} : { leadDays }),
  });
  await Promise.all(
    plan.map((row) =>
      Notifications.scheduleNotificationAsync({
        content: {
          title: row.title,
          body: row.body,
          categoryIdentifier: NotificationModel.BIRTHDAY_CATEGORY,
          data: { kind: "birthday", partyId: row.partyId, url: row.url },
        },
        trigger: { type: "date", date: row.at } as never,
      })
    )
  );
  for (const row of plan) scheduled.add(row.key);
  // A key names one person-year, so the oldest entries are birthdays long past.
  await AsyncStorage.setItem(
    SCHEDULED_BIRTHDAY_KEYS,
    JSON.stringify([...scheduled].slice(-2_000))
  ).catch(() => undefined);
  return plan.length;
}

/** After a content-free wake, pull due rows over the authenticated channel and schedule OS notifications. */
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
      // Bounded cache; due state is canonical.
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
  // Stale duplicates after a long horizon are harmless: completed/cancelled
  // rows never reappear as due.
  await AsyncStorage.setItem(
    DELIVERED_KEYS,
    JSON.stringify([...delivered].slice(-2_000))
  ).catch(() => undefined);
}
