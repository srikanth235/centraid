import { notifyEventReminderBody } from "@centraid/client/notifications-copy";

export const TASK_CATEGORY = "CENTRAID_TASK_REMINDER";
/** The ONE notification day context earns (#834): an inner-circle birthday. */
export const BIRTHDAY_CATEGORY = "CENTRAID_BIRTHDAY";
export const EVENT_CATEGORY = "CENTRAID_EVENT_REMINDER";
export const TALLY_CATEGORY = "CENTRAID_TALLY_SETTLE";
export const INVITE_CATEGORY = "CENTRAID_HOUSEHOLD_INVITE";
export const NOTIFICATIONS_CATEGORY = "CENTRAID_NOTIFICATIONS";
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
  | { kind: "open-notifications" };

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
  if (data.kind === "notifications") return { kind: "open-notifications" };
  return { kind: "open-app", appId: "tasks" };
}
