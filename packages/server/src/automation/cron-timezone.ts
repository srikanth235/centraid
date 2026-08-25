/**
 * Cron timezone resolution and wall-clock field extraction (#570).
 *
 * Resolution tiers (n8n-shaped, host-local fallback — no hardcoded geography):
 *   1. per-trigger `tz` (IANA name on the cron trigger)
 *   2. gateway-wide default (`automation.cron.defaultTimezone` pref)
 *   3. host-local (process wall clock)
 *
 * DST policy (documented in `docs/cron-timezone.md`):
 *   - Gap (spring-forward): a wall-clock minute that does not exist never
 *     matches → the fire is skipped for that day.
 *   - Overlap (fall-back): cron is a wall-clock contract; each zone wall-clock
 *     minute fires once even when absolute time revisits it.
 */

import { isIanaTimeZone, wallWeekday, zonedParts } from "@centraid/core/time";

/** Device-prefs key for the gateway-wide default cron timezone. */
export const CRON_DEFAULT_TIMEZONE_PREF = "automation.cron.defaultTimezone";

export type WallClockFields = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday … 6 = Saturday (Date.getDay convention). */
  readonly weekday: number;
};

/** True when `name` is a non-empty IANA zone known to this runtime's `Intl`. */
export function isValidIanaTimeZone(name: string): boolean {
  if (typeof name !== "string") return false;
  const trimmed = name.trim();
  if (!trimmed) return false;
  return isIanaTimeZone(trimmed);
}

/**
 * Resolve the zone a cron schedule should match in.
 * Returns an IANA name, or `undefined` for host-local (legacy) matching.
 * Invalid candidates are skipped so a bad gateway default cannot poison a
 * valid per-trigger zone (or vice versa) — validation rejects them at write.
 */
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

/**
 * Wall-clock calendar fields for `date` in `timeZone`, or the host local
 * calendar when `timeZone` is omitted. Host-local uses Date getters so the
 * absent-`tz` path stays byte-identical to pre-#570 matching.
 */
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

/** Compact wall-clock identity of a minute in the given zone (DST dedupe key). */
export function wallClockMinuteKey(date: Date, timeZone?: string): string {
  const w = wallClockFields(date, timeZone);
  return [w.year, w.month, w.day, w.hour, w.minute, timeZone ?? "local"].join(
    ":"
  );
}
