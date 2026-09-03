import {
  expandRecurrence,
  nextOccurrence as nextSharedOccurrence,
  parseRrule as parseSharedRrule,
} from "@centraid/core/time";
import type { ParsedRrule } from "@centraid/core/time";

export type { ParsedRrule } from "@centraid/core/time";

export function parseRrule(value: string): ParsedRrule | null {
  const parsed = parseSharedRrule(value);
  if (!parsed) return null;
  return {
    ...parsed,
    count: parsed.count,
    until: parsed.until,
    byDay: parsed.byDay,
  } as ParsedRrule;
}

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
