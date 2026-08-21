// A repeating task never stacks: at most one occurrence is ever live, and the
// periods that elapsed unactioned collapse into a count beside it
// ("missed 4 · next is Friday"). This is the one place that arithmetic lives —
// surfaces render `{missed, nextDue}`, they never re-derive it.

import { expandRecurrence, nextOccurrence } from "./recurrence.js";

/** Hard bound on the walk so a pathological rule cannot spin. */
const MAX_MISSED = 1000;

export interface CollapseMissedInput {
  rrule: string;
  /** The series' first due instant (ISO). */
  scheduledStart: string;
  timeZone?: string;
  anchor?: "scheduled" | "completion";
  /** The clock this collapse is evaluated against (ISO) — never `Date.now()`. */
  now: string;
  /** When the live occurrence was last completed, if ever (ISO). */
  lastCompletedAt?: string;
}

export interface CollapsedOccurrence {
  /**
   * Elapsed, unactioned periods. Capped at MAX_MISSED for a "scheduled"
   * anchor; never above 1 for "completion", which by definition cannot stack.
   */
  missed: number;
  /** The single live occurrence, or null when the series is exhausted. */
  nextDue: string | null;
}

function laterOf(left: string, right: string | undefined): string {
  if (right === undefined) return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(rightMs)) return left;
  return Number.isNaN(leftMs) || rightMs > leftMs ? right : left;
}

/**
 * Collapse a repeating series against `now`. "scheduled" counts every period
 * the schedule produced before `now` (minus any already completed) regardless
 * of completion; "completion" re-anchors on the last completion, so it is
 * overdue (1) or not (0) and can never accumulate.
 */
export function collapseMissedOccurrences(
  input: CollapseMissedInput
): CollapsedOccurrence {
  const anchor = input.anchor ?? "scheduled";
  const timeZone = input.timeZone ?? "Etc/UTC";
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) return { missed: 0, nextDue: null };

  if (anchor === "completion") {
    // Never completed: the original due is still the live one, overdue or not.
    const nextDue =
      input.lastCompletedAt === undefined
        ? input.scheduledStart
        : nextOccurrence({
            rrule: input.rrule,
            scheduledStart: input.scheduledStart,
            after: input.lastCompletedAt,
            timeZone,
            anchor: "completion",
          });
    if (nextDue === null) return { missed: 0, nextDue: null };
    const dueMs = Date.parse(nextDue);
    return {
      missed: !Number.isNaN(dueMs) && dueMs < nowMs ? 1 : 0,
      nextDue,
    };
  }

  // Occurrences in [start, now) are elapsed; anything completed is not missed.
  const from = laterOf(input.scheduledStart, input.lastCompletedAt);
  const elapsed =
    Date.parse(from) < nowMs
      ? expandRecurrence({
          rrule: input.rrule,
          start: input.scheduledStart,
          rangeFrom: from,
          rangeTo: input.now,
          timeZone,
          semantics: "zoned",
          maxInstances: MAX_MISSED,
        })
      : [];
  const lastCompletedMs = input.lastCompletedAt
    ? Date.parse(input.lastCompletedAt)
    : Number.NaN;
  const missed = elapsed.filter(
    (occurrence) =>
      Number.isNaN(lastCompletedMs) ||
      Date.parse(occurrence.start) > lastCompletedMs
  ).length;
  return {
    missed,
    nextDue: nextOccurrence({
      rrule: input.rrule,
      scheduledStart: input.scheduledStart,
      // nextOccurrence is strictly after its bound, and an occurrence landing
      // exactly on `now` is live rather than missed (the missed window is
      // half-open, [start, now)) — so ask from one millisecond earlier.
      after: new Date(nowMs - 1).toISOString(),
      timeZone,
      anchor: "scheduled",
    }),
  };
}
