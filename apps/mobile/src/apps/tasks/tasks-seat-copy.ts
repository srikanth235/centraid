// THE SENTENCES THAT ARE TRUE ON A PHONE AND NOWHERE ELSE.
//
// Everything a seat shares is imported from `apps/tasks/view-copy.ts` — the §6
// table lives there once and this file never respells a line of it. What is
// here is the handful of facts that are only facts on this seat:
//
//   1. SEARCH IS A GATEWAY READ. The FTS5 index lives in the vault, so the
//      phone asks the `search` query rather than grepping its replica. With no
//      gateway there is no answer, and the surface says which of the two it is
//      missing instead of showing an empty result set.
//   2. THIS SEAT IS THE ONE THAT DELIVERS A REMINDER. The pointer seats say
//      due-ness in the pane; the notification is this phone's.
//   3. THE LOGBOOK HERE HAS NO DENOMINATOR. The replica holds what it has
//      synced, and no count of what lies behind it, so the §6 window sentence
//      (which carries the vault's total) would be a claim nobody checked.
//   4. FILES ARE PINNED WHERE THE FILES ARE.
//
// Pure: no `react-native` import, so the surfaces' tests read these directly.

export const SEARCH_UNREACHABLE_TITLE = "Search asks the vault, not this phone";
export const SEARCH_UNREACHABLE_BODY =
  "The index that matches these words sits beside the gateway, out of reach right now.";
export const SEARCH_IDLE = "Type to search your tasks by title and note.";
export function searchHits(count: number): string {
  return `${count} · ranked by the vault`;
}

export const REMINDER_SEAT_NOTE =
  "This is the seat that delivers them · the moment is the vault's.";
export const REMINDER_NONE = "No task here carries a reminder yet.";

/** The window with no denominator: what is shown, and that it is a window. */
export function logbookShown(count: number): string {
  return `${count} · what this device has synced, not the whole Logbook`;
}

export const ATTACHED_SEAT_NOTE = "Pinned where the files are, not from here.";

/** The detail place's own two rows of chrome. */
export const NOTE_PLACEHOLDER = "A note, for the version of you on Friday";
export const TAG_PLACEHOLDER = "Add a tag";

export const READING_TASKS = "Reading your tasks";

export const PROJECT_NAME_PLACEHOLDER = "What is this project for?";
export const TASK_NAME_PLACEHOLDER = "What is it?";

// ─── The detail place's four scheduling controls (#1015) ─────────────
//
// The choices, not the values: the values are the vault's and the §6 table
// spells them (`reminderLead`, `recurrence_summary`). These are the phone's
// shortcuts — the set a thumb can reach without a form.

export const WHEN_PICK = "Pick a day";
export const WHEN_CLEAR = "No day";
export const TIME_PICK = "Pick a time";
export const TIME_CLEAR = "No time";

/** `null` clears the lead; `0` means at the moment itself. */
export const REMINDER_LEADS: readonly {
  label: string;
  minutes: number | null;
}[] = [
  { label: "None", minutes: null },
  { label: "At the time", minutes: 0 },
  { label: "10 min before", minutes: 10 },
  { label: "1 hour before", minutes: 60 },
  { label: "1 day before", minutes: 1440 },
];

/** `null` clears the rule. RRULE, because that is what `edit` stores. */
export const REPEAT_RULES: readonly { label: string; rrule: string | null }[] =
  [
    { label: "Never", rrule: null },
    { label: "Daily", rrule: "FREQ=DAILY" },
    { label: "Weekly", rrule: "FREQ=WEEKLY" },
    { label: "Monthly", rrule: "FREQ=MONTHLY" },
    { label: "Yearly", rrule: "FREQ=YEARLY" },
  ];
