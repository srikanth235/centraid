// A repeating task never stacks: unactioned periods collapse into a count.

import { expandRecurrence, nextOccurrence } from "./recurrence.js";

const MAX_MISSED = 1000;

export interface CollapseMissedInput {
  rrule: string;
  scheduledStart: string;
  timeZone?: string;
  anchor?: "scheduled" | "completion";
  /** The evaluation clock — never `Date.now()`. */
  now: string;
  lastCompletedAt?: string;
}

export interface CollapsedOccurrence {
  /** Capped at MAX_MISSED for "scheduled"; ≤1 for "completion". */
  missed: number;
  nextDue: string | null;
}

function laterOf(left: string, right: string | undefined): string {
  if (right === undefined) return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(rightMs)) return left;
  return Number.isNaN(leftMs) || rightMs > leftMs ? right : left;
}

export function collapseMissedOccurrences(
  input: CollapseMissedInput
): CollapsedOccurrence {
  const anchor = input.anchor ?? "scheduled";
  const timeZone = input.timeZone ?? "Etc/UTC";
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) return { missed: 0, nextDue: null };

  if (anchor === "completion") {
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

  // Occurrences in [start, now); anything completed is not missed.
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
      // Strictly-after bound + half-open window: an occurrence exactly on
      // `now` is live — ask from one ms earlier.
      after: new Date(nowMs - 1).toISOString(),
      timeZone,
      anchor: "scheduled",
    }),
  };
}
