// The one notification day context earns (#834): an inner-circle person's
// birthday. Starred is the whole permission model. Pure; `notifications-core.ts` schedules this.
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

export interface BirthdayPerson {
  partyId: string;
  name: string;
  /** `YYYY-MM-DD` or year-less `--MM-DD`. */
  birthDate: string;
  /** Owner starred them — the only reason a birthday notifies. */
  inner: boolean;
}

export interface BirthdayNotification {
  /** Stable per person per year — a re-run never notifies twice. */
  key: string;
  title: string;
  body: string;
  at: Date;
  day: string;
  partyId: string;
  url: string;
}

const DAY_MS = 86_400_000;
const HORIZON_DAYS = 400;
/** Local hour. A whole-day fact has no moment; 09:00 is when a member can act. */
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

export function monthDayOf(birthDate: string): string | null {
  if (birthDate.length < 5) return null;
  const tail = birthDate.slice(-5);
  return /^\d{2}-\d{2}$/u.test(tail) ? tail : null;
}

export function leadLabel(days: number): string {
  return (
    BIRTHDAY_LEADS.find((lead) => lead.days === days)?.label ?? `${days} days`
  );
}

/**
 * Next `MM-DD` on or after `from`. 29 February is absent in a non-leap year
 * rather than rounded onto 1 March.
 */
export function nextOccurrence(monthDay: string, from: Date): Date | null {
  const month = Number(monthDay.slice(0, 2)) - 1;
  const day = Number(monthDay.slice(3));
  for (const year of [from.getFullYear(), from.getFullYear() + 1]) {
    const candidate = new Date(year, month, day);
    // Rolled date (31 April → 1 May, 29 Feb → 1 Mar) is not this birthday.
    if (candidate.getMonth() !== month || candidate.getDate() !== day) continue;
    if (dayKeyOf(candidate) >= dayKeyOf(from)) return candidate;
  }
  return null;
}

/**
 * NEVER anyone but the inner circle. A lead that would land in the past is
 * dropped, not fired late.
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
