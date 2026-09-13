// THE CIVIL-TIME CORPUS, GENERATED FROM v0 (#1020, wave 4 lane Schedule,
// D-1020-D3-6, D-1020-S1…S3).
//
// `crates/vault/src/time/**` is a port of `packages/core/src/time/**`, and the
// two must answer identically. Nothing in `contracts/time/` is typed by hand
// and nothing is regenerated from the Rust side: a fixture a port could
// rewrite proves nothing. The emitter is also the oracle —
// `tests/quality/time-corpus.contract.test.ts` calls `buildTimeCorpus()` and
// either WRITES the files (with `CENTRAID_WRITE_CONTRACTS=1`) or asserts they
// match, so "the fixture passes in v0 too" is that test and it fails the
// moment a v0 function's answer moves.
//
// THREE FILES, and what each one pins:
//
// | File | v0 functions | The property |
// |---|---|---|
// | `rrule-cases.json` | `inspectRrule`, `rruleRefusalMessage`, `canonicalizeRrule`, `describeRecurrence` | the REFUSED-NEVER-DROPPED subset, each refusal's sentence, and the one summariser's words |
// | `dst-cases.json` | `expandRecurrence`, `resolveWallTime` | the three DST sentences, in five zones including a 30-minute shift and a negative-DST zone |
// | `occurrence-cases.json` | `occurrenceExceptionsOf`, `overrideAt`, `applyRecurrenceExceptions`, `occurrenceSearchWindow`, `nextOccurrence`, `collapseMissedOccurrences` | the occurrence KEY — `original_start_local`, never the resolved instant (ONT-25) |
//
// THE CAUTIONARY CASE IS IN THE CORPUS BY NAME. `FREQ=MONTHLY;BYSETPOS=-1` is
// why the refusal exists: it used to parse as a plain monthly rule and a "last
// Friday of the month" reminder fired on the wrong date forever
// (`rrule-support.ts:1`-`:8`). `rrule-cases.json` carries it with its message.
//
// EVERY CASE NAMES ITS ZONE. v0's recurrence engine takes `timeZone`
// explicitly, so unlike the cron corpus there is no host-clock tier to record
// — but a case with no zone would still read `undefined` and fall back to
// nothing, so the generator never emits one.

/** Where the corpus is written, relative to the repository root. */
export const TIME_CORPUS_DIR = "contracts/time";

export const TIME_CORPUS_FILES = [
  "rrule-cases.json",
  "dst-cases.json",
  "occurrence-cases.json",
] as const;

export type TimeCorpusFile = (typeof TIME_CORPUS_FILES)[number];

type RruleSupport =
  | { ok: true; rule: Record<string, unknown> }
  | { ok: false; reason: string; part?: string; freq?: string };

interface V0Time {
  inspectRrule: (value: string) => RruleSupport;
  canonicalizeRrule: (value: string) => string;
  rruleLine: (value: string) => string;
  rruleRefusalMessage: (refusal: unknown) => string;
  describeRecurrence: (value: string) => string | null;
  expandRecurrence: (input: Record<string, unknown>) => {
    originalStart: string;
    start: string;
    wallStart: string;
    overlap: boolean;
  }[];
  applyRecurrenceExceptions: (
    instances: readonly unknown[],
    exceptions: readonly unknown[]
  ) => { start: string; wallStart: string; overlap: boolean }[];
  nextOccurrence: (input: Record<string, unknown>) => string | null;
  collapseMissedOccurrences: (input: Record<string, unknown>) => {
    missed: number;
    nextDue: string | null;
  };
  resolveWallTime: (
    value: Record<string, number>,
    zone: string
  ) => { instant: string; overlap: boolean } | null;
  parseWallIso: (value: string) => Record<string, number> | null;
  occurrenceExceptionsOf: (
    rows: readonly Record<string, unknown>[],
    series: { seriesType: string; seriesId: string }
  ) => {
    key: {
      seriesType: string;
      seriesId: string;
      localStart: string;
      semantics: string;
    };
    action: string;
    scope: string;
    override: Record<string, unknown> | null;
  }[];
  recurrenceExceptionsOf: (exceptions: readonly unknown[]) => unknown[];
  overrideAt: (
    exceptions: readonly unknown[],
    localStart: string
  ) => Record<string, unknown> | null;
  occurrenceKeyToken: (key: Record<string, unknown>) => string;
  occurrenceSearchWindow: (
    localStart: string,
    days?: number
  ) => { from: string; to: string } | null;
  classifyTemporal: (value: string) => string | null;
  OCCURRENCE_LOCAL_START_COLUMN: string;
}

/**
 * The v0 modules, through a COMPUTED specifier.
 *
 * A literal import pulls the whole `packages/core` graph into whatever
 * TypeScript program type-checks this file, and no program that can also see
 * `contracts/` has that tsconfig — the same reason Tally's, Photos' and
 * automations' generators compute theirs.
 */
async function loadV0(): Promise<V0Time> {
  const base = "../../packages/core/src/time";
  const [rrule, recurrence, collapse, summary, timezone, occurrence, temporal] =
    await Promise.all([
      import(`${base}/rrule-support.ts`),
      import(`${base}/recurrence.ts`),
      import(`${base}/recurrence-collapse.ts`),
      import(`${base}/recurrence-summary.ts`),
      import(`${base}/timezone.ts`),
      import(`${base}/occurrence.ts`),
      import(`${base}/temporal.ts`),
    ]);
  return {
    ...(rrule as object),
    ...(recurrence as object),
    ...(collapse as object),
    ...(summary as object),
    ...(timezone as object),
    ...(occurrence as object),
    ...(temporal as object),
  } as V0Time;
}

/**
 * THE ADVERSARIAL ZONES, the same table `time-zoo-recurrence.test.ts` keeps
 * and for the same reasons — each one breaks a different assumption a port
 * might make.
 */
export const ZOO = [
  { zone: "America/New_York", why: "the doctrine's pinned zone" },
  {
    zone: "Europe/Dublin",
    why: "negative DST: the summer offset is the STANDARD one, so an is-DST flag reads backwards",
  },
  {
    zone: "Australia/Lord_Howe",
    why: "a THIRTY-MINUTE shift: an hour-shaped gap check misses it entirely",
  },
  {
    zone: "Pacific/Chatham",
    why: "a :45 offset, so wall minutes and UTC minutes never line up",
  },
  { zone: "Asia/Kolkata", why: "a :30 offset that never changes" },
  { zone: "Etc/UTC", why: "the control" },
] as const;

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

interface RruleCase {
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

function buildRruleCases(v0: V0Time): {
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

/** Anchors chosen to land on, beside and across each zone's transitions. */
const DST_ANCHORS = [
  // Northern spring forward / autumn back (New York, Dublin).
  {
    start: "2026-03-06T14:00:00.000Z",
    rrule: "FREQ=DAILY",
    days: 8,
    why: "a 09:00-ish daily series across the March transition",
  },
  {
    start: "2026-03-06T07:30:00.000Z",
    rrule: "FREQ=DAILY",
    days: 8,
    why: "an anchor that lands IN the New York gap on the 8th",
  },
  {
    start: "2026-10-30T05:30:00.000Z",
    rrule: "FREQ=DAILY",
    days: 8,
    why: "an anchor that lands IN the November fold",
  },
  {
    start: "2026-03-29T00:30:00.000Z",
    rrule: "FREQ=DAILY",
    days: 6,
    why: "the European transition weekend",
  },
  {
    start: "2026-04-04T15:00:00.000Z",
    rrule: "FREQ=DAILY",
    days: 6,
    why: "the Lord Howe / southern autumn transition",
  },
  {
    start: "2026-10-03T15:00:00.000Z",
    rrule: "FREQ=DAILY",
    days: 6,
    why: "the southern spring transition",
  },
  {
    start: "2026-03-06T14:00:00.000Z",
    rrule: "FREQ=WEEKLY;BYDAY=MO,FR",
    days: 30,
    why: "weekly BYDAY across a transition",
  },
  {
    start: "2026-01-31T09:00:00.000Z",
    rrule: "FREQ=MONTHLY",
    days: 400,
    why: "the month-end clamp",
  },
  {
    start: "2024-02-29T09:00:00.000Z",
    rrule: "FREQ=YEARLY",
    days: 1500,
    why: "the leap day",
  },
  {
    start: "2026-01-01T09:00:00.000Z",
    rrule: "FREQ=DAILY;COUNT=5",
    days: 30,
    why: "COUNT exhaustion",
  },
  {
    start: "2026-01-01T09:00:00.000Z",
    rrule: "FREQ=DAILY;UNTIL=20260105T000000Z",
    days: 30,
    why: "UNTIL",
  },
  {
    start: "2000-01-01T09:00:00.000Z",
    rrule: "FREQ=DAILY;COUNT=1",
    days: 30,
    why: "COUNT=1 on an ancient anchor must not convert twenty-six years",
  },
  {
    start: "2026-01-01T09:00:00.000Z",
    rrule: "FREQ=MONTHLY;BYSETPOS=-1",
    days: 400,
    why: "a refused rule expands to NOTHING",
  },
] as const;

interface DstCase {
  zone: string;
  why: string;
  rrule: string;
  start: string;
  rangeFrom: string;
  rangeTo: string;
  semantics: string;
  maxInstances: number;
  occurrences: { start: string; wallStart: string; overlap: boolean }[];
}

function isoAfter(start: string, days: number): string {
  return new Date(Date.parse(start) + days * 86_400_000).toISOString();
}

function isoBefore(start: string, days: number): string {
  return new Date(Date.parse(start) - days * 86_400_000).toISOString();
}

function buildDstCases(v0: V0Time): {
  cases: DstCase[];
  wallResolutions: {
    zone: string;
    wall: string;
    instant: string | null;
    overlap: boolean | null;
  }[];
  floating: DstCase[];
} {
  const cases: DstCase[] = [];
  for (const { zone, why } of ZOO) {
    for (const anchor of DST_ANCHORS) {
      const rangeFrom = isoBefore(anchor.start, 1);
      const rangeTo = isoAfter(anchor.start, anchor.days);
      const occurrences = v0
        .expandRecurrence({
          rrule: anchor.rrule,
          start: anchor.start,
          rangeFrom,
          rangeTo,
          timeZone: zone,
          semantics: "zoned",
          maxInstances: 400,
        })
        .map((item) => ({
          start: item.start,
          wallStart: item.wallStart,
          overlap: item.overlap,
        }));
      cases.push({
        zone,
        why: `${why} — ${anchor.why}`,
        rrule: anchor.rrule,
        start: anchor.start,
        rangeFrom,
        rangeTo,
        semantics: "zoned",
        maxInstances: 400,
        occurrences,
      });
    }
  }

  // `resolveWallTime` directly: a gap, a fold and an ordinary minute in every
  // zone, at each transition's own wall clock.
  const walls: {
    zone: string;
    wall: string;
    instant: string | null;
    overlap: boolean | null;
  }[] = [];
  const probes = [
    "2026-03-08T02:30:00",
    "2026-03-08T03:30:00",
    "2026-11-01T01:30:00",
    "2026-11-01T03:30:00",
    "2026-03-29T01:30:00",
    "2026-10-25T01:30:00",
    "2026-04-05T01:45:00",
    "2026-10-04T02:15:00",
    "2026-06-15T09:00:00",
    "2026-12-15T09:00:00",
  ];
  for (const { zone } of ZOO) {
    for (const probe of probes) {
      const wall = v0.parseWallIso(probe);
      if (!wall) throw new Error(`unparseable probe ${probe}`);
      const resolved = v0.resolveWallTime(wall, zone);
      walls.push({
        zone,
        wall: probe,
        instant: resolved?.instant ?? null,
        overlap: resolved === null ? null : resolved.overlap,
      });
    }
  }

  // A FLOATING and an ALL-DAY series are never read through anybody's zone.
  const floating: DstCase[] = [];
  for (const semantics of ["floating", "all-day"] as const) {
    const start = semantics === "all-day" ? "2026-03-06" : "2026-03-06T09:00";
    const rangeFrom =
      semantics === "all-day" ? "2026-03-01" : "2026-03-01T00:00";
    const rangeTo = semantics === "all-day" ? "2026-03-20" : "2026-03-20T00:00";
    for (const rrule of [
      "FREQ=DAILY",
      "FREQ=WEEKLY;BYDAY=MO,FR",
      "FREQ=MONTHLY",
    ]) {
      floating.push({
        zone: "(none)",
        why: `${semantics} series: the wall clock IS the occurrence`,
        rrule,
        start,
        rangeFrom,
        rangeTo,
        semantics,
        maxInstances: 400,
        occurrences: v0
          .expandRecurrence({
            rrule,
            start,
            rangeFrom,
            rangeTo,
            semantics,
            maxInstances: 400,
          })
          .map((item) => ({
            start: item.start,
            wallStart: item.wallStart,
            overlap: item.overlap,
          })),
      });
    }
  }
  return { cases, wallResolutions: walls, floating };
}

/** Stored exception rows, in the column spellings the vault uses. */
function exceptionRows(): Record<string, unknown>[] {
  return [
    {
      exception_id: "exc-1",
      target_type: "core.event",
      target_id: "event-1",
      original_start_local: "2026-03-09T09:00:00",
      recurrence_semantics: "zoned",
      scope: "occurrence",
      action: "skip",
      override_json: null,
    },
    {
      exception_id: "exc-2",
      target_type: "core.event",
      target_id: "event-1",
      original_start_local: "2026-03-11T09:00:00",
      recurrence_semantics: "zoned",
      scope: "occurrence",
      action: "override",
      override_json: JSON.stringify({
        scope: "occurrence",
        start: "2026-03-11T18:00:00.000Z",
        summary: "Moved later",
      }),
    },
    {
      exception_id: "exc-3",
      target_type: "core.event",
      target_id: "event-1",
      original_start_local: "2026-03-13T09:00:00",
      recurrence_semantics: "zoned",
      scope: "future",
      action: "override",
      override_json: JSON.stringify({
        scope: "future",
        start: "2026-03-13T15:00:00.000Z",
      }),
    },
    {
      // ANOTHER SERIES — must never reach event-1's fold.
      exception_id: "exc-4",
      target_type: "core.event",
      target_id: "event-2",
      original_start_local: "2026-03-09T09:00:00",
      recurrence_semantics: "zoned",
      scope: "occurrence",
      action: "skip",
      override_json: null,
    },
    {
      // ANOTHER SERIES KIND.
      exception_id: "exc-5",
      target_type: "tally.recurring_expense",
      target_id: "event-1",
      original_start_local: "2026-03-09T09:00:00",
      recurrence_semantics: "zoned",
      scope: "occurrence",
      action: "skip",
      override_json: null,
    },
    {
      // NO KEY: the row the old readers treated as an exception at
      // `undefined`, matching everything or nothing.
      exception_id: "exc-6",
      target_type: "core.event",
      target_id: "event-1",
      original_start_local: null,
      recurrence_semantics: "zoned",
      scope: "occurrence",
      action: "skip",
      override_json: null,
    },
    {
      // AN UNREADABLE OVERRIDE is not an invented one.
      exception_id: "exc-7",
      target_type: "core.event",
      target_id: "event-1",
      original_start_local: "2026-03-17T09:00:00",
      recurrence_semantics: "zoned",
      scope: "occurrence",
      action: "override",
      override_json: "{",
    },
  ];
}

function buildOccurrenceCases(v0: V0Time): Record<string, unknown> {
  const rows = exceptionRows();
  const series = { seriesType: "core.event", seriesId: "event-1" } as const;
  const exceptions = v0.occurrenceExceptionsOf(rows, series);
  const zone = "Asia/Kolkata";
  const start = "2026-03-02T03:30:00.000Z"; // 09:00 IST
  const instances = v0.expandRecurrence({
    rrule: "FREQ=DAILY",
    start,
    rangeFrom: "2026-03-01T00:00:00.000Z",
    rangeTo: "2026-03-20T00:00:00.000Z",
    timeZone: zone,
    semantics: "zoned",
    maxInstances: 400,
  });
  const applied = v0.applyRecurrenceExceptions(
    instances,
    v0.recurrenceExceptionsOf(exceptions) as readonly unknown[]
  );
  // THE ONT-25 PROOF: the same skip keyed on the RESOLVED INSTANT matches
  // nothing at all. Carried as a case so the wrong key cannot be reintroduced
  // as "equivalent".
  const wrongKey = v0.applyRecurrenceExceptions(instances, [
    {
      originalStart: instances[7]?.originalStart ?? start,
      action: "skip",
      scope: "occurrence",
    },
  ]);
  return {
    column: v0.OCCURRENCE_LOCAL_START_COLUMN,
    rows,
    series,
    exceptions: exceptions.map((exception) => ({
      seriesType: exception.key.seriesType,
      seriesId: exception.key.seriesId,
      localStart: exception.key.localStart,
      semantics: exception.key.semantics,
      token: v0.occurrenceKeyToken(exception.key),
      action: exception.action,
      scope: exception.scope,
      override: exception.override,
    })),
    overrideAt: [
      "2026-03-08T09:00:00",
      "2026-03-11T09:00:00",
      "2026-03-12T09:00:00",
      "2026-03-13T09:00:00",
      "2026-03-19T09:00:00",
    ].map((localStart) => ({
      localStart,
      override: v0.overrideAt(exceptions, localStart),
    })),
    expansion: {
      zone,
      rrule: "FREQ=DAILY",
      start,
      rangeFrom: "2026-03-01T00:00:00.000Z",
      rangeTo: "2026-03-20T00:00:00.000Z",
      before: instances.map((item) => ({
        start: item.start,
        wallStart: item.wallStart,
        overlap: item.overlap,
      })),
      after: applied.map((item) => ({
        start: item.start,
        wallStart: item.wallStart,
        overlap: item.overlap,
      })),
    },
    ont25: {
      why: "the same skip keyed on the RESOLVED INSTANT matches no occurrence at all",
      instantKey: instances[7]?.originalStart ?? start,
      wallKey: instances[7]?.wallStart ?? start,
      keptWithInstantKey: wrongKey.length,
      keptWithWallKey: applied.length,
      total: instances.length,
    },
    searchWindows: [
      "2026-03-29T09:00:00",
      "2026-03-29",
      "2026-11-01T01:30:00",
      "banana",
    ].map((localStart) => ({
      localStart,
      window: v0.occurrenceSearchWindow(localStart),
    })),
    nextOccurrence: [
      {
        rrule: "FREQ=DAILY",
        scheduledStart: "2026-03-01T09:00:00.000Z",
        after: "2026-03-01T09:00:00.000Z",
        anchor: "scheduled",
      },
      {
        rrule: "FREQ=DAILY",
        scheduledStart: "2026-03-01T09:00:00.000Z",
        after: "2026-03-05T10:00:00.000Z",
        anchor: "scheduled",
      },
      {
        rrule: "FREQ=WEEKLY;BYDAY=MO,FR",
        scheduledStart: "2026-03-02T09:00:00.000Z",
        after: "2026-03-03T09:00:00.000Z",
        anchor: "scheduled",
      },
      {
        rrule: "FREQ=DAILY;INTERVAL=30",
        scheduledStart: "2026-03-01T09:00:00.000Z",
        after: "2026-04-15T09:00:00.000Z",
        anchor: "completion",
      },
      {
        rrule: "FREQ=MONTHLY;BYSETPOS=-1",
        scheduledStart: "2026-03-01T09:00:00.000Z",
        after: "2026-03-01T09:00:00.000Z",
        anchor: "scheduled",
      },
    ].map((input) => ({
      ...input,
      zone: "Asia/Kolkata",
      next: v0.nextOccurrence({ ...input, timeZone: "Asia/Kolkata" }),
    })),
    collapse: [
      {
        rrule: "FREQ=DAILY",
        scheduledStart: "2026-03-01T09:00:00.000Z",
        now: "2026-03-05T10:00:00.000Z",
        anchor: "scheduled",
      },
      {
        rrule: "FREQ=DAILY",
        scheduledStart: "2026-03-01T09:00:00.000Z",
        now: "2026-03-05T10:00:00.000Z",
        anchor: "scheduled",
        lastCompletedAt: "2026-03-03T09:00:00.000Z",
      },
      {
        rrule: "FREQ=WEEKLY;BYDAY=MO",
        scheduledStart: "2026-01-05T09:00:00.000Z",
        now: "2026-03-05T10:00:00.000Z",
        anchor: "scheduled",
      },
      {
        rrule: "FREQ=DAILY;INTERVAL=7",
        scheduledStart: "2026-03-01T09:00:00.000Z",
        now: "2026-03-20T10:00:00.000Z",
        anchor: "completion",
      },
      {
        rrule: "FREQ=DAILY;INTERVAL=7",
        scheduledStart: "2026-03-01T09:00:00.000Z",
        now: "2026-03-20T10:00:00.000Z",
        anchor: "completion",
        lastCompletedAt: "2026-03-08T09:00:00.000Z",
      },
      {
        rrule: "FREQ=MONTHLY;BYSETPOS=-1",
        scheduledStart: "2026-03-01T09:00:00.000Z",
        now: "2026-03-20T10:00:00.000Z",
        anchor: "scheduled",
      },
    ].map((input) => ({
      ...input,
      zone: "Asia/Kolkata",
      collapsed: v0.collapseMissedOccurrences({
        ...input,
        timeZone: "Asia/Kolkata",
      }),
    })),
    temporal: [
      "2026-03-01T09:00:00Z",
      "2026-03-01T09:00:00+05:30",
      "2026-03-01T09:00",
      "2026-03-01T09:00:00.123",
      "2026-03-01",
      "02-29",
      "2027-02-29",
      "2026-02-31",
      "2026-13-01",
      "2026-03-01T25:00:00Z",
      "banana",
      "",
    ].map((value) => ({ value, kind: v0.classifyTemporal(value) })),
  };
}

export interface TimeCorpus {
  rruleCases: ReturnType<typeof buildRruleCases>;
  dstCases: ReturnType<typeof buildDstCases>;
  occurrenceCases: Record<string, unknown>;
}

/** Build the whole corpus from the live v0 tree. */
export async function buildTimeCorpus(): Promise<TimeCorpus> {
  const v0 = await loadV0();
  return {
    rruleCases: buildRruleCases(v0),
    dstCases: buildDstCases(v0),
    occurrenceCases: buildOccurrenceCases(v0),
  };
}

/** The committed bytes, per file. */
export function payloadsFor(
  corpus: TimeCorpus
): Record<TimeCorpusFile, string> {
  const note =
    "GENERATED from packages/core/src/time by contracts/tools/export-time-corpus.ts — do not edit by hand (#1020).";
  return {
    "rrule-cases.json": `${JSON.stringify({ note, ...corpus.rruleCases }, null, 2)}\n`,
    "dst-cases.json": `${JSON.stringify({ note, zones: ZOO, ...corpus.dstCases }, null, 2)}\n`,
    "occurrence-cases.json": `${JSON.stringify({ note, ...corpus.occurrenceCases }, null, 2)}\n`,
  };
}
