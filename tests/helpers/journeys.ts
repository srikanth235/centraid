import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * THE ONE READER for `tests/journeys.json` (#927).
 *
 * Every ceiling the repo enforces on a user-facing interval now lives in one
 * ledger keyed `surface / journey / volume / hardware`, because a number stated
 * without the volume and the hardware behind it is not a budget — four
 * per-surface files keyed by surface alone could not say at what volume they
 * held, and several of them silently meant "empty vault".
 *
 * Nothing parses the ledger by hand. A missing entry, metric or field THROWS
 * rather than defaulting: a probe that silently fell back to `Infinity` would
 * keep passing after someone deleted its ceiling, which is the failure the
 * ledger exists to prevent.
 *
 * Resolution is from this file, not `process.cwd()`: perf and scale rigs run
 * under the repo-root vitest configs but a forked child fixture may not.
 */
const LEDGER_PATH = path.resolve(import.meta.dirname, "../journeys.json");

export interface JourneyMetric {
  status: "measured" | "projected" | "unmeasured";
  probe?: string;
  [field: string]: unknown;
}

export interface JourneyEntry {
  surface: string;
  journey: string;
  volume: string;
  hardware: string;
  spans: string[];
  consumers: string[];
  /** Paired-run tolerance: the slow-down this journey may absorb before the candidate rung calls it a regression. */
  tolerancePercent: number;
  metrics: Record<string, JourneyMetric>;
}

const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as {
  entries: Record<string, JourneyEntry>;
  journeys: Record<string, string>;
  volumes: Record<string, string>;
  hardware: Record<string, string>;
};

/** Every entry, for the validators that sweep the whole ledger. */
export function journeyLedger(): Readonly<typeof ledger> {
  return ledger;
}

/** One entry, by its `surface/journey/volume/hardware` key. */
export function journeyEntry(key: string): JourneyEntry {
  const entry = ledger.entries[key];
  if (!entry)
    throw new Error(
      `${key} is not in tests/journeys.json — declare the entry with its spans, consumers and volume before asserting against it`
    );
  return entry;
}

/** One metric of one entry. */
export function journeyMetric(key: string, metric: string): JourneyMetric {
  const found = journeyEntry(key).metrics[metric];
  if (!found)
    throw new Error(`tests/journeys.json ${key} has no metric "${metric}"`);
  return found;
}

/**
 * One numeric ceiling. Throws when the metric is `unmeasured`, so a probe
 * cannot quietly assert against a number nobody observed.
 */
export function journeyCeiling(
  key: string,
  metric: string,
  field: string
): number {
  const found = journeyMetric(key, metric);
  const value = found[field];
  if (typeof value !== "number")
    throw new Error(
      `tests/journeys.json ${key}#${metric} has no numeric "${field}" (status ${found.status}) — seed it from a real run rather than asserting against nothing`
    );
  return value;
}

/**
 * Every numeric ceiling of one metric, keyed by field. For a metric that fences
 * several named things at once — one number per core route, one per soak axis —
 * where naming each field at the call site would say nothing the ledger does
 * not already say. Underscore-prefixed fields are excluded, as they are
 * everywhere else: they are parked intent, not ceilings.
 */
export function journeyNumbers(
  key: string,
  metric: string
): Record<string, number> {
  const found = journeyMetric(key, metric);
  return Object.fromEntries(
    Object.entries(found).filter(
      ([field, value]) => typeof value === "number" && !field.startsWith("_")
    )
  ) as Record<string, number>;
}

/** The same ceiling, or `null` when the metric is deliberately unmeasured. */
export function optionalJourneyCeiling(
  key: string,
  metric: string,
  field: string
): number | null {
  const value = journeyMetric(key, metric)[field];
  return typeof value === "number" ? value : null;
}
