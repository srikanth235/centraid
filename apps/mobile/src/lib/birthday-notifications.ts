// The ONE notification day context earns (#834): an inner-circle person's
// birthday, at a lead the member chose, deep-linking to that person.
//
// WHY THIS ONE AND NOTHING ELSE. Existing ≠ visible ≠ notifying. A birthday is
// the rare fact that is worthless the day after and cannot be rescheduled, and
// the member has already said who matters by STARRING them — so the vault's
// starred flag is the whole permission model. Everyone else's birthday stays a
// ribbon on the day, and there is no notification for a due task, an overdue
// pile, a shared vault or anything that counts.
//
// Pure and I/O-free: which birthdays notify, when, and what the notification
// says are facts about the rows plus the clock plus the member's lead — so
// they are functions here, and `notifications-core.ts` is the shell that
// schedules whatever this returns.
import {
  BIRTHDAY_LEAD_DEFAULT_DAYS,
  BIRTHDAY_LEADS,
  birthdayNotificationBody,
  birthdayNotificationTitle,
} from "@centraid/blueprints/apps/agenda/day-context-copy";

export {
  BIRTHDAY_LEAD_DEFAULT_DAYS,
  BIRTHDAY_LEADS,
} from "@centraid/blueprints/apps/agenda/day-context-copy";

/** One person the phone may notify about. */
export interface BirthdayPerson {
  partyId: string;
  name: string;
  /** `YYYY-MM-DD` or the year-less `--MM-DD` the vault also writes. */
  birthDate: string;
  /** The owner starred them. The ONLY reason a birthday notifies. */
  inner: boolean;
}

/** One scheduled local notification, ready for `scheduleNotificationAsync`. */
export interface BirthdayNotification {
  /** Stable per person per year, so a re-run never notifies twice. */
  key: string;
  title: string;
  body: string;
  /** When the phone should show it — the member's lead ahead of the day. */
  at: Date;
  /** The birthday itself, `YYYY-MM-DD`. */
  day: string;
  partyId: string;
  /** The deep link the tap follows: the person, not a list. */
  url: string;
}

const DAY_MS = 86_400_000;
/** How far ahead the phone looks. A year covers every birthday exactly once,
 *  and the delivery ledger is what stops a second pass repeating one. */
const HORIZON_DAYS = 400;
/** The hour a birthday notification lands, local. Not midnight: a fact about
 *  a whole day has no moment, and 09:00 is when a member can act on it. */
const NOTIFY_HOUR = 9;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function dayKeyOf(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

/** The `MM-DD` a birth date recurs on, or null when it carries none. */
export function monthDayOf(birthDate: string): string | null {
  if (birthDate.length < 5) return null;
  const tail = birthDate.slice(-5);
  return /^\d{2}-\d{2}$/u.test(tail) ? tail : null;
}

/** The label for a lead in days, as the picker spells it. */
export function leadLabel(days: number): string {
  return (
    BIRTHDAY_LEADS.find((lead) => lead.days === days)?.label ?? `${days} days`
  );
}

/**
 * The next occurrence of an annual `MM-DD` on or after `from`, or null when
 * the date does not exist in either candidate year — a 29 February birthday is
 * simply absent in a non-leap year rather than silently rounded onto 1 March.
 */
export function nextOccurrence(monthDay: string, from: Date): Date | null {
  const month = Number(monthDay.slice(0, 2)) - 1;
  const day = Number(monthDay.slice(3));
  for (const year of [from.getFullYear(), from.getFullYear() + 1]) {
    const candidate = new Date(year, month, day);
    // A rolled date (31 April → 1 May, 29 Feb → 1 Mar) is not this birthday.
    if (candidate.getMonth() !== month || candidate.getDate() !== day) continue;
    if (dayKeyOf(candidate) >= dayKeyOf(from)) return candidate;
  }
  return null;
}

/**
 * What the phone should schedule.
 *
 * NEVER FOR ANYONE BUT THE INNER CIRCLE — the filter is the first line, and it
 * is the whole rule. A lead that would land in the past is dropped rather than
 * fired late: a reminder about a birthday that has already happened is noise,
 * and the ribbon on the day is what remains true.
 */
export function planBirthdayNotifications(input: {
  people: readonly BirthdayPerson[];
  leadDays?: number;
  now: Date;
  delivered?: ReadonlySet<string>;
}): BirthdayNotification[] {
  const leadDays = input.leadDays ?? BIRTHDAY_LEAD_DEFAULT_DAYS;
  const delivered = input.delivered ?? new Set<string>();
  const horizon = new Date(input.now.getTime() + HORIZON_DAYS * DAY_MS);
  const out: BirthdayNotification[] = [];
  for (const person of input.people) {
    if (!person.inner) continue;
    const monthDay = monthDayOf(person.birthDate);
    if (!monthDay) continue;
    const day = nextOccurrence(monthDay, input.now);
    if (!day || day > horizon) continue;
    const at = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate() - leadDays,
      NOTIFY_HOUR
    );
    if (at.getTime() <= input.now.getTime()) continue;
    const key = `birthday:${person.partyId}:${dayKeyOf(day)}`;
    if (delivered.has(key)) continue;
    out.push({
      at,
      body: birthdayNotificationBody(leadLabel(leadDays)),
      day: dayKeyOf(day),
      key,
      partyId: person.partyId,
      title: birthdayNotificationTitle(
        person.name,
        WEEKDAYS[day.getDay()] ?? ""
      ),
      url: `centraid://apps/people/${encodeURIComponent(person.partyId)}`,
    });
  }
  return out.sort((left, right) => left.at.getTime() - right.at.getTime());
}
