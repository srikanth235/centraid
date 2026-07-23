// Pure, JSX-free helpers: time/date formatting, range calculation for each
// view, multi-day bucketing, overlap-column layout for the week grid, and
// text-highlight segmentation. No app state, no vault IO — every function is
// a plain projection of its arguments so app.tsx and the components can both
// call them without a circular import.
import { localDayKey } from './kit.ts';
import type { AgEvent, Calendar, DaySegment, LaidSegment } from './types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- Time / date formatting ----------

export function toIsoUtc(local: string): string {
  // datetime-local gives "YYYY-MM-DDTHH:MM" in the viewer's zone.
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export function fmtDay(key: string): string {
  const today = localDayKey(new Date());
  if (key === today) return 'Today';
  try {
    return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return key;
  }
}

/** ISO or Date → the value a datetime-local input wants, in local time. */
export function toLocalInput(dateish: string | number | Date): string {
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "Thu, Jul 3 · 10:00 AM – 11:00 AM" (or spanning both dates). */
export function fmtRange(ev: { dtstart: string; dtend?: string | null }): string {
  const s = new Date(ev.dtstart);
  const e = ev.dtend ? new Date(ev.dtend) : null;
  const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  const sd = Number.isNaN(s.getTime()) ? String(ev.dtstart) : s.toLocaleDateString(undefined, opts);
  if (!e || Number.isNaN(e.getTime())) return `${sd} · ${fmtTime(ev.dtstart)}`;
  if (localDayKey(s) === localDayKey(e)) {
    return `${sd} · ${fmtTime(ev.dtstart)} – ${fmtTime(ev.dtend as string)}`;
  }
  return `${sd}, ${fmtTime(ev.dtstart)} – ${e.toLocaleDateString(undefined, opts)}, ${fmtTime(ev.dtend as string)}`;
}

/** Monday on or before the given day (every grid here is Monday-first). */
export function startOfWeek(d: Date): Date {
  const back = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

/** Now rounded up to the next :00/:30 — the composer's default start. */
export function nextHalfHour(): Date {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / 30) * 30 + 30);
  return d;
}

/** The clicked day at the next round hour of the current time. */
export function nextRoundHourOn(date: Date): Date {
  const now = new Date();
  const h = Math.min(
    now.getMinutes() > 0 || now.getSeconds() > 0 ? now.getHours() + 1 : now.getHours(),
    23,
  );
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, 0, 0, 0);
}

export function initials(name: string | null | undefined): string {
  return String(name ?? '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

// ---------- View ranges (the bounded reads each view needs) ----------

/** The 6×7 Monday-first grid range around `d`'s month. */
export function monthGridRange(d: Date): { from: string; to: string } {
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const gridStart = startOfWeek(first);
  const gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + 42);
  return { from: gridStart.toISOString(), to: gridEnd.toISOString() };
}

/** The Monday-first 7-day range around `d`'s week. */
export function weekRange(d: Date): { from: string; to: string } {
  const start = startOfWeek(d);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Midnight of `d`, as the schedule view's forward-looking `from`. */
export function scheduleFrom(d: Date): string {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).toISOString();
}

// ---------- Multi-day bucketing ----------

/**
 * Bucket every event into each local day it touches. Each entry carries the
 * segment clamped to that day so the week view can position it, plus flags
 * for "starts here", "ends here" and "covers the whole day". An event ending
 * exactly at midnight does not spill into the next day.
 */
export function bucketByDay(list: AgEvent[]): Map<string, DaySegment[]> {
  const map = new Map<string, DaySegment[]>();
  const push = (key: string, seg: DaySegment) => {
    let arr = map.get(key);
    if (!arr) {
      arr = [];
      map.set(key, arr);
    }
    arr.push(seg);
  };
  for (const ev of list) {
    const start = new Date(ev.dtstart);
    if (Number.isNaN(start.getTime())) {
      const key = String(ev.dtstart).slice(0, 10);
      push(key, { ev, segStart: 0, segEnd: 0, startsHere: true, endsHere: true, spansAll: false });
      continue;
    }
    let end = ev.dtend ? new Date(ev.dtend) : start;
    if (Number.isNaN(end.getTime()) || end < start) end = start;
    // `end` is an exclusive boundary (used for every day's spansAll/segEnd
    // math below, so a multi-day span's LAST day still resolves spansAll
    // correctly). `boundaryEnd` is a separate, presentation-only value that
    // decides which calendar day is "last": a 10pm–midnight single-evening
    // event belongs to one evening, not a zero-length sliver on the next
    // day, so when `end` lands exactly on midnight the loop terminates one
    // minute earlier — but that adjustment must never feed into the
    // per-day math above it, or a multi-day span's final day would lose its
    // spansAll flag by exactly the same minute.
    let boundaryEnd = end;
    if (end > start && end.getHours() === 0 && end.getMinutes() === 0 && end.getSeconds() === 0) {
      boundaryEnd = new Date(end.getTime() - 60000);
    }
    const lastKey = localDayKey(boundaryEnd);
    let d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    for (let guard = 0; guard < 62; guard += 1) {
      const key = localDayKey(d);
      const dayStart = d.getTime();
      const dayEnd = dayStart + DAY_MS;
      push(key, {
        ev,
        segStart: Math.max(start.getTime(), dayStart),
        segEnd: Math.min(end.getTime(), dayEnd),
        startsHere: key === localDayKey(start),
        endsHere: key === lastKey,
        spansAll: start.getTime() <= dayStart && end.getTime() >= dayEnd,
      });
      if (key === lastKey) break;
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    }
  }
  for (const l of map.values()) l.sort((a, b) => a.segStart - b.segStart);
  return map;
}

export function segTimeText(seg: DaySegment): string {
  if (seg.spansAll) return 'All day';
  if (seg.startsHere && seg.endsHere) {
    return `${fmtTime(seg.ev.dtstart)}${seg.ev.dtend ? `–${fmtTime(seg.ev.dtend)}` : ''}`;
  }
  if (seg.startsHere) return `${fmtTime(seg.ev.dtstart)} →`;
  return `→ ${fmtTime(new Date(seg.segEnd).toISOString())}`;
}

/**
 * Assign overlapping segments of one day to side-by-side columns: greedy
 * first-fit within each overlap cluster, every member split evenly.
 */
export function layoutDay(items: DaySegment[]): LaidSegment[] {
  const colEnds: number[] = [];
  let cluster: LaidSegment[] = [];
  let clusterEnd = -1;
  const placed: LaidSegment[] = [];
  const flush = () => {
    for (const p of cluster) p.width = colEnds.length;
    cluster = [];
    colEnds.length = 0;
  };
  for (const it of items) {
    if (cluster.length && it.segStart >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= it.segStart);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(it.segEnd);
    } else {
      colEnds[col] = it.segEnd;
    }
    const p: LaidSegment = { ...it, col, width: 0 };
    cluster.push(p);
    placed.push(p);
    clusterEnd = Math.max(clusterEnd, it.segEnd);
  }
  flush();
  return placed;
}

// ---------- Calendar colors ----------

// GCal-adjacent palette used when a calendar has no color of its own.
const PALETTE = [
  '#4285f4',
  '#0b8043',
  '#8e24aa',
  '#f4511e',
  '#f6bf26',
  '#039be5',
  '#d81b60',
  '#33b679',
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return ((h % PALETTE.length) + PALETTE.length) % PALETTE.length;
}

/** Stable calendar → color: the calendar's own color, else a palette hash. */
export function colorForCalendar(
  cal: Calendar | undefined,
  calendarId: string | null | undefined,
): string | null {
  if (cal?.color) return cal.color;
  if (!calendarId) return null;
  return PALETTE[hashStr(String(calendarId))]!;
}

// ---------- Text highlight segments ----------

/** Split a vault FTS `⟦hit⟧`-marked snippet into `[{ text, hit }]` segments. */
export function snippetSegments(
  snippet: string | null | undefined,
): { text: string; hit: boolean }[] {
  const parts = String(snippet ?? '').split(/[⟦⟧]/);
  return parts.map((text, i) => ({ text, hit: i % 2 === 1 })).filter((s) => s.text !== '');
}
