// Every string Agenda says about itself: the view names, the states on the
// second control row, the editor's field labels, the scope panel, the RSVP
// verbs and each view's own empty case.
//
// Copy is a product decision that changes on its own schedule, so it lives
// here rather than inline in a render — the same reason Docs and Photos pulled
// theirs out. Two house rules bind everything below: no literal runs past 120
// characters or into a second sentence, and none of them says "please",
// "successfully", "simply", "in order to" or "you can".

import type { ViewKind } from "./types.ts";

/** The view switcher's segments, in the order the spec draws them. */
export const VIEW_LABELS: Readonly<Record<ViewKind, string>> = {
  month: "Month",
  week: "Week",
  day: "Day",
  schedule: "Schedule",
  waiting: "Waiting on",
};

/** What each view's rows are counted in, for the frame's app-bar count. */
export const VIEW_UNITS: Readonly<Record<ViewKind, string>> = {
  month: "events",
  week: "events",
  day: "events",
  schedule: "events",
  waiting: "invitations",
};

/** The one filled verb, and the quiet ones beside it. */
export const NEW_EVENT = "New event";
export const SEARCH_LABEL = "Search agenda";
export const TODAY = "Today";
export const PREVIOUS = "Previous";
export const NEXT = "Next";

/** The rail's three sections. `DAY_CONTEXT` is a labelled EMPTY slot in this
 *  wave: the layers that fill it — birthdays, due tasks, holidays — land with
 *  the day-context projection, and a section that drew nothing would be a
 *  header standing over air. */
export const RAIL_CALENDARS = "Calendars";
export const RAIL_DAY_CONTEXT = "Day context";
export const RAIL_DAY_CONTEXT_EMPTY = "Nothing decorating these days yet.";
export const RAIL_MINI_MONTH = "Month at a glance";

/** The grid's own promise, said once where a member might expect otherwise:
 *  a date with no time cost is never a row here. */
export const GRID_RULE = "The grid holds what takes time.";

/** The all-day rail above a timed grid. */
export const ALL_DAY = "All day";
/** A run that leaves this day. V1 draws it as one row on the day it starts
 *  and says so, rather than growing a bar across columns. */
export const CONTINUES = "Continues";
export const CONTINUED = "Continued";
export const NOW = "Now";

/** The second control row's states, each a designed answer rather than an
 *  error. `parked cancel` is the vault holding a cancellation for the owner. */
export const STATE_OFFLINE = "Offline — showing this device's copy.";
export const STATE_STALE = "This copy is behind the vault.";
export const STATE_REFRESH = "Refresh";
export const STATE_READ_FAILED = "The vault could not be reached.";
export const STATE_DAY_ONE = "No events yet.";
export const STATE_DAY_ONE_ACTION = "Add the first one";

/** Consent. A denial is a state with a way forward, never a dead end. */
export const DENIED_TITLE = "No vault access yet.";
export const PARTLY_DENIED_TITLE = "Part of this agenda is out of reach.";
export function partlyDeniedLine(names: readonly string[]): string {
  return `Hidden while denied: ${names.join(", ")}.`;
}

/** The parked cancellation. There is no unpark write in an app's hands — the
 *  vault holds the ask and the OWNER releases it in Approvals — so the copy
 *  states what is held and names who decides. */
export const PARKED_CANCEL_TITLE = "Cancellation held for the owner";
export const PARKED_CANCEL_BODY =
  "The event stays on the agenda until the owner approves the cancellation.";
export const PARKED_CANCEL_REVIEW = "Review in Approvals";

/** A row whose write has not landed. */
export const PENDING_MARK = "not in the vault yet";
export const PENDING_CANCEL_CHIP = "cancel asked";

/** Quick add on a slot: a title, then Edit for everything else. */
export const QUICK_TITLE = "New event";
export const QUICK_PLACEHOLDER = "What is it?";
export const QUICK_ADD = "Add";
export const QUICK_EDIT = "Edit";
export const QUICK_DISCARD = "Discard";

/** The editor's fields, in the order the spec draws them. */
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

/** Reminder leads, as minutes before the start. */
export const REMINDER_LEADS: readonly { minutes: number; label: string }[] = [
  { minutes: 0, label: "At the start" },
  { minutes: 10, label: "10 minutes before" },
  { minutes: 30, label: "30 minutes before" },
  { minutes: 60, label: "1 hour before" },
  { minutes: 1440, label: "1 day before" },
];
export const REMINDER_NONE = "No reminder";

/** Repeat choices, as the grammar the shared engine reads. The SUMMARY a row
 *  shows always comes back from the vault — these are the words on the
 *  picker, and the rule beside each one never reaches a surface. */
export const REPEAT_CHOICES: readonly { rrule: string; label: string }[] = [
  { rrule: "FREQ=DAILY", label: "Every day" },
  { rrule: "FREQ=WEEKLY", label: "Every week" },
  { rrule: "FREQ=WEEKLY;INTERVAL=2", label: "Every other week" },
  { rrule: "FREQ=MONTHLY", label: "Every month" },
  { rrule: "FREQ=YEARLY", label: "Every year" },
];

/** The scope panel, opened when an edit lands on a repeating event. No filled
 *  button here: all three answers are equally the member's. */
export const SCOPE_TITLE = "This event repeats";
export const SCOPE_QUESTION = "Which occurrences does this change?";
export const SCOPE_OCCURRENCE = "This occurrence";
export const SCOPE_FUTURE = "This and following";
export const SCOPE_SERIES = "The whole series";
export const SCOPE_SKIP = "Skip this occurrence";

/** RSVP. The answer is projected straight back into the guest list. */
export const RSVP_QUESTION = "Are you going?";
export const RSVP_YES = "Going";
export const RSVP_NO = "Not going";
export const RSVP_MAYBE = "Maybe";
export const RSVP_AWAITING = "No answer yet";

/** Attachments on an event. */
export const ATTACH = "Attach a file";
export const DETACH = "Remove";

/** Outcomes, on the frame's one status line. */
export const OUTCOME_PROPOSED = "Event proposed · receipt";
export const OUTCOME_UPDATED = "Event updated · receipt";
export const OUTCOME_OCCURRENCE = "Recurring event updated · receipt";
export const OUTCOME_QUEUED = "Saved on this device until the gateway answers.";
export const OUTCOME_PARKED = "Sent to the owner for confirmation.";
export const OUTCOME_ATTACHED = "File attached · receipt";
export const OUTCOME_DETACHED = "File removed · receipt";
export const UNDO = "Undo";

/** RSVP outcomes, keyed by the PARTSTAT the vault stores. */
export const RSVP_OUTCOME: Readonly<Record<string, string>> = {
  accepted: "RSVP recorded: Going · receipt",
  declined: "RSVP recorded: Not going · receipt",
  tentative: "RSVP recorded: Maybe · receipt",
};

/** Each view's empty case, in its own terms. A list that is empty because
 *  nothing matched is a different fact from one that is empty because the
 *  window holds nothing. */
export function emptyLine(view: ViewKind, searching: boolean): string {
  if (searching) return "Nothing matches that.";
  if (view === "waiting") return "Nothing is waiting on your answer.";
  if (view === "schedule") return "Nothing ahead in this window.";
  return "Nothing on these days.";
}

/** The untitled event's stand-in. A row always has something to read. */
export const UNTITLED = "Untitled event";
