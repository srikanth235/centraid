import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The scripts-side reader for `tests/journeys.json` (#927) — the same ledger
 * `tests/helpers/journeys.ts` serves to TypeScript, with the same rule: a
 * missing entry, metric or numeric field throws rather than defaulting, so a
 * probe cannot run against a ceiling nobody seeded.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");
export const JOURNEY_LEDGER_PATH = path.join(ROOT, "tests/journeys.json");

export interface JourneyMetric {
  status: string;
  [field: string]: unknown;
}

export interface JourneyEntry {
  metrics: Record<string, JourneyMetric>;
  [field: string]: unknown;
}

export interface JourneyLedger {
  entries: Record<string, unknown>;
  [field: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asMetric(value: unknown, where: string): JourneyMetric {
  if (!isRecord(value) || typeof value.status !== "string") {
    throw new Error(`${where} is not a journey metric`);
  }
  return { ...value, status: value.status };
}

function asEntry(value: unknown, key: string): JourneyEntry {
  if (!isRecord(value) || !isRecord(value.metrics)) {
    throw new Error(
      `${key} is not in tests/journeys.json — declare the entry with its spans, consumers and volume before asserting against it`
    );
  }
  const metrics: Record<string, JourneyMetric> = {};
  for (const [name, metric] of Object.entries(value.metrics)) {
    metrics[name] = asMetric(metric, `tests/journeys.json ${key}#${name}`);
  }
  const entry: JourneyEntry = { ...value, metrics };
  return entry;
}

export function journeyLedger(): JourneyLedger {
  const value: unknown = JSON.parse(readFileSync(JOURNEY_LEDGER_PATH, "utf8"));
  if (!isRecord(value) || !isRecord(value.entries)) {
    throw new Error("tests/journeys.json is not a journey ledger");
  }
  return { ...value, entries: value.entries };
}

export function journeyEntry(
  key: string,
  ledger: JourneyLedger = journeyLedger()
): JourneyEntry {
  return asEntry(ledger.entries[key], key);
}

export function journeyMetric(
  key: string,
  metric: string,
  ledger: JourneyLedger = journeyLedger()
): JourneyMetric {
  const found = journeyEntry(key, ledger).metrics[metric];
  if (!found)
    throw new Error(`tests/journeys.json ${key} has no metric "${metric}"`);
  return found;
}

export function journeyCeiling(
  key: string,
  metric: string,
  field: string,
  ledger: JourneyLedger = journeyLedger()
): number {
  const found = journeyMetric(key, metric, ledger);
  const value = found[field];
  if (typeof value !== "number")
    throw new Error(
      `tests/journeys.json ${key}#${metric} has no numeric "${field}" (status ${found.status}) — seed it from a real run rather than asserting against nothing`
    );
  return value;
}

export function optionalJourneyCeiling(
  key: string,
  metric: string,
  field: string,
  ledger: JourneyLedger = journeyLedger()
): number | null {
  const value = journeyMetric(key, metric, ledger)[field];
  return typeof value === "number" ? value : null;
}
