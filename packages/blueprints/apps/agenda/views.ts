// Pure derivations, so `views.test.ts` asserts product rules directly. The
// grid is only for things with a time cost: day context decorates, never rows.

import type { BandDestination } from "../_shared/shelves.ts";
import {
  civilMidnight,
  DAY_MS,
  localDayKey,
  namedDay,
  spanLocalDays,
  startOfDay,
  startOfWeek,
} from "./format.ts";
import type { AgEvent, DaySegment, LaidSegment, ViewKind } from "./types.ts";
import { BAND_SEARCH, VIEW_LABELS } from "./view-copy.ts";

export const VIEWS: readonly ViewKind[] = [
  "month",
  "week",
  "day",
  "schedule",
  "waiting",
];

export const POINTER_VIEWS: readonly ViewKind[] = VIEWS;

/** Month and Week absent BY TYPE: 7 columns at 390px are unreadable. */
export type TouchView = "day" | "schedule" | "waiting";

export const TOUCH_VIEWS: readonly TouchView[] = ["day", "schedule", "waiting"];

export function resolveView(view: ViewKind, touch: boolean): ViewKind {
  if (touch) return view === "month" || view === "week" ? "day" : view;
  return view;
}

/** Not a view: `appBar` withdraws the bar's Search on compact because the band
 *  carries this. */
export const BAND_SEARCH_ID = "search";

const BAND_ICONS: Readonly<Record<TouchView, string>> = {
  day: "Clock",
  schedule: "List",
  waiting: "Users",
};

/** ONE table, both seats; four plus More is the cap. */
export const BAND_DESTINATIONS: readonly BandDestination[] = [
  ...TOUCH_VIEWS.map((view) => ({
    id: view,
    label: VIEW_LABELS[view],
    icon: BAND_ICONS[view],
  })),
  { id: BAND_SEARCH_ID, label: BAND_SEARCH, icon: "Search" },
];

export function bandActiveId(view: ViewKind): string | undefined {
  return BAND_DESTINATIONS.some((dest) => dest.id === view) ? view : undefined;
}

export function defaultView(touch: boolean, knob?: string): ViewKind {
  if (touch) return "day";
  return VIEWS.includes(knob as ViewKind) ? (knob as ViewKind) : "month";
}

/** Minutes from day start: NOW today, working morning otherwise, never 0. */
export const GRID_OPEN_HOUR = 8;
export function nowAnchor(anchorDay: Date, now: Date = new Date()): number {
  const sameDay = localDayKey(anchorDay) === localDayKey(now);
  if (!sameDay) return GRID_OPEN_HOUR * 60;
  // An hour of context above the line; hour zero keeps its rail.
  return Math.max(0, now.getHours() * 60 + now.getMinutes() - 60);
}

/** Null off this day: the now line draws on one column only. */
export function nowLineMinutes(
  dayKey: string,
  now: Date = new Date()
): number | null {
  if (localDayKey(now) !== dayKey) return null;
  return now.getHours() * 60 + now.getMinutes();
}

export function monthGridRange(d: Date): { from: string; to: string } {
  const gridStart = startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1));
  const gridEnd = new Date(
    gridStart.getFullYear(),
    gridStart.getMonth(),
    gridStart.getDate() + 42
  );
  return { from: gridStart.toISOString(), to: gridEnd.toISOString() };
}

export function weekRange(d: Date): { from: string; to: string } {
  const start = startOfWeek(d);
  const end = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 7
  );
  return { from: start.toISOString(), to: end.toISOString() };
}

export function dayRange(d: Date): { from: string; to: string } {
  const start = startOfDay(d);
  const end = new Date(start.getTime() + DAY_MS);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Bounded windows only; forward lists name `from`, query owns the cap. */
export function rangeForView(
  view: ViewKind,
  anchor: Date
): { from: string; to?: string } {
  if (view === "month") return monthGridRange(anchor);
  if (view === "week") return weekRange(anchor);
  if (view === "day") return dayRange(anchor);
  return { from: startOfDay(anchor).toISOString() };
}

export function monthGridDays(anchor: Date): string[] {
  const start = startOfWeek(
    new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  );
  return Array.from({ length: 42 }, (_, index) =>
    localDayKey(
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    )
  );
}

export function weekDays(anchor: Date): string[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) =>
    localDayKey(
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    )
  );
}

/** The vault decides; a day-long timed event is still timed. */
export function isAllDay(ev: AgEvent): boolean {
  return ev.recurrence_semantics === "all-day";
}

/** All-day civil `dtend` is inclusive; timed `dtend` is the end instant.
 *  `clamped` means the run continues past midnight. */
export function bucketByDay(
  list: readonly AgEvent[]
): Map<string, DaySegment[]> {
  const map = new Map<string, DaySegment[]>();
  for (const ev of list) {
    const civilStart =
      isAllDay(ev) && !ev.dtstart.includes("T") ? namedDay(ev.dtstart) : null;
    const start = civilStart ? civilMidnight(civilStart) : new Date(ev.dtstart);
    if (Number.isNaN(start.getTime())) continue;
    const civilEnd =
      isAllDay(ev) && ev.dtend && !ev.dtend.includes("T")
        ? namedDay(ev.dtend)
        : null;
    let end = civilEnd
      ? new Date(civilMidnight(civilEnd).getTime() + DAY_MS)
      : ev.dtend
        ? new Date(ev.dtend)
        : start;
    if (Number.isNaN(end.getTime()) || end < start) end = start;
    const eventStart = start.getTime();
    const eventEnd = end.getTime();
    for (const cursor of spanLocalDays(start, end)) {
      const dayStart = cursor.getTime();
      const next = new Date(
        cursor.getFullYear(),
        cursor.getMonth(),
        cursor.getDate() + 1
      );
      const dayEnd = next.getTime();
      const key = localDayKey(cursor);
      const segment: DaySegment = {
        ev,
        segStart: Math.max(eventStart, dayStart),
        segEnd: Math.min(eventEnd, dayEnd),
        startsHere: eventStart >= dayStart && eventStart < dayEnd,
        endsHere: eventEnd <= dayEnd,
        spansAll:
          isAllDay(ev) || (eventStart <= dayStart && eventEnd >= dayEnd),
        clamped: eventEnd > dayEnd,
      };
      const bucket = map.get(key);
      if (bucket) bucket.push(segment);
      else map.set(key, [segment]);
    }
  }
  for (const bucket of map.values())
    bucket.sort((a, b) => a.segStart - b.segStart);
  return map;
}

/** The rail sits above the grid: a whole-day fact has no position. */
export function splitDay(segments: readonly DaySegment[]): {
  allDay: DaySegment[];
  timed: DaySegment[];
} {
  return {
    allDay: segments.filter((segment) => segment.spansAll),
    timed: segments.filter((segment) => !segment.spansAll),
  };
}

export function layoutDay(items: readonly DaySegment[]): LaidSegment[] {
  const colEnds: number[] = [];
  let cluster: LaidSegment[] = [];
  let clusterEnd = -1;
  const placed: LaidSegment[] = [];
  const flush = (): void => {
    for (const member of cluster) member.width = colEnds.length;
    cluster = [];
    colEnds.length = 0;
  };
  for (const item of items) {
    if (cluster.length > 0 && item.segStart >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= item.segStart);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(item.segEnd);
    } else colEnds[col] = item.segEnd;
    const laid: LaidSegment = { ...item, col, width: 0 };
    cluster.push(laid);
    placed.push(laid);
    clusterEnd = Math.max(clusterEnd, item.segEnd);
  }
  flush();
  return placed;
}

export function segmentBox(segment: DaySegment): {
  top: number;
  height: number;
} {
  const dayStart = startOfDay(new Date(segment.segStart)).getTime();
  const top = ((segment.segStart - dayStart) / DAY_MS) * 100;
  const raw = ((segment.segEnd - segment.segStart) / DAY_MS) * 100;
  // A zero-length event needs a 20-minute floor.
  return { top, height: Math.max(raw, (20 / (24 * 60)) * 100) };
}

export function visibleEvents(
  list: readonly AgEvent[] | null | undefined,
  hidden: ReadonlySet<string>
): AgEvent[] {
  return (list ?? []).filter(
    (ev) => !ev.calendar_id || !hidden.has(ev.calendar_id)
  );
}

/** Owner's PARTSTAT still `needs-action`. */
export function waitingOn(list: readonly AgEvent[]): AgEvent[] {
  return list.filter((ev) =>
    (ev.attendees ?? []).some(
      (guest) => guest.is_you === true && isUnanswered(guest.partstat)
    )
  );
}

export function isUnanswered(partstat: string | undefined): boolean {
  return (
    partstat === undefined || partstat === "" || partstat === "needs-action"
  );
}

export function myAttendance(
  ev: AgEvent
): { party_id: string; partstat: string } | null {
  const mine = (ev.attendees ?? []).find((guest) => guest.is_you === true);
  return mine ? { party_id: mine.party_id, partstat: mine.partstat } : null;
}

/** Occurrences stay addressable despite one `event_id`. */
export function rowKey(ev: AgEvent): string {
  return ev.instance_key ?? ev.event_id;
}

export function findEvent(
  list: readonly AgEvent[],
  identity: string
): AgEvent | null {
  return (
    list.find((ev) => rowKey(ev) === identity) ??
    list.find((ev) => ev.event_id === identity) ??
    null
  );
}
