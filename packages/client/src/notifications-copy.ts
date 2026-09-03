export const NOTIFY_OUTBOX_BODY = "External write needs your approval";

export const NOTIFY_NEEDS_AUTH_BODY = "Open Notifications to reconnect";

export const NOTIFY_PARKED_BODY = "A decision is waiting in Notifications";

export const NOTIFY_SCOPE_BODY = "Review the requested scope in Notifications";

export const NOTIFY_NOTICE_BODY = "Open Notifications for details";

export function notifyEventReminderBody(minutesBefore: number): string {
  return minutesBefore === 0
    ? "Starting now"
    : `Starts in ${minutesBefore} minutes`;
}
