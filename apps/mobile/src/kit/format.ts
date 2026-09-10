// THE ONE FORMATTER MODULE (#1015, S8).
//
// The audit found five date formats across nine surfaces — `dueLabel`'s
// relative register in Tasks, `editedAgo`'s in Docs, `formatRelativeTime`'s
// `3h ago` in the shell, and two hand-rolled `toLocaleDateString` calls with
// different option bags — plus two byte formatters that disagree about the
// unit word. None of those differences is a product difference; they are the
// sediment of eight app waves.
//
// The register here is **Tasks'**, because it is the only one that was
// designed rather than inherited: it says `today`, `tomorrow`,
// `yesterday`, a weekday inside the coming week, and a `4 Sep` date past it,
// and it is defined once in `@centraid/blueprints/apps/tasks/when` — which is
// the same module the web seat reads, so adopting it here removes a seam
// rather than adding a mobile-only one. `formatRelative` DELEGATES to
// `dueLabel`; it does not re-implement the register.
//
// What it adds is a finer grain for a stamp inside today, because "today" is
// not an answer to "when was this edited" — the phone shows edit stamps that
// are minutes old. That grain is Docs' (`moments ago`, `12 minutes ago`,
// `3 hours ago`), which is the only other register in the tree that carried
// information the day grain does not.
//
// Sentence case throughout (D2, #1015): these are clauses a caller composes
// into a line, never headings. A caller that wants a prefix — "edited …",
// "due …" — writes it, because the preposition belongs to the sentence and
// not to the clock.

import { MONTHS } from "@centraid/blueprints/apps/_shared/format-kit";
import { dueLabel, isDateOnly } from "@centraid/blueprints/apps/tasks/when";
import { formatBytes as sharedFormatBytes } from "@centraid/design";

/** One byte register for the whole seat: `@centraid/design`'s. */
export function formatBytes(value: number): string {
  return sharedFormatBytes(value);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * When something is, relative to now, in Tasks' register.
 *
 * `value` is an ISO instant or a date-only `YYYY-MM-DD`; `now` is an ISO
 * instant or a millisecond stamp. An unreadable stamp returns `""` — an
 * absent clause, never an invented one.
 */
export function formatRelative(
  value: string | null | undefined,
  now: string | number = Date.now()
): string {
  if (!value) return "";
  const at = Date.parse(isDateOnly(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(at)) return "";
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  if (Number.isNaN(nowMs)) return "";
  const nowIso = new Date(nowMs).toISOString();

  // The finer grain applies only BACKWARDS and only within the day: a stamp
  // an hour into the future is "today", not "in an hour" — the phone has no
  // surface that counts down to something later today.
  const delta = nowMs - at;
  if (!isDateOnly(value) && delta >= 0 && delta < HOUR_MS) {
    if (delta < MINUTE_MS) return "moments ago";
    const minutes = Math.floor(delta / MINUTE_MS);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  if (!isDateOnly(value) && delta > 0 && delta < 24 * HOUR_MS) {
    const day = dueLabel(value, nowIso);
    if (day?.startsWith("today")) {
      const hours = Math.floor(delta / HOUR_MS);
      return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
    }
  }
  return dueLabel(value, nowIso) ?? "";
}

/**
 * A date said in full, for the places a relative clause cannot serve — a
 * detail row, a column header, anything a member reads as a fact rather than
 * as news. `4 Sep`, and `4 Sep 2025` once the year is not the current one,
 * because a year that is always printed is a year nobody reads.
 */
export function formatDateShort(
  value: string | null | undefined,
  now: string | number = Date.now()
): string {
  if (!value) return "";
  const at = new Date(isDateOnly(value) ? `${value}T00:00:00` : value);
  if (Number.isNaN(at.getTime())) return "";
  const nowYear = new Date(typeof now === "number" ? now : Date.parse(now));
  const month = MONTHS[at.getMonth()]?.slice(0, 3) ?? "";
  const head = `${at.getDate()} ${month}`;
  return Number.isNaN(nowYear.getTime()) ||
    at.getFullYear() === nowYear.getFullYear()
    ? head
    : `${head} ${at.getFullYear()}`;
}

/**
 * A clock time, in the one spelling the seat uses: `5:00 PM` in a 12-hour
 * locale, `17:00` in a 24-hour one — hour and minute, and never seconds.
 *
 * The audit found one Agenda screen printing the same instant three ways at
 * once (`toLocaleString()`'s `10/09/2026, 5:00:00 PM` in the field, the
 * platform picker's `10 Sep 2026` / `17:00` under it, and `5:00 PM` on the
 * list behind it). An event has no seconds, and a field that prints them is
 * asserting a precision the vault does not hold.
 */
export function formatTime(value: Date | string | number): string {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

/** A day and a time together — `4 Sep, 5:00 PM`; the year appears only when
 *  it is not the current one, which is `formatDateShort`'s rule. */
export function formatDateTime(
  value: Date | string | number,
  now: string | number = Date.now()
): string {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  return `${formatDateShort(at.toISOString(), now)}, ${formatTime(at)}`;
}

/**
 * The month a run of days is in — `September`, and `September 2027` once it
 * is not this year. A 120-day list with no month heading turns September into
 * October in silence, which is what the audit read off the Schedule surface.
 */
export function formatMonth(
  value: Date | string | number,
  now: string | number = Date.now()
): string {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const nowAt = new Date(typeof now === "number" ? now : Date.parse(now));
  const month = MONTHS[at.getMonth()] ?? "";
  return !Number.isNaN(nowAt.getTime()) &&
    at.getFullYear() === nowAt.getFullYear()
    ? month
    : `${month} ${at.getFullYear()}`;
}
