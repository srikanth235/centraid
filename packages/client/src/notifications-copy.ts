// What a notification SAYS, on either surface (issue #805, slice C).
//
// `notifications-model.ts` composes the web push payloads and mobile's
// `lib/notifications-plan.ts` composes the native ones from the same
// Notifications pull, with the same five bodies written out twice. A push body
// is the one string a member reads with the app closed, so two spellings of it
// is drift where drift is least recoverable.
//
// Fragments by budget (DESIGN.md → Copy): a notification body is a status
// line, and each of these already was one.

/** A staged external write is waiting on a decision. */
export const NOTIFY_OUTBOX_BODY = "External write needs your approval";

/** A connection's credential lapsed. */
export const NOTIFY_NEEDS_AUTH_BODY = "Open Notifications to reconnect";

/** A parked invocation is waiting. */
export const NOTIFY_PARKED_BODY = "A decision is waiting in Notifications";

/** An app asked for wider access. */
export const NOTIFY_SCOPE_BODY = "Review the requested scope in Notifications";

/** A high-severity notice landed. */
export const NOTIFY_NOTICE_BODY = "Open Notifications for details";

/** An event reminder's body: the lead time, or that it is starting. */
export function notifyEventReminderBody(minutesBefore: number): string {
  return minutesBefore === 0
    ? "Starting now"
    : `Starts in ${minutesBefore} minutes`;
}
