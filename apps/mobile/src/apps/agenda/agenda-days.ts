// Native Agenda's day list: one row per local civil day an event occupies.
//
// The web grid walks `spanLocalDays` inside `bucketByDay`. The phone cannot
// import that renderer, so it walks the SAME interval helper and groups the
// replica occurrences itself. Grouping by `event.start`'s date alone drops
// Saturday from a Friday–Sunday run — the S2 hole this module exists to close.

import {
  civilMidnight,
  DAY_MS,
  namedDay,
  spanLocalDays,
} from "@centraid/blueprints/apps/agenda/format";

import { dayKeyOf } from "./day-context";

export interface AgendaDayBucket<T> {
  key: string;
  date: Date;
  events: T[];
}

function intervalOf(event: {
  start: string;
  end?: string;
  recurrenceSemantics?: string;
}): { start: Date; end: Date } | null {
  const allDay = event.recurrenceSemantics === "all-day";
  const civilStart =
    allDay && !event.start.includes("T") ? namedDay(event.start) : null;
  const start = civilStart ? civilMidnight(civilStart) : new Date(event.start);
  if (Number.isNaN(start.getTime())) return null;
  const civilEnd =
    allDay && event.end && !event.end.includes("T")
      ? namedDay(event.end)
      : null;
  let end = civilEnd
    ? new Date(civilMidnight(civilEnd).getTime() + DAY_MS)
    : event.end
      ? new Date(event.end)
      : start;
  if (Number.isNaN(end.getTime()) || end < start) end = start;
  return { start, end };
}

/** Local YYYY-MM-DD keys this occurrence occupies. */
export function daysSpannedByEvent(event: {
  start: string;
  end?: string;
  recurrenceSemantics?: string;
}): string[] {
  const interval = intervalOf(event);
  if (!interval) return [];
  return spanLocalDays(interval.start, interval.end).map(dayKeyOf);
}

/** Group occurrences onto every local day they occupy, earliest day first. */
export function groupEventsByLocalDay<
  T extends {
    start: string;
    end?: string;
    recurrenceSemantics?: string;
  },
>(events: readonly T[]): AgendaDayBucket<T>[] {
  const map = new Map<string, T[]>();
  for (const event of events) {
    for (const key of daysSpannedByEvent(event)) {
      const bucket = map.get(key);
      if (bucket) bucket.push(event);
      else map.set(key, [event]);
    }
  }
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, bucket]) => ({
      key,
      date: civilMidnight(key),
      events: bucket,
    }));
}
