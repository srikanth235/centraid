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

/**
 * What the shelf toggle IS, for a screen reader. Its visible word is a bare
 * count — "3 due" — which names no subject at all, and "Hide" once it is
 * open, which names no object (#1015 Wave 3, a11y). The state travels as
 * `accessibilityState.expanded`, so the name never says "hide" or "show".
 */
export const SHELF_A11Y = "Tasks due on this day";

export function birthdayNotificationTitle(
  name: string,
  weekday: string
): string {
  return `${name}’s birthday is on ${weekday}`;
}
/**
 * HOW FAR AHEAD, AS A PHRASE (#1015, ruling R-A-19).
 *
 * The label is what the sheet lists — "Same day", "2 days" — and the phrase is
 * what a sentence can hold. Gluing " ahead" onto the label produced "same day
 * ahead" in the notification body and "Inner circle · same day ahead" in the
 * More sheet, which is the one lead where "ahead" is exactly wrong.
 */
export function birthdayLeadPhrase(days: number): string {
  if (days === 0) return "on the day";
  const lead = BIRTHDAY_LEADS.find((entry) => entry.days === days);
  return `${lead ? lead.label.toLowerCase() : `${days} days`} ahead`;
}
export function birthdayNotificationBody(days: number): string {
  return `Inner circle · your phone tells you ${birthdayLeadPhrase(days)}.`;
}
export const BIRTHDAY_LEADS: readonly { days: number; label: string }[] = [
  { days: 0, label: "Same day" },
  { days: 2, label: "2 days" },
  { days: 7, label: "1 week" },
];
export const BIRTHDAY_LEAD_DEFAULT_DAYS = 2;
