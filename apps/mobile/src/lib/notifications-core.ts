import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { AppState } from "react-native";

import { authHeader } from "./gateway";
import { planInboxNotifications } from "./inbox-notification-model";
import type { MobileInboxNotificationPull } from "./inbox-notification-model";
import * as NotificationModel from "./notification-model";
import type { DueReminder } from "./notification-model";

const DELIVERED_KEYS = "centraid:delivered-reminder-keys:v1";
const DELIVERED_INBOX_KEYS = "centraid:delivered-inbox-keys:v1";
/**
 * Separate from the ledger on purpose: a *quiet* Inbox seeds an empty ledger,
 * and an empty ledger must not read as "never seeded" on the next pass.
 */
const SEEDED_INBOX_LEDGER = "centraid:delivered-inbox-keys:seeded:v1";

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
      NotificationModel.INBOX_CATEGORY,
      [
        {
          identifier: NotificationModel.OPEN_ITEM,
          buttonTitle: "Open Inbox",
          options: { opensAppToForeground: true },
        },
      ]
    ),
  ]);
}

/**
 * Inbox itself is the contextual owner gesture for notification consent.
 * Boot/background paths only inspect existing permission and never prompt.
 */
export async function requestInboxNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (current.canAskAgain === false) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

/**
 * Compose decision/high-severity Inbox notifications only after local fetch.
 *
 * The decisions (seed vs notify, foreground vs background) live in
 * `planInboxNotifications`; this function is the I/O shell. `appState` is
 * injected so the rule is testable without RN's native module — RN's own
 * `AppState` satisfies the shape, and is the default.
 */
export async function syncInboxNotifications(
  baseUrl: string,
  vaultId: string,
  appState: { currentState: string } = AppState
): Promise<void> {
  const permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) return;
  const response = await fetch(new URL("/centraid/_vault/inbox", baseUrl), {
    headers: { ...authHeader(), "x-centraid-vault": vaultId },
  });
  if (!response.ok) return;
  const inbox = (await response.json()) as MobileInboxNotificationPull;
  const [rawLedger, rawSeeded] = await Promise.all([
    AsyncStorage.getItem(DELIVERED_INBOX_KEYS).catch(() => null),
    AsyncStorage.getItem(SEEDED_INBOX_LEDGER).catch(() => null),
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
      // Device bookkeeping is disposable; the authenticated Inbox is truth.
    }
  }
  const plan = planInboxNotifications({
    inbox,
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
          categoryIdentifier: NotificationModel.INBOX_CATEGORY,
          data: { kind: "inbox", url: "centraid://settings/inbox" },
        },
        trigger: null,
      })
    )
  );
  if (plan.nextDelivered) {
    await AsyncStorage.setItem(
      DELIVERED_INBOX_KEYS,
      JSON.stringify(plan.nextDelivered)
    ).catch(() => undefined);
  }
  if (plan.seeded)
    await AsyncStorage.setItem(SEEDED_INBOX_LEDGER, "1").catch(() => undefined);
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
