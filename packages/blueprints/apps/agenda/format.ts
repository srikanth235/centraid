// Pure, JSX-free projections: time and date text, the local-input round trip,
// the calendar hue dot, and the FTS snippet split. No app state and no vault
// IO, so the orchestrator and the components can both call these without a
// circular import.
//
// NUMERICS. Every string here that a member reads as a NUMBER — a time, an
// hour label, a day number — is rendered inside an element carrying the
// tabular/bidi-isolate pair (`.num` in the component stylesheets). The text is
// produced here; the isolation is applied where it is painted, because
// `unicode-bidi: isolate` is a property of the box, not of the string.

import { identityColor } from "@centraid/design";
import { localDayKey } from "@centraid/design/elements";

import type { AgEvent, Calendar } from "./types.ts";
import { UNTITLED } from "./view-copy.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HOUR_MS = 60 * 60 * 1000;

/** A datetime-local value ("YYYY-MM-DDTHH:MM", viewer's zone) as an instant. */
export function toIsoUtc(local: string): string {
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

/** An instant as the value a datetime-local input wants, in local time. */
export function toLocalInput(dateish: string | number | Date): string {
  const d = dateish instanceof Date ? dateish : new Date(dateish);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtTime(iso: string | number | Date): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return String(iso);
  }
}

/** An hour of the day as the grid's rail label ("09", "14"). */
export function fmtHour(hour: number): string {
  return new Date(2000, 0, 1, hour).toLocaleTimeString(undefined, {
    hour: "numeric",
  });
}

export function fmtDay(key: string): string {
  if (key === localDayKey(new Date())) return "Today";
  try {
    return new Date(`${key}T00:00:00`).toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
  } catch {
    return key;
  }
}

/** The heading over whichever range the current view is showing. */
export function rangeLabel(view: string, anchor: Date): string {
  if (view === "week") {
    const start = startOfWeek(anchor);
    const end = new Date(
      start.getFullYear(),
      start.getMonth(),
      start.getDate() + 6
    );
    const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
    return `${start.toLocaleDateString(undefined, opts)} – ${end.toLocaleDateString(undefined, { ...opts, year: "numeric" })}`;
  }
  if (view === "day") {
    return anchor.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }
  return anchor.toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
  });
}

/** Monday on or before `d` — every grid here is Monday-first. */
export function startOfWeek(d: Date): Date {
  const back = (d.getDay() + 6) % 7;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
}

/** Midnight of `d`, local. */
export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
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

/** What a row reads as. A vault summary can be empty; a row still has a name. */
export function eventTitle(ev: AgEvent): string {
  const summary = String(ev.summary ?? "").trim();
  return summary === "" ? UNTITLED : summary;
}

/**
 * The calendar's hue dot — a CONTENT MARKER and never a control colour.
 *
 * A calendar that carries its own colour keeps it; everything else takes a
 * slot on the shared identity wheel, the same deterministic deriver People
 * and the launcher read, so two surfaces cannot disagree about which hue a
 * calendar has. There is no app-local palette here on purpose: a hash table
 * of hex literals in an app is how the product grows a second palette.
 */
export function calendarHue(
  calendar: Calendar | undefined,
  calendarId: string | null | undefined
): string | null {
  if (calendar?.color) return calendar.color;
  if (!calendarId) return null;
  return identityColor(calendarId);
}

/** Split a vault FTS `⟦hit⟧`-marked snippet into `[{ text, hit }]` segments. */
export function snippetSegments(
  snippet: string | null | undefined
): { text: string; hit: boolean }[] {
  return String(snippet ?? "")
    .split(/[⟦⟧]/u)
    .map((text, index) => ({ text, hit: index % 2 === 1 }))
    .filter((segment) => segment.text !== "");
}

export { localDayKey };
