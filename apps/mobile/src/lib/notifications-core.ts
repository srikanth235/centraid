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
/** Birthdays this device has already SCHEDULED. Separate from the reminder
 *  ledger because these are future-dated: the entry is written when the OS
 *  accepts the trigger, not when the banner appears (#834). */
const SCHEDULED_BIRTHDAY_KEYS = "centraid:scheduled-birthday-keys:v1";
const DELIVERED_NOTIFICATION_KEYS = "centraid:delivered-notification-keys:v1";
/**
 * Separate from the ledger on purpose: a *quiet* Notifications seeds an empty ledger,
 * and an empty ledger must not read as "never seeded" on the next pass.
 */
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

/**
 * Notifications itself is the contextual owner gesture for notification consent.
 * Boot/background paths only inspect existing permission and never prompt.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (current.canAskAgain === false) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/**
 * Compose decision/high-severity Notifications notifications only after local fetch.
 *
 * The decisions (seed vs notify, foreground vs background) live in
 * `planNotifications`; this function is the I/O shell. `appState` is
 * injected so the rule is testable without RN's native module — RN's own
 * `AppState` satisfies the shape, and is the default.
 */
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
      // Device bookkeeping is disposable; the authenticated Notifications pull is truth.
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
 * Schedule the inner-circle birthday notifications (#834).
 *
 * REMINDER DELIVERY IS THE PHONE'S ALONE, and this is the one notification day
 * context earns. The decision — who, when, and what it says — lives entirely
 * in `planBirthdayNotifications`; this is the I/O shell, and the people it
 * plans over are read by the caller off the agenda replica (`day-context.ts`)
 * so nothing here reaches the network.
 *
 * Future-dated triggers, so the ledger records what has been SCHEDULED rather
 * than what has been shown; a re-run therefore never doubles a banner.
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
  // Bound the ledger: a key names one person in one year, so the oldest
  // entries are birthdays long past.
  await AsyncStorage.setItem(
    SCHEDULED_BIRTHDAY_KEYS,
    JSON.stringify([...scheduled].slice(-2_000))
  ).catch(() => undefined);
  return plan.length;
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
