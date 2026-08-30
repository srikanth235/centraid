// Every string the Tasks room says (spec §6, verbatim). ONE FILE: a sentence
// written at its render site cannot be reviewed against the table.
//
// A TWO-SENTENCE ROW IS TWO CONSTANTS — the copy ratchet holds every literal
// to one thought, and the pair renders as two nodes in the table's order.
//
// Interpolate counts and dates through the functions below; never store a
// string with a number baked into it.
import type { ShelfId } from "./shelves.ts";
import {
  ALL,
  ANYTIME,
  INBOX,
  LOGBOOK,
  NOTIFY,
  PROJECT,
  PROJECTS,
  REENTRY,
  SEARCH,
  TASK,
  UPCOMING,
} from "./shelves.ts";

export interface ShelfCopy {
  title: string;
  unit: string;
}

const SHELF_COPY: Readonly<Record<string, ShelfCopy>> = {
  [UPCOMING]: { title: "Upcoming", unit: "tasks" },
  [ANYTIME]: { title: "Anytime", unit: "tasks" },
  [ALL]: { title: "All", unit: "tasks" },
  [INBOX]: { title: "Inbox", unit: "tasks" },
  [PROJECTS]: { title: "Projects", unit: "projects" },
  [PROJECT]: { title: "Project", unit: "tasks" },
  [TASK]: { title: "Task", unit: "tasks" },
  [REENTRY]: { title: "Catch up", unit: "tasks" },
  [LOGBOOK]: { title: "Logbook", unit: "tasks" },
  [SEARCH]: { title: "Search", unit: "hits" },
  [NOTIFY]: { title: "Reminder", unit: "reminders" },
};

/** Today is the room's own root, so it answers with the app's own name. */
export function shelfCopy(shelf: ShelfId, projectName?: string): ShelfCopy {
  if (projectName) return { title: projectName, unit: "tasks" };
  if (typeof shelf === "string" && SHELF_COPY[shelf]) {
    return SHELF_COPY[shelf] as ShelfCopy;
  }
  return { title: "Today", unit: "tasks" };
}

export const RAIL_HEADS = {
  views: "Views · when it is due",
  projects: "Projects · where it belongs",
} as const;

export const GROUPS = {
  overdue: "Overdue",
  today: "Today",
  dated: "Dated",
  undated: "Undated",
  inbox: "Inbox",
  moveAll: "Move all to today",
  catchUp: "Catch up",
  showMore: "Show more",
  addTask: "Add task",
  file: "File",
} as const;

/** Two earned-quiet states, never one ambiguous "all clear" (§9). */
export const TODAY_DONE = "Everything due today is done.";
export const TODAY_EMPTY = "Nothing is scheduled for today.";
export const TODAY_EMPTY_SUB =
  "An undated task never lands here — Anytime holds those.";
export const DAY_ONE = "Add the first thing you must not forget.";
export const DAY_ONE_ACTS = ["Add a task", "Make a project"] as const;

export function nothingElseUntil(day: string): string {
  return `Nothing else is due until ${day}.`;
}

/** A count and a reassurance, never a scold. */
export function overdueMeta(count: number): string {
  return `${count} · nothing was deleted`;
}

// Re-entry (spec §3, ruling 2)
export function reentryNotice(days: number, due: number): string {
  return `You were away ${days} days · ${due} tasks came due. Nothing was deleted.`;
}

export function reentryHead(days: number, due: number): string {
  return `${days} days away · ${due} tasks came due`;
}

export const REENTRY_LEAD_A =
  "Nothing was deleted and nothing repeated itself into a pile.";
export const REENTRY_LEAD_B = "Move what still matters and release the rest.";
export const REENTRY_FOOT_A =
  "Releasing keeps them in the Logbook as won't do.";
export const REENTRY_FOOT_B = "It is an outcome, not a failure.";
export const REENTRY_NONE = "Nothing came due while you were away.";

/** One bulk verb each (§3). */
export const REENTRY_BUCKETS = {
  dated: { label: "Dated while you were away", verb: "Move all to today" },
  repeating: { label: "Repeating", verb: "Skip to the next one" },
  sitting: { label: "Sitting since March", verb: "Release all" },
} as const;

// The row's own words
export const MISSED_NOTE_A = "One live occurrence.";
export const MISSED_NOTE_B =
  "Four missed periods collapse into it — never four copies.";

/** From the collapse the query already did, never a recount. */
export function missedLabel(missed: number, nextDay: string): string {
  return `missed ${missed} · next is ${nextDay}`;
}

export function familyProgress(done: number, total: number): string {
  return `${done} of ${total}`;
}

/** The age signal (§5) — a fact, never a reprimand. */
export function sittingSince(month: string): string {
  return `sitting since ${month}`;
}

/** Marks a shared-vault row; personal rows stay silent. */
export const VAULT_MARKER = "HOUSE";

export const DONE = "Done";
export const WONT_DO = "Won't do";
export const UNDO = "Undo";
export const REOPEN = "Reopen";

export function doneNext(day: string): string {
  return `Done · the next one is ${day}`;
}

// The editor
export const FIELDS = {
  when: "When",
  time: "Time",
  where: "Where",
  area: "Area",
  project: "Project",
  priority: "Priority",
  effort: "Effort",
  repeats: "Repeats",
  anchor: "Anchor",
  missed: "Missed",
  reminder: "Reminder",
  tags: "Tags",
  subtasks: "Subtasks",
  attached: "Attached",
  homeVault: "Home vault",
  landsIn: "Lands in",
  notes: "Notes",
} as const;

export function reminderLead(minutes: number): string {
  return `${minutes} min`;
}

export const LIFECYCLE = { start: "Start", stop: "Stop" } as const;

export const FIELD_EMPTY = "—";

export const ANCHOR_NOTE =
  "The one choice that decides what a missed period means.";
export const ANCHOR_CARDS = [
  {
    value: "scheduled" as const,
    head: "From the schedule",
    body: "Every Monday, whether or not I did it.",
    tag: "Rent.",
  },
  {
    value: "completion" as const,
    head: "From completion",
    body: "3 days after I last finished it.",
    tag: "Watering.",
  },
];

export const PRIORITY_CHIPS = ["None", "Soon", "Next", "Now"] as const;
export const PRIORITY_NOTE_A = "Optional.";
export const PRIORITY_NOTE_B =
  "Most tasks never take one, and no layout reserves room for it.";

export const EFFORT_CHIPS = ["None", "5", "15", "25 min", "1 hour"] as const;
export const EFFORT_NOTE_A = "Feeds the “fits in 30 minutes” lens in Today.";
export const EFFORT_NOTE_B = "Never prompted for.";

export const DATE_ONLY_REMINDER =
  "Date only · it reminds at 09:00, the moment set in Settings — never midnight.";
export const REMINDER_NOTE_A = "Delivered on your phone.";
export const REMINDER_NOTE_B =
  "This seat says due-ness in the pane, never a push.";

export const SUBTASK_CAP = "One level only · a subtask cannot have a subtask";
export const PROMOTION_A = "Five children and counting.";
export const PROMOTION_B = "This is a project with sections now.";
export const PROMOTION_VERB = "Make it a project";

export const TAGS_NOTE_A = "House-wide vocabulary.";
export const TAGS_NOTE_B = "Removing deletes this task's edge only.";

export function homeVault(vault: string, who: string): string {
  return `${vault} · ${who} can see it and complete it`;
}
export const HOME_VAULT_NOTE_A = "A task keeps the vault it was born in.";
export const HOME_VAULT_NOTE_B = "Completion is receipted there.";

// Release is OUTLINED SECONDARY — it destroys nothing; only Delete takes the
// outlined `net` control (§3).
export const RELEASE_CONFIRM = {
  title: "Release this task?",
  bodyA: "It goes to the Logbook as won't do, with its history.",
  bodyB: "Nothing is erased.",
  verb: "Release",
} as const;

export const DELETE_CONFIRM = {
  title: "Delete this task?",
  bodyA: "This removes the row and its subtasks from the vault.",
  bodyB: "The Logbook keeps nothing.",
  verb: "Delete",
} as const;

export const CANCEL = "Cancel";

// The honest states
export const PENDING_CHIP = "Saved on this device · queued for the vault";
export const PENDING_ROW = "not in the vault yet";

export function pendingStatus(writes: number): string {
  const noun = writes === 1 ? "write is" : "writes are";
  return `${writes} ${noun} on this device · they settle when the gateway answers`;
}

export function staleNotice(at: string): string {
  return `This replica last matched the vault at ${at}.`;
}
export const REFRESH = "Refresh";

export function partialNotice(vault: string, own: number): string {
  return `${vault} did not answer · showing ${own} of your own tasks.`;
}
export const RETRY = "Retry";

export function windowEndBoard(shown: number, total: number): string {
  return `${shown} of ${total} · this is a window, not everything open`;
}

export function windowEndLogbook(shown: number, total: string): string {
  return `${shown} of ${total} · the vault answers with the 50 most recent`;
}

export function inboxMeta(count: number): string {
  return `${count} · nothing is counting at you`;
}

// Capture, search, reminder
export const QUICK_ADD = {
  pointerPlaceholder: "Name it so it still makes sense on Friday",
  touchPlaceholder: "What is it? Name it for Friday",
  assistant:
    "Dates and repeats in words — “every other Friday, high priority”.",
  add: "Add",
} as const;

export function landsInFoot(place: string, vault: string): string {
  return `${place} · ${vault}`;
}

/** `none` is a CHOICE, so it rides the row rather than sitting outside it. */
export const QUICK_ADD_WHEN = [
  { key: "today", label: "Today" },
  { key: "tomorrow", label: "Tomorrow" },
  { key: "weekend", label: "This weekend" },
  { key: "next-week", label: "Next week" },
  { key: "none", label: "No date" },
] as const;

export const LENSES = [
  { key: "effort", label: "Fits in 30 min" },
  { key: "mine", label: "Mine" },
  { key: "house", label: "House" },
] as const;

/** The toggle names the order it WILL take, never the one it is in. */
export const SORT_LABELS = {
  priority: "Priority within date",
  manual: "Manual order",
} as const;

export function boardCount(shown: number, unit: string): string {
  const singular = unit.endsWith("s") ? unit.slice(0, -1) : unit;
  return `${shown} ${shown === 1 ? singular : unit}`;
}

/** A project may also belong to neither. */
export const AREAS = ["Home", "Work"] as const;

export const NEW_PROJECT = {
  title: "New project",
  name: "Name",
  verb: "Create project",
  note: "A project needs a name, an area, and the vault it lives in.",
} as const;

export const SECTIONS = {
  none: "No section",
  add: "Add section",
  name: "Section name",
} as const;

export const SEARCH_COPY = {
  placeholder: "Search tasks",
  everywhere: "Everywhere",
  thisProject: "This project",
} as const;

export const NOTIFY_COPY = {
  complete: "Complete",
  snooze: "Snooze",
  open: "Open",
  rule: "Snooze moves the reminder, never the due date",
  snoozes: ["10 min", "1 hour", "This evening", "Tomorrow 09:00"],
} as const;

// Denial is DATA (§3, §5): name the receipt, the scope and the time, and offer
// a way to the grant rather than a dead end.
export const DENIED = {
  title: "Tasks cannot read this vault",
  bodyA: "Ask the owner of this vault for access.",
  bodyB: "Your tasks, history and receipts are untouched.",
  receipt: "Receipt",
  scope: "Scope",
  when: "When",
  holds: "What Tasks holds",
} as const;

/** In the sheet's own order; `meta` is a rule, never a count. */
export const MORE_ROWS: readonly {
  shelf: ShelfId;
  label: string;
  meta?: string;
}[] = [
  { shelf: ANYTIME, label: "Anytime", meta: "no date, still yours" },
  { shelf: ALL, label: "All", meta: "dated and undated together" },
  { shelf: SEARCH, label: "Search" },
  { shelf: LOGBOOK, label: "Logbook", meta: "done and won't do" },
  { shelf: REENTRY, label: "Catch up", meta: "the pressure valve" },
  { shelf: NOTIFY, label: "Reminder", meta: "delivered on your phone" },
];

/** The keyboard sheet, in the order the spec lists it (§7). */
export const SHORTCUTS: readonly { keys: string; act: string }[] = [
  { keys: "q", act: "Quick add" },
  { keys: "c", act: "Quick add" },
  { keys: "/", act: "Search" },
  { keys: "1–4", act: "Priority on the focused row" },
  { keys: "t", act: "Move to today" },
  { keys: "e", act: "Complete" },
  { keys: "j / k", act: "Traverse rows" },
  { keys: "Esc", act: "Dismiss overlay" },
  { keys: "?", act: "This sheet" },
];
