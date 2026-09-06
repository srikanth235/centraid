// THE OCCURRENCE KEY, ONCE (#996, ruling R21, drift ONT-25).
//
// A recurrence exception is stored keyed on `original_start_local` — the
// series-local wall clock of the occurrence it excepts — with
// `recurrence_semantics` recording which reading that wall clock is under.
// Three readers spelled the column `original_start` and one spelled the zone
// `time_zone`, so every one of them read `undefined`: a skipped occurrence
// came back on the phone, on the web agenda and on Tally's template
// dashboard, silently, because a missing key matches nothing.
//
// This module is the ONE place the stored spelling appears. Readers take an
// `OccurrenceKey`; writers hand one over; the matcher in `recurrence.ts` is
// fed from `recurrenceExceptionsOf`. Nothing downstream names a column, so
// the two spellings cannot drift apart again — and a rename here is a
// type error at every call site rather than an empty agenda.

import type { RecurrenceException, RecurrenceSemantics } from "./recurrence.js";
import { parseWallIso, wallEpoch } from "./timezone.js";

/** The two series kinds `schedule_recurrence_exception.target_type` allows. */
export type OccurrenceSeriesType = "core.event" | "tally.recurring_expense";

export type OccurrenceScope = "occurrence" | "future";
export type OccurrenceAction = "skip" | "override";

/**
 * Series identity plus recurrence-local identity plus semantics — the whole
 * key, as one value. `localStart` is the series' own wall clock, never a
 * resolved UTC instant: a rule expands in wall clock, so that is what
 * identifies the occurrence, and re-anchoring the series must not orphan its
 * exceptions.
 */
export interface OccurrenceKey {
  readonly seriesType: OccurrenceSeriesType;
  readonly seriesId: string;
  readonly localStart: string;
  readonly semantics: RecurrenceSemantics;
}

/** An exception as the readers want it: a key, what it does, and how far. */
export interface OccurrenceException<Override = Record<string, unknown>> {
  readonly key: OccurrenceKey;
  readonly action: OccurrenceAction;
  readonly scope: OccurrenceScope;
  readonly override: Override | null;
}

/**
 * The stored row. THE ONLY PLACE THESE COLUMN NAMES ARE WRITTEN — a reader
 * that wants an occurrence takes `OccurrenceException`, not this.
 */
export interface StoredOccurrenceExceptionRow {
  readonly target_type?: string | null;
  readonly target_id?: string | null;
  readonly original_start_local?: string | null;
  readonly recurrence_semantics?: string | null;
  readonly scope?: string | null;
  readonly action?: string | null;
  readonly override_json?: string | null;
  readonly [key: string]: unknown;
}

/** The column an occurrence key is stored under, for the writers that build
 *  SQL. Exported so no other module spells it. */
export const OCCURRENCE_LOCAL_START_COLUMN = "original_start_local";
/** The command-input and query-output property carrying an occurrence key.
 *  The same word as the column on purpose: one spelling, end to end. */
export const OCCURRENCE_LOCAL_START_KEY = "original_start_local";

function semanticsOf(value: unknown): RecurrenceSemantics {
  return value === "floating" || value === "all-day" ? value : "zoned";
}

export function occurrenceKey(
  seriesType: OccurrenceSeriesType,
  seriesId: string,
  localStart: string,
  semantics: RecurrenceSemantics = "zoned"
): OccurrenceKey {
  return { seriesType, seriesId, localStart, semantics };
}

/** A stable string for map keys and instance ids. Semantics is part of it: the
 *  same wall clock under two readings is two occurrences. */
export function occurrenceKeyToken(key: OccurrenceKey): string {
  return `${key.seriesType}:${key.seriesId}:${key.semantics}:${key.localStart}`;
}

export function occurrenceKeysEqual(
  left: OccurrenceKey,
  right: OccurrenceKey
): boolean {
  return occurrenceKeyToken(left) === occurrenceKeyToken(right);
}

/**
 * Read one stored row. Returns `null` for a row missing the key — a row the
 * old readers silently treated as an exception at `undefined`, matching every
 * occurrence or none depending on which side of the comparison it landed.
 */
export function readOccurrenceException<Override = Record<string, unknown>>(
  row: StoredOccurrenceExceptionRow
): OccurrenceException<Override> | null {
  const localStart = row[OCCURRENCE_LOCAL_START_COLUMN];
  const seriesType = row.target_type;
  const seriesId = row.target_id;
  if (
    typeof localStart !== "string" ||
    localStart.length === 0 ||
    typeof seriesId !== "string" ||
    (seriesType !== "core.event" && seriesType !== "tally.recurring_expense")
  ) {
    return null;
  }
  let override: Override | null = null;
  if (typeof row.override_json === "string" && row.override_json.length > 0) {
    try {
      override = JSON.parse(row.override_json) as Override;
    } catch {
      override = null;
    }
  }
  return {
    key: occurrenceKey(
      seriesType,
      seriesId,
      localStart,
      semanticsOf(row.recurrence_semantics)
    ),
    action: row.action === "override" ? "override" : "skip",
    scope: row.scope === "future" ? "future" : "occurrence",
    override,
  };
}

/** Every readable exception for one series, oldest occurrence first. */
export function occurrenceExceptionsOf<Override = Record<string, unknown>>(
  rows: readonly StoredOccurrenceExceptionRow[],
  series: { seriesType: OccurrenceSeriesType; seriesId: string }
): OccurrenceException<Override>[] {
  return rows
    .map((row) => readOccurrenceException<Override>(row))
    .filter(
      (exception): exception is OccurrenceException<Override> =>
        exception !== null &&
        exception.key.seriesType === series.seriesType &&
        exception.key.seriesId === series.seriesId
    )
    .sort((left, right) =>
      left.key.localStart.localeCompare(right.key.localStart)
    );
}

/** The shape `applyRecurrenceExceptions` takes. The `start` of an override is
 *  read from the override payload, which is where the shadow occurrence's own
 *  values live. */
export function recurrenceExceptionsOf(
  exceptions: readonly OccurrenceException<{ start?: string }>[]
): RecurrenceException[] {
  return exceptions.map((exception) => ({
    originalStart: exception.key.localStart,
    action: exception.action,
    scope: exception.scope,
    ...(typeof exception.override?.start === "string"
      ? { start: exception.override.start }
      : {}),
  }));
}

/**
 * The override in force at `localStart`: the occurrence-scoped one if there is
 * one, else the most recent `future`-scoped one at or before it. Inlined in
 * three readers before this, each with its own comparison and its own bug.
 */
export function overrideAt<Override>(
  exceptions: readonly OccurrenceException<Override>[],
  localStart: string
): Override | null {
  let future: Override | null = null;
  for (const exception of exceptions) {
    if (
      exception.scope === "occurrence" &&
      exception.key.localStart === localStart
    ) {
      return exception.override;
    }
    if (
      exception.scope === "future" &&
      exception.key.localStart <= localStart
    ) {
      future = exception.override;
    }
  }
  return future;
}

/**
 * A window wide enough to contain the occurrence a series-local wall clock
 * names, whatever zone the series is read in.
 *
 * A wall clock is NOT an instant: `Date.parse("2026-03-29T09:00:00")` reads it
 * in the host's zone, which is how a writer that took the key for a timestamp
 * turned "skip the 29th" into "skip nothing" on every machine outside UTC.
 * The window is deliberately a bound and not a conversion — two days each way
 * covers every offset on earth plus a DST step — and the caller then matches
 * on `wallStart`, which is the key.
 */
export function occurrenceSearchWindow(
  localStart: string,
  days = 2
): { from: string; to: string } | null {
  const wall = parseWallIso(localStart);
  const at = wall === null ? Date.parse(localStart) : wallEpoch(wall);
  if (Number.isNaN(at)) return null;
  const span = days * 86_400_000;
  return {
    from: new Date(at - span).toISOString(),
    to: new Date(at + span).toISOString(),
  };
}
