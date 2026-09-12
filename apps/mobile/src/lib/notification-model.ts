import { notifyEventReminderBody } from "@centraid/client/notifications-copy";

export const TASK_CATEGORY = "CENTRAID_TASK_REMINDER";
/** The ONE notification day context earns (#834): an inner-circle birthday. */
export const BIRTHDAY_CATEGORY = "CENTRAID_BIRTHDAY";
export const EVENT_CATEGORY = "CENTRAID_EVENT_REMINDER";
export const TALLY_CATEGORY = "CENTRAID_TALLY_SETTLE";
export const INVITE_CATEGORY = "CENTRAID_HOUSEHOLD_INVITE";
export const NOTIFICATIONS_CATEGORY = "CENTRAID_NOTIFICATIONS";
/** A notice push's own category: its button names the alerts, not Needs you. */
export const ALERTS_CATEGORY = "CENTRAID_ALERTS";

/**
 * Where a Notifications push lands, by what it is ABOUT (#1015 R-NY-2). A
 * decision opens Needs you; a notice — a rule that did not finish, a gateway
 * that went down — opens Activity's alerts view, because Needs you holds no
 * notices and would open empty. The url carries the same answer, since a
 * tapped push's url is followed by the linking table as well as by
 * `notificationActionPlan`, and the two must not disagree.
 */
export function notificationsPushRouting(about: "decision" | "notice"): {
  categoryIdentifier: string;
  data: Record<string, string>;
} {
  return about === "notice"
    ? {
        categoryIdentifier: ALERTS_CATEGORY,
        data: {
          about,
          kind: "notifications",
          url: "centraid://insights?initialTab=alerts",
        },
      }
    : {
        categoryIdentifier: NOTIFICATIONS_CATEGORY,
        data: {
          about,
          kind: "notifications",
          url: "centraid://settings/notifications",
        },
      };
}
export const COMPLETE_TASK = "COMPLETE_TASK";
export const SNOOZE_TASK = "SNOOZE_TASK";
export const OPEN_ITEM = "OPEN_ITEM";
export const SETTLE_BALANCE = "SETTLE_BALANCE";

export interface DueReminder {
  key: string;
  kind: "task" | "event" | "tally" | "invite";
  id: string;
  title: string;
  at: string;
  minutesBefore: number;
}

export interface LocalNotificationContent {
  title: string;
  body: string;
  categoryIdentifier: string;
  data: Record<string, string>;
}

export function notificationContent(
  reminder: DueReminder
): LocalNotificationContent {
  if (reminder.kind === "task")
    return {
      title: reminder.title,
      body: "Task reminder",
      categoryIdentifier: TASK_CATEGORY,
      data: {
        kind: "task",
        taskId: reminder.id,
        url: "centraid://apps/tasks",
      },
    };
  if (reminder.kind === "event")
    return {
      title: reminder.title,
      body: notifyEventReminderBody(reminder.minutesBefore),
      categoryIdentifier: EVENT_CATEGORY,
      data: {
        kind: "event",
        eventId: reminder.id,
        url: `centraid://agenda/event/${encodeURIComponent(reminder.id)}`,
      },
    };
  if (reminder.kind === "invite")
    return {
      title: "Household invitation",
      body: "Open Centraid to review this private invitation.",
      categoryIdentifier: INVITE_CATEGORY,
      data: {
        kind: "invite",
        inviteId: reminder.id,
        url: "centraid://home",
      },
    };
  return {
    title: "Expense ready to review",
    body: "Open Tally to review the recurring expense preview.",
    categoryIdentifier: TALLY_CATEGORY,
    data: {
      kind: "tally",
      expenseId: reminder.id,
      url: "centraid://apps/tally",
    },
  };
}

export type NotificationActionPlan =
  | { kind: "open-person"; partyId: string }
  | { kind: "complete-task"; taskId: string }
  | { kind: "snooze" }
  | { kind: "open-event"; eventId: string }
  | { kind: "open-app"; appId: "tasks" | "tally" }
  | { kind: "open-home" }
  | { kind: "open-notifications" }
  | { kind: "open-alerts" };

export function notificationActionPlan(
  action: string,
  data: Record<string, unknown>
): NotificationActionPlan {
  if (action === COMPLETE_TASK && typeof data.taskId === "string")
    return { kind: "complete-task", taskId: data.taskId };
  if (action === SNOOZE_TASK) return { kind: "snooze" };
  if (data.kind === "event" && typeof data.eventId === "string")
    return { kind: "open-event", eventId: data.eventId };
  // A birthday notification is ABOUT a person, so it lands on that person —
  // not on the calendar, which holds no row for it and never will.
  if (data.kind === "birthday" && typeof data.partyId === "string")
    return { kind: "open-person", partyId: data.partyId };
  if (data.kind === "tally" || action === SETTLE_BALANCE)
    return { kind: "open-app", appId: "tally" };
  if (data.kind === "invite") return { kind: "open-home" };
  // A push with no `about` predates it and was always a decision's.
  if (data.kind === "notifications")
    return data.about === "notice"
      ? { kind: "open-alerts" }
      : { kind: "open-notifications" };
  return { kind: "open-app", appId: "tasks" };
}
