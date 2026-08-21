// People's pure arithmetic: days, cadence, month-days and initials.
//
// Every screen in this app says the same three things about a person — how
// long since the last contact, whether that is past their cadence, and when a
// dated reminder next comes round — so the rules live here once. A view that
// re-derives "overdue" inline is how a roster row and a person screen end up
// disagreeing about the same person on the same day.
//
// THE OVERDUE RULE IS THE DASHBOARD QUERY'S, NOT A SECOND OPINION.
// `queries/dashboard.ts` keeps a person in Reconnect while
// `daysSince(last_contacted_at ?? created_at) - cadence_days >= 0`, so this
// module answers the same question with the same comparison. A client rule of
// `> cadence` would have made the roster and the Touch screen differ by
// exactly one day, every day, for every person.

const DAY = 86_400_000;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Whole days between an ISO timestamp and now; 0 for anything unparseable. */
export function daysSince(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return 0;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? 0 : Math.max(0, Math.floor((now - at) / DAY));
}

/**
 * How long a person has gone uncontacted. A person never contacted counts from
 * when they were added, so somebody added this morning reads as on track
 * rather than as infinitely overdue (the dashboard query's own fallback).
 */
export function daysSinceContact(
  person: { last_contacted_at?: string | null; created_at?: string | null },
  now = Date.now()
): number {
  return daysSince(person.last_contacted_at ?? person.created_at, now);
}

/** Is this person past their cadence? ZERO IS `Never` and is never overdue —
 *  the vault floors `cadence_days` at 0 and the dashboard query exempts the
 *  same number, so the guard below is the contract's own, not a defensive
 *  clamp. */
export function isOverdue(
  person: {
    cadence_days?: number | null;
    last_contacted_at?: string | null;
    created_at?: string | null;
  },
  now = Date.now()
): boolean {
  const cadence = Number(person.cadence_days ?? 0);
  if (!(cadence > 0)) return false;
  return daysSinceContact(person, now) - cadence >= 0;
}

/** `41 days`, `1 day`, `Today` — the row's meta slot and the cadence line. */
export function agoLabel(days: number): string {
  if (days <= 0) return "Today";
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** `every 30 days` — or `no cadence` at zero, which is what the `Never` chip
 *  writes. For a sub-line that already opened with a name. */
export function cadenceLabel(cadenceDays: number): string {
  const days = Math.max(0, Math.round(cadenceDays));
  if (days === 0) return "no cadence";
  return `every ${days} ${days === 1 ? "day" : "days"}`;
}

/** `4 March` from the vault's `MM-DD`; the raw value back if it is not one. */
export function monthDayLabel(monthDay: string): string {
  const [month, day] = String(monthDay).split("-").map(Number);
  const name = month && month >= 1 && month <= 12 ? MONTHS[month - 1] : null;
  return name && day ? `${day} ${name}` : String(monthDay);
}

/** Days to the next annual occurrence of an `MM-DD` (0 = today). Mirrors the
 *  dashboard query's `daysUntilMonthDay` so Upcoming orders the same way. */
export function daysUntilMonthDay(monthDay: string, now = Date.now()): number {
  const [month, day] = String(monthDay).split("-").map(Number);
  if (!month || !day) return Number.MAX_SAFE_INTEGER;
  const today = new Date(now);
  const midnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  );
  let next = new Date(today.getFullYear(), month - 1, day);
  if (next < midnight) next = new Date(today.getFullYear() + 1, month - 1, day);
  return Math.round((next.getTime() - midnight.getTime()) / DAY);
}

/** `in 4 days` / `Today` / `Tomorrow` — Upcoming's meta slot. */
export function inDaysLabel(days: number): string {
  if (days <= 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `in ${days} days`;
}

/** `41 days ago` / `Yesterday` / `Today` — a meta slot, from a timestamp. */
export function whenLabel(iso: string | null | undefined, now = Date.now()) {
  const days = daysSince(iso, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${agoLabel(days)} ago`;
}

/** `Every 30 days · last 41 days ago` — the hero's cadence line, in the
 *  handoff's own words, and `No cadence · last 41 days ago` at zero. The
 *  `last` half is lower-case because it continues the sentence the first half
 *  opened. */
export function cadenceLineLabel(
  cadenceDays: number,
  person: { last_contacted_at?: string | null; created_at?: string | null },
  now = Date.now()
): string {
  const days = Math.max(0, Math.round(cadenceDays));
  const since = daysSinceContact(person, now);
  const ago =
    since <= 0 ? "today" : since === 1 ? "yesterday" : `${agoLabel(since)} ago`;
  const every =
    days === 0 ? "No cadence" : `Every ${days} ${days === 1 ? "day" : "days"}`;
  return `${every} · last ${ago}`;
}

/**
 * WHAT THE SHARING PLANE SAYS ABOUT ONE PERSON, as the three states the ring
 * draws. `linked` is a tri-state on purpose (`queries/people.ts`): true and
 * false are the plane's answer, null is a denial, and `undefined` is a query
 * that never asked — the search shelf's rows carry no link facts at all. The
 * last two are the SAME state to a reader: unknown, which draws nothing.
 */
export function linkState(person: {
  linked?: boolean | null;
}): "linked" | "unlinked" | "unknown" {
  if (person.linked === true) return "linked";
  if (person.linked === false) return "unlinked";
  return "unknown";
}

/** Days left before a trashed person is purged; never negative. */
export function daysUntil(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return 0;
  const at = new Date(iso).getTime();
  return Number.isNaN(at) ? 0 : Math.max(0, Math.ceil((at - now) / DAY));
}
