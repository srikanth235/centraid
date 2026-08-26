// Agenda copy table. No literal past 120 characters or a second sentence;
// none says "please", "successfully", "simply", "in order to" or "you can".

import type { ViewKind } from "./types.ts";

export const VIEW_LABELS: Readonly<Record<ViewKind, string>> = {
  month: "Month",
  week: "Week",
  day: "Day",
  schedule: "Schedule",
  waiting: "Waiting on",
};

export const VIEW_UNITS: Readonly<Record<ViewKind, string>> = {
  month: "events",
  week: "events",
  day: "events",
  schedule: "events",
  waiting: "invitations",
};

export const NEW_EVENT = "New event";
export const SEARCH_LABEL = "Search agenda";
export const TODAY = "Today";
export const PREVIOUS = "Previous";
export const NEXT = "Next";

/** Empty Day context when the read was refused — no switches over missing facts. */
export const RAIL_CALENDARS = "Calendars";
export const RAIL_DAY_CONTEXT = "Day context";
export const RAIL_DAY_CONTEXT_EMPTY = "Nothing decorating these days yet.";
export const RAIL_MINI_MONTH = "Month at a glance";

/**
 * Day-context words live in `day-context-copy.ts` — import-free so the phone
 * can share it (#834). Re-exported so there is still one definition.
 */
export {
  BIRTHDAY_LEAD_DEFAULT_DAYS,
  BIRTHDAY_LEADS,
  LAYERS,
  LAYERS_READ_ONLY,
  ribbonCollapsed,
  ribbonCollapsedBirthdays,
  SHELF_HIDE,
  SHELF_OPEN_IN_TASKS,
  shelfDue,
} from "./day-context-copy.ts";

/** A date with no time cost is never a row here. */
export const GRID_RULE = "The grid holds what takes time.";

export const ALL_DAY = "All day";
/** A run that leaves this day — one row on the start day, not a bar across columns. */
export const CONTINUES = "Continues";
export const CONTINUED = "Continued";
export const NOW = "Now";

export const STATE_OFFLINE = "Offline — showing this device's copy.";
export const STATE_STALE = "This copy is behind the vault.";
export const STATE_REFRESH = "Refresh";
export const STATE_READ_FAILED = "The vault could not be reached.";
export const STATE_DAY_ONE = "No events yet.";
export const STATE_DAY_ONE_ACTION = "Add the first one";

export const DENIED_TITLE = "No vault access yet.";
export const PARTLY_DENIED_TITLE = "Part of this agenda is out of reach.";
export function partlyDeniedLine(names: readonly string[]): string {
  return `Hidden while denied: ${names.join(", ")}.`;
}

/** No unpark write in the app — the owner releases it in Approvals. */
export const PARKED_CANCEL_TITLE = "Cancellation held for the owner";
export const PARKED_CANCEL_BODY =
  "The event stays on the agenda until the owner approves the cancellation.";
export const PARKED_CANCEL_REVIEW = "Review in Approvals";

export const PENDING_MARK = "not in the vault yet";
export const PENDING_CANCEL_CHIP = "cancel asked";

export const QUICK_TITLE = "New event";
export const QUICK_PLACEHOLDER = "What is it?";
export const QUICK_ADD = "Add";
export const QUICK_EDIT = "Edit";
export const QUICK_DISCARD = "Discard";

export const EDITOR_TITLE = "Event";
export const FIELD_SUMMARY = "Title";
export const FIELD_ALL_DAY = "All day";
export const FIELD_STARTS = "Starts";
export const FIELD_ENDS = "Ends";
export const FIELD_REPEAT = "Repeats";
export const FIELD_CALENDAR = "Calendar";
export const FIELD_GUESTS = "Guests";
export const FIELD_REMINDER = "Reminder";
export const FIELD_WHERE = "Joining link";
export const REPEAT_NEVER = "Does not repeat";
export const SAVE = "Save";
export const CLOSE = "Close";
export const CANCEL_EVENT = "Ask to cancel";

export const REMINDER_LEADS: readonly { minutes: number; label: string }[] = [
  { minutes: 0, label: "At the start" },
  { minutes: 10, label: "10 minutes before" },
  { minutes: 30, label: "30 minutes before" },
  { minutes: 60, label: "1 hour before" },
  { minutes: 1440, label: "1 day before" },
];
export const REMINDER_NONE = "No reminder";

/** Picker words; the summary a row shows always comes back from the vault. */
export const REPEAT_CHOICES: readonly { rrule: string; label: string }[] = [
  { rrule: "FREQ=DAILY", label: "Every day" },
  { rrule: "FREQ=WEEKLY", label: "Every week" },
  { rrule: "FREQ=WEEKLY;INTERVAL=2", label: "Every other week" },
  { rrule: "FREQ=MONTHLY", label: "Every month" },
  { rrule: "FREQ=YEARLY", label: "Every year" },
];

/** No filled button — all three scope answers are equal. */
export const SCOPE_TITLE = "This event repeats";
export const SCOPE_QUESTION = "Which occurrences does this change?";
export const SCOPE_OCCURRENCE = "This occurrence";
export const SCOPE_FUTURE = "This and following";
export const SCOPE_SERIES = "The whole series";
export const SCOPE_SKIP = "Skip this occurrence";

export const RSVP_QUESTION = "Are you going?";
export const RSVP_YES = "Going";
export const RSVP_NO = "Not going";
export const RSVP_MAYBE = "Maybe";
export const RSVP_AWAITING = "No answer yet";

export const ATTACH = "Attach a file";
export const DETACH = "Remove";

export const OUTCOME_PROPOSED = "Event proposed · receipt";
export const OUTCOME_UPDATED = "Event updated · receipt";
export const OUTCOME_OCCURRENCE = "Recurring event updated · receipt";
export const OUTCOME_QUEUED = "Saved on this device until the gateway answers.";
export const OUTCOME_PARKED = "Sent to the owner for confirmation.";
export const OUTCOME_ATTACHED = "File attached · receipt";
export const OUTCOME_DETACHED = "File removed · receipt";
export const UNDO = "Undo";

export const RSVP_OUTCOME: Readonly<Record<string, string>> = {
  accepted: "RSVP recorded: Going · receipt",
  declined: "RSVP recorded: Not going · receipt",
  tentative: "RSVP recorded: Maybe · receipt",
};

export function emptyLine(view: ViewKind, searching: boolean): string {
  if (searching) return "Nothing matches that.";
  if (view === "waiting") return "Nothing is waiting on your answer.";
  if (view === "schedule") return "Nothing ahead in this window.";
  return "Nothing on these days.";
}

export const UNTITLED = "Untitled event";
