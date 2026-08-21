// The view layer's pure derivations: which views a surface offers, the range
// each one reads, where a grid lands when it opens, how an event is bucketed
// into the day it is drawn on, and how one day's overlaps are laid out.
//
// Everything here is a plain function of its arguments so `views.test.ts` can
// assert the product rules directly rather than through a rendered tree. The
// three rules this module carries:
//
//   1. OPENING A GRID LANDS AT NOW, not at midnight, and the anchor recomputes
//      when the view or the day changes (`nowAnchor`).
//   2. THE GRID IS FOR THINGS WITH A TIME COST. Nothing costless is turned
//      into a segment here; day context arrives as a decoration around the
//      grid, never as a row inside it.
//   3. A MULTI-DAY OR ZONE-CROSSING EVENT IS ONE DAY'S ROW in v1, clamped and
//      marked, rather than a bar spanning columns (`bucketByDay`).

import { localDayKey, startOfDay, startOfWeek, DAY_MS } from "./format.ts";
import type { AgEvent, DaySegment, LaidSegment, ViewKind } from "./types.ts";

/** Every view, in the order the switcher draws them. */
export const VIEWS: readonly ViewKind[] = [
  "month",
  "week",
  "day",
  "schedule",
  "waiting",
];

/** The views a POINTER surface offers. All five. */
export const POINTER_VIEWS: readonly ViewKind[] = VIEWS;

/**
 * The views a TOUCH surface offers, and the four the band claims.
 *
 * Month and Week fall back to Day: a 7-column grid at 390px is a grid nobody
 * can read, and the fallback is a real answer rather than a squeezed one.
 * Waiting on is a band destination here, which is exactly the inverse of the
 * pointer surface, where it falls back to Schedule.
 */
export const TOUCH_VIEWS: readonly ViewKind[] = [
  "day",
  "schedule",
  "waiting",
  "month",
];

/** The view actually shown, given what the surface can draw. */
export function resolveView(view: ViewKind, touch: boolean): ViewKind {
  if (touch) return view === "month" || view === "week" ? "day" : view;
  return view;
}

/** The default view for a surface before the member has chosen one. */
export function defaultView(touch: boolean, knob?: string): ViewKind {
  if (touch) return "day";
  return VIEWS.includes(knob as ViewKind) ? (knob as ViewKind) : "month";
}

/**
 * Where a grid scrolls to when it opens: NOW when the anchor day is today,
 * and the working morning otherwise — never midnight, which is the one hour
 * of the day nobody is looking for.
 *
 * Returned in minutes from the day's start so the caller can turn it into a
 * pixel offset at whatever row height it is drawing.
 */
export const GRID_OPEN_HOUR = 8;
export function nowAnchor(anchorDay: Date, now: Date = new Date()): number {
  const sameDay = localDayKey(anchorDay) === localDayKey(now);
  if (!sameDay) return GRID_OPEN_HOUR * 60;
  // A whole hour of context above the line, clamped so the first hour of the
  // day still shows the rail above it.
  return Math.max(0, now.getHours() * 60 + now.getMinutes() - 60);
}

/** Minutes from midnight to `now`, or null when `now` is not on this day —
 *  the now line is drawn on exactly one column, never on all of them. */
export function nowLineMinutes(
  dayKey: string,
  now: Date = new Date()
): number | null {
  if (localDayKey(now) !== dayKey) return null;
  return now.getHours() * 60 + now.getMinutes();
}

/** The 6×7 Monday-first grid range around `d`'s month. */
export function monthGridRange(d: Date): { from: string; to: string } {
  const gridStart = startOfWeek(new Date(d.getFullYear(), d.getMonth(), 1));
  const gridEnd = new Date(
    gridStart.getFullYear(),
    gridStart.getMonth(),
    gridStart.getDate() + 42
  );
  return { from: gridStart.toISOString(), to: gridEnd.toISOString() };
}

/** The Monday-first 7-day range around `d`. */
export function weekRange(d: Date): { from: string; to: string } {
  const start = startOfWeek(d);
  const end = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate() + 7
  );
  return { from: start.toISOString(), to: end.toISOString() };
}

/** One local day. */
export function dayRange(d: Date): { from: string; to: string } {
  const start = startOfDay(d);
  const end = new Date(start.getTime() + DAY_MS);
  return { from: start.toISOString(), to: end.toISOString() };
}

/**
 * The bounded window each view reads. Schedule and Waiting on are forward
 * lists, so they name a `from` and let the query apply its own forward cap —
 * an unbounded read here would be the growth assumption the constitution
 * forbids, and the query is where that ceiling is already decided.
 */
export function rangeForView(
  view: ViewKind,
  anchor: Date
): { from: string; to?: string } {
  if (view === "month") return monthGridRange(anchor);
  if (view === "week") return weekRange(anchor);
  if (view === "day") return dayRange(anchor);
  return { from: startOfDay(anchor).toISOString() };
}

/** The 42 days a month grid draws, as local day keys. */
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

/** The 7 days a week grid draws, as local day keys. */
export function weekDays(anchor: Date): string[] {
  const start = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) =>
    localDayKey(
      new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    )
  );
}

/** Is this event an all-day one? The vault says so through its recurrence
 *  semantics; a timed event that happens to fill a day is still timed. */
export function isAllDay(ev: AgEvent): boolean {
  return ev.recurrence_semantics === "all-day";
}

/**
 * Bucket each event into the ONE local day it is drawn on, with its span
 * clamped to that day.
 *
 * V1 BOUND, DELIBERATE (spec §"What is left"): a multi-day event, and an
 * event whose start and end sit in different zones, is drawn as a single-day
 * row on the day it starts rather than as a bar reaching across columns. The
 * `clamped` flag is how the row says so in words. Growing this into a real
 * spanning layout changes the week grid's geometry, the month cell's overflow
 * rule and the schedule's grouping all at once, which is a design decision
 * and not an implementation detail.
 */
export function bucketByDay(
  list: readonly AgEvent[]
): Map<string, DaySegment[]> {
  const map = new Map<string, DaySegment[]>();
  for (const ev of list) {
    const start = new Date(ev.dtstart);
    if (Number.isNaN(start.getTime())) continue;
    let end = ev.dtend ? new Date(ev.dtend) : start;
    if (Number.isNaN(end.getTime()) || end < start) end = start;
    const key = localDayKey(start);
    const dayStart = startOfDay(start).getTime();
    const dayEnd = dayStart + DAY_MS;
    const segment: DaySegment = {
      ev,
      segStart: Math.max(start.getTime(), dayStart),
      segEnd: Math.min(end.getTime(), dayEnd),
      startsHere: true,
      endsHere: end.getTime() <= dayEnd,
      spansAll:
        isAllDay(ev) ||
        (start.getTime() <= dayStart && end.getTime() >= dayEnd),
      clamped: end.getTime() > dayEnd,
    };
    const bucket = map.get(key);
    if (bucket) bucket.push(segment);
    else map.set(key, [segment]);
  }
  for (const bucket of map.values())
    bucket.sort((a, b) => a.segStart - b.segStart);
  return map;
}

/** A day's segments split into the all-day rail and the timed grid. The rail
 *  is above the grid because a whole-day fact has no position inside it. */
export function splitDay(segments: readonly DaySegment[]): {
  allDay: DaySegment[];
  timed: DaySegment[];
} {
  return {
    allDay: segments.filter((segment) => segment.spansAll),
    timed: segments.filter((segment) => !segment.spansAll),
  };
}

/**
 * Assign overlapping segments of one day to side-by-side columns: greedy
 * first-fit inside each overlap cluster, every member of the cluster split
 * evenly.
 */
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

/** A segment's position inside a day column, as two percentages of the day. */
export function segmentBox(segment: DaySegment): {
  top: number;
  height: number;
} {
  const dayStart = startOfDay(new Date(segment.segStart)).getTime();
  const top = ((segment.segStart - dayStart) / DAY_MS) * 100;
  const raw = ((segment.segEnd - segment.segStart) / DAY_MS) * 100;
  // A zero-length event still has to be readable, so the box has a floor of
  // roughly twenty minutes rather than collapsing to a hairline.
  return { top, height: Math.max(raw, (20 / (24 * 60)) * 100) };
}

/** Events the member has not hidden by unticking their calendar. */
export function visibleEvents(
  list: readonly AgEvent[] | null | undefined,
  hidden: ReadonlySet<string>
): AgEvent[] {
  return (list ?? []).filter(
    (ev) => !ev.calendar_id || !hidden.has(ev.calendar_id)
  );
}

/**
 * WAITING ON: the invitations and unanswered RSVPs — every event where the
 * owner is a guest whose PARTSTAT is still `needs-action`.
 *
 * It reads the same rows the grid does; there is no second store and no second
 * read. What makes it a view rather than a filter chip is that "who is waiting
 * on me" is a different question from "what is my week", and the answer is a
 * list of decisions rather than a shape of time.
 */
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

/** The owner's own guest row on an event, if they are on the guest list. */
export function myAttendance(
  ev: AgEvent
): { party_id: string; partstat: string } | null {
  const mine = (ev.attendees ?? []).find((guest) => guest.is_you === true);
  return mine ? { party_id: mine.party_id, partstat: mine.partstat } : null;
}

/** The identity a row is keyed and selected by — an occurrence is addressable
 *  even though every occurrence shares the series' `event_id`. */
export function rowKey(ev: AgEvent): string {
  return ev.instance_key ?? ev.event_id;
}

/** Find a row by the identity `rowKey` produced, falling back to the series. */
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
