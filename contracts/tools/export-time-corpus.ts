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

import {
  ZOO,
  buildDstCases,
  buildOccurrenceCases,
  buildRruleCases,
} from "./time-corpus-cases.js";

export { ZOO } from "./time-corpus-cases.js";

/** Where the corpus is written, relative to the repository root. */
export const TIME_CORPUS_DIR = "contracts/time";

export const TIME_CORPUS_FILES = [
  "rrule-cases.json",
  "dst-cases.json",
  "occurrence-cases.json",
] as const;

export type TimeCorpusFile = (typeof TIME_CORPUS_FILES)[number];

export type RruleSupport =
  | { ok: true; rule: Record<string, unknown> }
  | { ok: false; reason: string; part?: string; freq?: string };

export interface V0Time {
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
