// RRULE parsing, and the refusal that guards it. The supported subset and the
// three call shapes are documented in docs/cron-timezone.md.
//
// Why a refusal and not a shrug: every part outside that subset used to be read
// past in silence, so `FREQ=MONTHLY;BYSETPOS=-1` parsed as a plain monthly rule
// and a "last Friday of the month" reminder fired on the wrong date forever. A
// silently dropped part is worse than an unsupported one — the wrong answer
// wears the same face as the right one (review lens 3.2).

export const DAY_TOKENS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
type DayToken = (typeof DAY_TOKENS)[number];

export interface ParsedRrule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: string;
  byDay?: DayToken[];
}

/**
 * The parts the expander cannot honour, each with the reason accepting it would
 * be a lie. A table, not a chain of `if`s: this list IS the engine's stated
 * scope, and the refusal message quotes it back.
 */
const UNSUPPORTED_PARTS = [
  {
    part: "BYSETPOS",
    why: "selects the nth candidate within each period; the expander emits every candidate",
  },
  {
    part: "BYMONTHDAY",
    why: "pins occurrences to days of the month; the expander steps from the anchor day",
  },
  {
    part: "BYMONTH",
    why: "restricts occurrences to named months; the expander does not filter by month",
  },
  {
    part: "BYYEARDAY",
    why: "pins occurrences to days of the year; the expander steps from the anchor day",
  },
  {
    part: "BYWEEKNO",
    why: "pins occurrences to ISO week numbers, which the expander does not compute",
  },
  {
    part: "BYHOUR",
    why: "moves the time of day; the expander carries the anchor's wall clock unchanged",
  },
  {
    part: "BYMINUTE",
    why: "moves the time of day; the expander carries the anchor's wall clock unchanged",
  },
  {
    part: "BYSECOND",
    why: "moves the time of day; the expander carries the anchor's wall clock unchanged",
  },
] as const;

/** Sub-daily frequencies. Named so the refusal can say which one arrived. */
const UNSUPPORTED_FREQS = new Set(["HOURLY", "MINUTELY", "SECONDLY"]);

export type UnsupportedRrulePart =
  | (typeof UNSUPPORTED_PARTS)[number]["part"]
  | "BYDAY"
  | "WKST";

export type RruleRefusal =
  | { readonly ok: false; readonly reason: "malformed" }
  | {
      readonly ok: false;
      readonly reason: "unsupported-freq";
      readonly freq: string;
    }
  | {
      readonly ok: false;
      readonly reason: "unsupported-part";
      readonly part: UnsupportedRrulePart;
    };

export type RruleSupport =
  | { readonly ok: true; readonly rule: ParsedRrule }
  | RruleRefusal;

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Math.trunc(Number(value));
  // COUNT=0 is invalid ICS. Treat non-positive
  // bounds as a single occurrence rather than unbounded expansion.
  if (!Number.isFinite(parsed)) return undefined;
  return parsed > 0 ? parsed : 1;
}

/**
 * Canonical bare RRULE body (`FREQ=…`). Strips a leading `RRULE:` (Google
 * Calendar and ICS both emit the prefixed form) and collapses whitespace so
 * schedule preconditions, parseRrule, and ICS export share one shape.
 */
export function canonicalizeRrule(value: string): string {
  return value
    .replace(/^\s*RRULE:/iu, "")
    .replace(/\s+/gu, "")
    .trim();
}

/** Prefixed RRULE line for Google/ICS writeback without double-prefixing. */
export function rruleLine(value: string): string {
  const bare = canonicalizeRrule(value);
  return bare ? `RRULE:${bare}` : "";
}

/** `NAME=value` pairs of a canonical rule, upper-cased on both sides. */
function rruleParts(value: string): Map<string, string> {
  const parts = new Map<string, string>();
  for (const segment of canonicalizeRrule(value).split(";")) {
    const equals = segment.indexOf("=");
    if (equals < 0) continue;
    parts.set(
      segment.slice(0, equals).trim().toUpperCase(),
      segment
        .slice(equals + 1)
        .trim()
        .toUpperCase()
    );
  }
  return parts;
}

/** A positional BYDAY member: "2MO", "-1FR" — the nth weekday of a period. */
const POSITIONAL_DAY = /^[+-]?\d{1,2}(?:SU|MO|TU|WE|TH|FR|SA)$/u;

/**
 * The days, or the refusal that stops them being dropped. Only `weeklyCandidates`
 * reads BYDAY, so outside WEEKLY it names a different rule ("every Monday IN the
 * month"); a positional member ("-1FR") is `BYSETPOS` by another spelling; the
 * rest are not day tokens. Filtering any of them left a rule that parsed and
 * meant something else — `BYDAY=1MO` became plain WEEKLY, firing every Monday.
 */
function readByDay(
  raw: string | undefined,
  freq: ParsedRrule["freq"]
): DayToken[] | RruleRefusal | undefined {
  if (raw === undefined) return undefined;
  if (freq !== "WEEKLY")
    return { ok: false, reason: "unsupported-part", part: "BYDAY" };
  const tokens = raw.split(",").map((day) => day.trim());
  const days: DayToken[] = [];
  for (const token of tokens) {
    if (POSITIONAL_DAY.test(token))
      return { ok: false, reason: "unsupported-part", part: "BYDAY" };
    if (!(DAY_TOKENS as readonly string[]).includes(token))
      return { ok: false, reason: "malformed" };
    days.push(token as DayToken);
  }
  return days;
}

/**
 * Parse a rule, or say why it cannot be honoured. THE parser — `parseRrule`,
 * `assertSupportedRrule` and the expander all read a rule through here.
 *
 * WKST is refused rather than implemented: it only changes an expansion when
 * `INTERVAL > 1`, and `WKST=SU` is what `weeklyCandidates` already assumes, so
 * refusing exactly the cases that would differ leaves every accepted rule
 * identical and never relocates a fortnightly series by up to six days.
 */
export function inspectRrule(value: string): RruleSupport {
  const parts = rruleParts(value);
  const freq = parts.get("FREQ");
  if (freq !== undefined && UNSUPPORTED_FREQS.has(freq)) {
    return { ok: false, reason: "unsupported-freq", freq };
  }
  if (
    freq !== "DAILY" &&
    freq !== "WEEKLY" &&
    freq !== "MONTHLY" &&
    freq !== "YEARLY"
  ) {
    return { ok: false, reason: "malformed" };
  }
  for (const entry of UNSUPPORTED_PARTS) {
    if (parts.has(entry.part)) {
      return { ok: false, reason: "unsupported-part", part: entry.part };
    }
  }
  const interval = positiveInteger(parts.get("INTERVAL")) ?? 1;
  const wkst = parts.get("WKST");
  if (wkst !== undefined && wkst !== "SU" && interval > 1) {
    return { ok: false, reason: "unsupported-part", part: "WKST" };
  }
  const byDay = readByDay(parts.get("BYDAY"), freq);
  if (byDay !== undefined && "ok" in byDay) return byDay;
  const count = positiveInteger(parts.get("COUNT"));
  const until = parts.get("UNTIL");
  return {
    ok: true,
    rule: {
      freq,
      interval,
      ...(count === undefined ? {} : { count }),
      ...(until === undefined ? {} : { until }),
      ...(byDay === undefined ? {} : { byDay }),
    },
  };
}

/**
 * The parsed rule, or `null` when it cannot be honoured — for read surfaces with
 * nothing to say about a refusal. A caller that CAN report one uses
 * `inspectRrule` or `assertSupportedRrule`.
 */
export function parseRrule(value: string): ParsedRrule | null {
  const support = inspectRrule(value);
  return support.ok ? support.rule : null;
}

/** One sentence naming the part and why the engine will not pretend to honour it. */
export function rruleRefusalMessage(refusal: RruleRefusal): string {
  if (refusal.reason === "malformed") {
    return "recurrence rule has no supported FREQ (expected DAILY, WEEKLY, MONTHLY or YEARLY)";
  }
  if (refusal.reason === "unsupported-freq") {
    return `recurrence rule uses FREQ=${refusal.freq}, which this engine does not expand (sub-daily recurrence is not supported)`;
  }
  if (refusal.part === "BYDAY") {
    return 'recurrence rule uses a BYDAY this engine cannot honour: days steer WEEKLY expansion only, and a positional day ("-1FR") or a non-day token is not a rule it can expand';
  }
  if (refusal.part === "WKST") {
    return "recurrence rule sets WKST to a day other than SU with INTERVAL>1; this engine starts every week on Sunday, so the periods would not line up";
  }
  const entry = UNSUPPORTED_PARTS.find((item) => item.part === refusal.part);
  return `recurrence rule uses ${refusal.part}, which this engine cannot honour: it ${entry?.why ?? "is outside the supported subset"}`;
}

/** Thrown by `assertSupportedRrule`; carries the typed refusal for the caller. */
export class UnsupportedRruleError extends Error {
  readonly refusal: RruleRefusal;

  constructor(refusal: RruleRefusal, rrule: string) {
    super(
      `${rruleRefusalMessage(refusal)} (rule: ${canonicalizeRrule(rrule)})`
    );
    this.name = "UnsupportedRruleError";
    this.refusal = refusal;
  }
}

/**
 * Accept the rule or throw. A command that stores an RRULE calls this so an
 * unhonourable rule is refused where the member wrote it, instead of becoming a
 * row whose expansion is quietly wrong.
 */
export function assertSupportedRrule(value: string): ParsedRrule {
  const support = inspectRrule(value);
  if (!support.ok) throw new UnsupportedRruleError(support, value);
  return support.rule;
}
