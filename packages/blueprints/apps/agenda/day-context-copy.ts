/**
 * What the day-context layers SAY, on every seat (#834).
 *
 * Deliberately IMPORT-FREE, the same shape and for the same reason as
 * `apps/_shared/shared-copy.ts` and `apps/tasks/when.ts`: the phone draws the
 * same ribbon and the same shelf as the pointer surface, and the mobile
 * TypeScript project neither enables `allowImportingTsExtensions` nor declares
 * CSS modules. A leaf with no imports is the only shape both worlds can read —
 * and two homes for `3 due` is how the two seats end up saying different
 * things about the same day.
 *
 * `view-copy.ts` re-exports every name here, so Agenda's own surfaces are
 * unchanged and there is still exactly one definition of each string.
 */

/**
 * The three day-context layers, in the order the rail draws them. LAYERS ARE
 * NOT CALENDARS: each is stored where it belongs — the person, the task, the
 * subscription — so nothing here can be written to, and the meta beside each
 * name says where it lives.
 */
export const LAYERS: readonly { id: string; name: string; from: string }[] = [
  { id: "bdays", name: "Birthdays", from: "from People" },
  { id: "due", name: "Due tasks", from: "from Tasks" },
  { id: "hols", name: "Holidays", from: "subscribed" },
];

/** Said once under the switches, because a member may reasonably read three
 *  toggles as three more calendars. */
export const LAYERS_READ_ONLY =
  "Layers decorate a day; none of them is writable.";

/** The ribbon's collapsed forms. A cell that spelled three names would push
 *  the day's events out of it, so several facts read as one count. */
export function ribbonCollapsedBirthdays(count: number): string {
  return `${count} birthdays`;
}
export function ribbonCollapsed(count: number): string {
  return `${count} dates`;
}

/** The day shelf: collapsed by default, per day, and never a grid chip. */
export function shelfDue(count: number): string {
  return `${count} due`;
}
export const SHELF_HIDE = "Hide";
/** What a shelf row opens. Tap-through hands the task to Tasks, which is the
 *  room that owns it — Agenda never edits one. */
export const SHELF_OPEN_IN_TASKS = "Open in Tasks";

/**
 * The one notification day context earns, and only for the people the member
 * starred. Everyone else stays on the day as a ribbon.
 */
export function birthdayNotificationTitle(
  name: string,
  weekday: string
): string {
  return `${name}’s birthday is on ${weekday}`;
}
export function birthdayNotificationBody(lead: string): string {
  return `Inner circle · your phone tells you ${lead} ahead.`;
}
/** The leads a member may choose, and the default among them. */
export const BIRTHDAY_LEADS: readonly { days: number; label: string }[] = [
  { days: 0, label: "same day" },
  { days: 2, label: "2 days" },
  { days: 7, label: "1 week" },
];
export const BIRTHDAY_LEAD_DEFAULT_DAYS = 2;
