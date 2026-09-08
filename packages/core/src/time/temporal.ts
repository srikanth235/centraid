// TEMPORAL MEANING IS VALIDATED AT THE BOUNDARY (#996, ruling R21, drift
// ONT-31).
//
// `schedule.add_task` accepted `due_at: "banana"`. The row stored, the reader
// found a due date it could not parse, and completion then had nothing to
// advance — an unparseable instant is indistinguishable from no instant at
// read time, so the task simply stopped recurring and nothing said why.
//
// The four readings a vault column may carry are named here, once, and every
// writer asks this module which one it is holding:
//
//   instant            2026-03-01T09:00:00Z / +05:30 — a point on the line
//   floating-datetime  2026-03-01T09:00 — a wall clock with no zone
//   local-date         2026-03-01 — a whole day
//   month-day          02-29 — a yearless anniversary
//
// The calendar is checked, not just the shape: February 31 is refused for
// every reading, and February 29 is accepted as a month-day (an anniversary
// has no year to be non-leap in) while `2027-02-29` is not.

export type TemporalKind =
  | "instant"
  | "floating-datetime"
  | "local-date"
  | "month-day";

const DATE_TIME =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hour>\d{2}):(?<minute>\d{2})(?::(?<second>\d{2})(?:\.\d{1,9})?)?(?<zone>Z|[+-]\d{2}:\d{2})?$/u;
const DATE_ONLY = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;
const MONTH_DAY = /^(?<month>\d{2})-(?<day>\d{2})$/u;

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** A real day of a real month — the check "February 31" fails and the shape
 *  check does not. `year === null` is a yearless anniversary, where the 29th
 *  of February is always real. */
function isRealDate(year: number | null, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const limit =
    month === 2 && year !== null && !isLeapYear(year)
      ? 28
      : DAYS_IN_MONTH[month - 1]!;
  return day <= limit;
}

function isClockTime(hour: number, minute: number, second: number): boolean {
  return hour <= 23 && minute <= 59 && second <= 59;
}

/**
 * Which of the four readings `value` carries, or `null` when it carries none.
 * The one place a temporal string is judged; every entry point calls it rather
 * than writing its own regular expression.
 */
export function classifyTemporal(value: string): TemporalKind | null {
  const dateTime = DATE_TIME.exec(value);
  if (dateTime?.groups) {
    const g = dateTime.groups;
    const year = Number(g.year);
    if (!isRealDate(year, Number(g.month), Number(g.day))) return null;
    if (
      !isClockTime(Number(g.hour), Number(g.minute), Number(g.second ?? "0"))
    ) {
      return null;
    }
    return g.zone === undefined ? "floating-datetime" : "instant";
  }
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly?.groups) {
    const g = dateOnly.groups;
    return isRealDate(Number(g.year), Number(g.month), Number(g.day))
      ? "local-date"
      : null;
  }
  const monthDay = MONTH_DAY.exec(value);
  if (monthDay?.groups) {
    const g = monthDay.groups;
    return isRealDate(null, Number(g.month), Number(g.day))
      ? "month-day"
      : null;
  }
  return null;
}

/** True when `value` reads as one of `allowed`. */
export function isTemporal(
  value: string,
  allowed: readonly TemporalKind[]
): boolean {
  const kind = classifyTemporal(value);
  return kind !== null && allowed.includes(kind);
}

const KIND_SENTENCE: Readonly<Record<TemporalKind, string>> = {
  instant: "an instant (2026-03-01T09:00:00Z)",
  "floating-datetime": "a floating local time (2026-03-01T09:00)",
  "local-date": "a date (2026-03-01)",
  "month-day": "a month and day (02-29)",
};

/**
 * The owner-facing refusal. It says what arrived and what the field takes,
 * because "invalid date" is the sentence that made ONT-31 survive three
 * releases.
 */
export function temporalRefusal(
  field: string,
  value: string,
  allowed: readonly TemporalKind[]
): string {
  const wanted = allowed.map((kind) => KIND_SENTENCE[kind]).join(", or ");
  return `${field}: ${JSON.stringify(value)} is not a time this vault can read — ${field} takes ${wanted}.`;
}
