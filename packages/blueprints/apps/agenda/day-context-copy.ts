// IMPORT-FREE leaf: mobile TS can't read ts-extensions/CSS modules; no imports.

export const LAYERS: readonly { id: string; name: string; from: string }[] = [
  { id: "bdays", name: "Birthdays", from: "from People" },
  { id: "due", name: "Due tasks", from: "from Tasks" },
  { id: "hols", name: "Holidays", from: "subscribed" },
];

/** Said once under the switches, because a member may reasonably read three
 *  toggles as three more calendars. */
export const LAYERS_READ_ONLY =
  "Layers decorate a day; none of them is writable.";

export function ribbonCollapsedBirthdays(count: number): string {
  return `${count} birthdays`;
}
export function ribbonCollapsed(count: number): string {
  return `${count} dates`;
}

export function shelfDue(count: number): string {
  return `${count} due`;
}
export const SHELF_HIDE = "Hide";
export const SHELF_OPEN_IN_TASKS = "Open in Tasks";

export function birthdayNotificationTitle(
  name: string,
  weekday: string
): string {
  return `${name}’s birthday is on ${weekday}`;
}
export function birthdayNotificationBody(lead: string): string {
  return `Inner circle · your phone tells you ${lead} ahead.`;
}
export const BIRTHDAY_LEADS: readonly { days: number; label: string }[] = [
  { days: 0, label: "same day" },
  { days: 2, label: "2 days" },
  { days: 7, label: "1 week" },
];
export const BIRTHDAY_LEAD_DEFAULT_DAYS = 2;
