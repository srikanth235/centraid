// THE RRULE CASES — every rule form the parser has an opinion about (#1020,
// wave 4 slot 4d, D-1020-S1).
//
// Split out of `time-corpus-cases.ts` for the same `max-lines` reason that file
// was split out of the generator: the honest answer to a ceiling is a smaller
// file, not a ledger row.
//
// THE CAUTIONARY CASE IS HERE BY NAME. `FREQ=MONTHLY;BYSETPOS=-1` is why the
// refusal exists: it used to parse as a plain monthly rule and a "last Friday
// of the month" reminder fired on the wrong date forever
// (`packages/core/src/time/rrule-support.ts:1`-`:8`).

import type { V0Time } from "./export-time-corpus.js";

/** Every rule form the parser has an opinion about. */
function rruleCorpus(): string[] {
  const rules = new Set<string>();
  // The accepted subset, walked.
  for (const freq of ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]) {
    for (const interval of [
      "",
      ";INTERVAL=1",
      ";INTERVAL=2",
      ";INTERVAL=3",
      ";INTERVAL=13",
    ]) {
      for (const bound of [
        "",
        ";COUNT=1",
        ";COUNT=5",
        ";COUNT=0",
        ";COUNT=-2",
        ";UNTIL=20261231T000000Z",
        ";UNTIL=2026-12-31",
        ";UNTIL=SOON",
      ]) {
        rules.add(`FREQ=${freq}${interval}${bound}`);
      }
    }
  }
  // BYDAY, which only WEEKLY may carry.
  for (const days of [
    "SU",
    "MO",
    "FR",
    "MO,WE,FR",
    "FR,MO",
    "SU,SA",
    "MO,TU,WE,TH,FR",
    "MO,",
    "MO,XX",
    "-1FR",
    "2MO",
    "+3WE",
  ]) {
    rules.add(`FREQ=WEEKLY;BYDAY=${days}`);
    rules.add(`FREQ=WEEKLY;INTERVAL=2;BYDAY=${days}`);
    rules.add(`FREQ=MONTHLY;BYDAY=${days}`);
  }
  // WKST, refused exactly where it would change an expansion.
  for (const wkst of ["SU", "MO", "WE"]) {
    rules.add(`FREQ=WEEKLY;WKST=${wkst}`);
    rules.add(`FREQ=WEEKLY;INTERVAL=2;WKST=${wkst}`);
    rules.add(`FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=${wkst}`);
  }
  // Every refused part, each on its own.
  for (const part of [
    "BYSETPOS=-1",
    "BYSETPOS=1",
    "BYMONTHDAY=1",
    "BYMONTHDAY=-1",
    "BYMONTH=3",
    "BYYEARDAY=200",
    "BYWEEKNO=12",
    "BYHOUR=9",
    "BYMINUTE=30",
    "BYSECOND=15",
  ]) {
    rules.add(`FREQ=MONTHLY;${part}`);
    rules.add(`FREQ=DAILY;${part}`);
  }
  // Sub-daily and malformed.
  for (const freq of ["HOURLY", "MINUTELY", "SECONDLY", "FORTNIGHTLY", ""]) {
    rules.add(`FREQ=${freq}`);
  }
  for (const odd of [
    "",
    "  ",
    "RRULE:FREQ=DAILY",
    "rrule:FREQ=WEEKLY;BYDAY=MO",
    "RRULE: FREQ = DAILY ",
    "freq=daily",
    "FREQ=DAILY;",
    ";;FREQ=DAILY",
    "INTERVAL=2",
    "banana",
    "FREQ=DAILY;INTERVAL=banana",
    "FREQ=DAILY;COUNT=banana",
    "FREQ=DAILY;INTERVAL=0",
    "FREQ=DAILY;INTERVAL=-4",
  ]) {
    rules.add(odd);
  }
  return [...rules].sort();
}

export interface RruleCase {
  rrule: string;
  canonical: string;
  line: string;
  accepted: boolean;
  rule?: Record<string, unknown>;
  reason?: string;
  part?: string;
  freq?: string;
  message?: string;
  summary: string | null;
}

export function buildRruleCases(v0: V0Time): {
  cases: RruleCase[];
  cautionary: RruleCase;
  supportedFreqs: string[];
  refusedParts: string[];
} {
  const cases = rruleCorpus().map((rrule): RruleCase => {
    const support = v0.inspectRrule(rrule);
    const common = {
      rrule,
      canonical: v0.canonicalizeRrule(rrule),
      line: v0.rruleLine(rrule),
      summary: v0.describeRecurrence(rrule),
    };
    if (support.ok) {
      return { ...common, accepted: true, rule: support.rule };
    }
    return {
      ...common,
      accepted: false,
      reason: support.reason,
      ...(support.part === undefined ? {} : { part: support.part }),
      ...(support.freq === undefined ? {} : { freq: support.freq }),
      message: v0.rruleRefusalMessage(support),
    };
  });
  const cautionary = cases.find(
    (entry) => entry.rrule === "FREQ=MONTHLY;BYSETPOS=-1"
  );
  if (!cautionary) throw new Error("the cautionary case left the corpus");
  return {
    cases,
    cautionary,
    supportedFreqs: ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"],
    refusedParts: [
      "BYSETPOS",
      "BYMONTHDAY",
      "BYMONTH",
      "BYYEARDAY",
      "BYWEEKNO",
      "BYHOUR",
      "BYMINUTE",
      "BYSECOND",
      "BYDAY",
      "WKST",
    ],
  };
}
