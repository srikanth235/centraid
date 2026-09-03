export const DAY_TOKENS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
type DayToken = (typeof DAY_TOKENS)[number];

export interface ParsedRrule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: string;
  byDay?: DayToken[];
}

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
  if (!Number.isFinite(parsed)) return undefined;
  return parsed > 0 ? parsed : 1;
}

export function canonicalizeRrule(value: string): string {
  return value
    .replace(/^\s*RRULE:/iu, "")
    .replace(/\s+/gu, "")
    .trim();
}

export function rruleLine(value: string): string {
  const bare = canonicalizeRrule(value);
  return bare ? `RRULE:${bare}` : "";
}

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

const POSITIONAL_DAY = /^[+-]?\d{1,2}(?:SU|MO|TU|WE|TH|FR|SA)$/u;

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

export function parseRrule(value: string): ParsedRrule | null {
  const support = inspectRrule(value);
  return support.ok ? support.rule : null;
}

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

export function assertSupportedRrule(value: string): ParsedRrule {
  const support = inspectRrule(value);
  if (!support.ok) throw new UnsupportedRruleError(support, value);
  return support.rule;
}
