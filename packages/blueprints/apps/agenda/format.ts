// Pure, JSX-free projections. Numeric strings are painted inside `.num`;
// `unicode-bidi: isolate` is a property of the box, not the string.

import { identityColor } from "@centraid/design";
import { localDayKey } from "@centraid/design/elements";

import type { AgEvent, Calendar } from "./types.ts";
import { UNTITLED } from "./view-copy.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

export function toIsoUtc(local: string): string {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function toLocalInput(dateish: string | number | Date): string {
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// `locale` is an optional last argument so option bags can be pinned against a
// NAMED locale in tests, not the machine's ICU default (`format-locale.test.ts`, #839).

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

export function fmtDay(key: string, locale?: Intl.LocalesArgument): string {
  if (key === localDayKey(new Date())) return "Today";
  try {
    return new Date(`${key}T00:00:00`).toLocaleDateString(locale, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  } catch {
    return key;
  }
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

export { localDayKey } from "@centraid/design/elements";
