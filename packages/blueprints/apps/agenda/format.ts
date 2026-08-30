// Pure, JSX-free projections. Numeric strings are painted inside `.num`;
// `unicode-bidi: isolate` is a property of the box, not the string.

import { identityColor } from "@centraid/design";

import { fmtDay as sharedFmtDay } from "../_shared/format-kit.ts";
import type { AgEvent, Calendar } from "./types.ts";
import { UNTITLED } from "./view-copy.ts";

// One day is the format kit's constant (#883 B4).
export { DAY_MS } from "../_shared/format-kit.ts";
export const HOUR_MS = 60 * 60 * 1000;

export function toIsoUtc(local: string): string {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

const CIVIL_DATE = /^(?<day>\d{4}-\d{2}-\d{2})/u;

export function namedDay(iso: string): string | null {
  return CIVIL_DATE.exec(iso)?.groups?.day ?? null;
}

/** Local midnight of a YYYY-MM-DD civil date — never UTC-parsed. */
export function civilMidnight(isoDate: string): Date {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Start/end as the vault stores them: a zoned instant plus the viewer's zone,
 * or a civil date for all-day so recurrence cannot slip a day off UTC+0.
 */
export function eventBounds(
  localStart: string,
  localEnd: string,
  allDay: boolean
): {
  dtstart: string;
  dtend: string;
  start_tz: string;
  recurrence_semantics: "all-day" | "zoned";
} {
  if (allDay) {
    return {
      dtstart: namedDay(localStart) ?? localStart.slice(0, 10),
      dtend: namedDay(localEnd) ?? localEnd.slice(0, 10),
      start_tz: viewerTimeZone(),
      recurrence_semantics: "all-day",
    };
  }
  return {
    dtstart: toIsoUtc(localStart),
    dtend: toIsoUtc(localEnd),
    start_tz: viewerTimeZone(),
    recurrence_semantics: "zoned",
  };
}

/** An instant as the value a datetime-local input wants, in local time. */
export function toLocalInput(dateish: string | number | Date): string {
  if (typeof dateish === "string") {
    const day = namedDay(dateish);
    if (day && !dateish.includes("T")) return `${day}T00:00`;
  }
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// `locale` is an optional last argument so option bags can be pinned against a
// named locale in tests, not the machine's ICU default (#839).

export function fmtTime(
  iso: string | number | Date,
  locale?: Intl.LocalesArgument
): string {
  try {
    return new Date(iso).toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

export function fmtHour(hour: number, locale?: Intl.LocalesArgument): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(locale, {
    hour: "numeric",
  });
}

/** The relative words are the kit's, so two apps cannot disagree about
 *  "Today" (#883). What stays here is the ABSOLUTE spelling. */
export function fmtDay(key: string, locale?: Intl.LocalesArgument): string {
  return sharedFmtDay(key, {
    absolute: { day: "numeric", month: "short", weekday: "long" },
    locale,
    undated: key,
  });
}

export function rangeLabel(
  view: string,
  anchor: Date,
  locale?: Intl.LocalesArgument
): string {
  if (view === "week") {
    const start = startOfWeek(anchor);
    const end = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + 6
    );
    const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    return `${start.toLocaleDateString(locale, opts)} – ${end.toLocaleDateString(locale, { ...opts, year: "numeric" })}`;
  }
  if (view === "day") {
    return anchor.toLocaleDateString(locale, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }
  return anchor.toLocaleDateString(locale, {
    month: "long",
    year: "numeric",
  });
}

/** Monday on or before `d` — every grid here is Monday-first. */
export function startOfWeek(d: Date): Date {
  const back = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Every local civil day an interval occupies; end is exclusive at a civil
 *  midnight and inclusive otherwise, so a multi-day run cannot vanish from the
 *  days in the middle. */
export function spanLocalDays(start: Date, end: Date): Date[] {
  if (Number.isNaN(start.getTime())) return [];
  let finish = end;
  if (Number.isNaN(finish.getTime()) || finish < start) finish = start;
  const days: Date[] = [];
  let cursor = startOfDay(start);
  do {
    days.push(new Date(cursor));
    cursor = new Date(
      cursor.getFullYear(),
      cursor.getMonth(),
      cursor.getDate() + 1
    );
  } while (cursor.getTime() < finish.getTime());
  return days;
}

/** The clicked day at the next round hour of the current time. */
export function nextRoundHourOn(date: Date): Date {
  const now = new Date();
  const hour = Math.min(
    now.getMinutes() > 0 || now.getSeconds() > 0
      ? now.getHours() + 1
      : now.getHours(),
    23
  );
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour);
}

export function eventTitle(ev: AgEvent): string {
  const summary = String(ev.summary ?? "").trim();
  return summary === "" ? UNTITLED : summary;
}

/** Content marker, never a control colour. No app-local palette. */
export function calendarHue(
  calendar: Calendar | undefined,
  calendarId: string | null | undefined
): string | null {
  if (calendar?.color) return calendar.color;
  if (!calendarId) return null;
  return identityColor(calendarId);
}

export function snippetSegments(
  snippet: string | null | undefined
): { text: string; hit: boolean }[] {
  return String(snippet ?? "")
    .split(/[⟦⟧]/u)
    .map((text, index) => ({ text, hit: index % 2 === 1 }))
    .filter((segment) => segment.text !== "");
}

// Token-layer `localDayKey`, not `@centraid/design/elements`: Metro pulls this
// file into the phone bundle, and the elements subpath is DOM-only / dist-only.
export { localDayKey } from "@centraid/design";
