// Cron tz resolution (#570): trigger tz → gateway pref → host-local; never
// hardcode geography. DST (docs/cron-timezone.md): spring-forward gaps never
// fire; fall-back overlap fires each wall-clock minute once.

import { isIanaTimeZone, wallWeekday, zonedParts } from "@centraid/core/time";

/** Gateway-wide default cron timezone pref key. */
export const CRON_DEFAULT_TIMEZONE_PREF = "automation.cron.defaultTimezone";

export type WallClockFields = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday … 6 = Saturday. */
  readonly weekday: number;
};

/** Non-empty IANA zone this runtime's `Intl` knows. */
export function isValidIanaTimeZone(name: string): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  return isIanaTimeZone(trimmed);
}

/** `undefined` = legacy host-local. */
export function resolveCronTimezone(
  triggerTz?: string | null,
  gatewayDefaultTz?: string | null
): string | undefined {
  for (const candidate of [triggerTz, gatewayDefaultTz]) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    if (isValidIanaTimeZone(trimmed)) return trimmed;
  }
  return undefined;
}

/** Absent tz keeps Date getters — byte-identical to pre-#570 matching. */
export function wallClockFields(
  date: Date,
  timeZone?: string
): WallClockFields {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      weekday: date.getDay(),
    };
  }
  const parts = zonedParts(date, timeZone);
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    weekday: wallWeekday(parts),
  };
}

/** DST dedupe key. */
export function wallClockMinuteKey(date: Date, timeZone?: string): string {
  const w = wallClockFields(date, timeZone);
  return [w.year, w.month, w.day, w.hour, w.minute, timeZone ?? "local"].join(
    ":"
  );
}
