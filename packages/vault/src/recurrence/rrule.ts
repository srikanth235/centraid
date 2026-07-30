import {
  expandRecurrence,
  nextOccurrence as nextSharedOccurrence,
  parseRrule as parseSharedRrule,
} from "@centraid/time-engine";
import type { ParsedRrule } from "@centraid/time-engine";

export type { ParsedRrule } from "@centraid/time-engine";

export function parseRrule(value: string): ParsedRrule | null {
  const parsed = parseSharedRrule(value);
  if (!parsed) return null;
  // The old vault API exposed all optional keys, even when undefined. Preserve
  // that observable shape while the shared core keeps its payload compact.
  return {
    ...parsed,
    count: parsed.count,
    until: parsed.until,
    byDay: parsed.byDay,
  } as ParsedRrule;
}

/**
 * Compatibility facade for existing vault callers. New product surfaces use
 * `expandRecurrence` directly so they can select zoned, floating, or all-day
 * semantics; legacy rows are UTC instants and therefore use Etc/UTC.
 */
export function expandRrule(
  rrule: string,
  dtstartIso: string,
  rangeFromIso: string,
  rangeToIso: string,
  maxInstances = 366
): string[] {
  return expandRecurrence({
    rrule,
    start: dtstartIso,
    rangeFrom: rangeFromIso,
    rangeTo: rangeToIso,
    timeZone: "Etc/UTC",
    maxInstances,
  }).map((instance) => instance.start);
}

export function nextOccurrence(
  rrule: string,
  dtstartIso: string,
  afterIso: string
): string | null {
  return nextSharedOccurrence({
    rrule,
    scheduledStart: dtstartIso,
    after: afterIso,
    timeZone: "Etc/UTC",
  });
}
