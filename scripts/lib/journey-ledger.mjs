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

export function journeyLedger() {
  return JSON.parse(readFileSync(JOURNEY_LEDGER_PATH, "utf8"));
}

export function journeyEntry(key, ledger = journeyLedger()) {
  const entry = ledger.entries[key];
  if (!entry)
    throw new Error(
      `${key} is not in tests/journeys.json — declare the entry with its spans, consumers and volume before asserting against it`
    );
  return entry;
}

export function journeyMetric(key, metric, ledger = journeyLedger()) {
  const found = journeyEntry(key, ledger).metrics[metric];
  if (!found)
    throw new Error(`tests/journeys.json ${key} has no metric "${metric}"`);
  return found;
}

export function journeyCeiling(key, metric, field, ledger = journeyLedger()) {
  const found = journeyMetric(key, metric, ledger);
  if (typeof found[field] !== "number")
    throw new Error(
      `tests/journeys.json ${key}#${metric} has no numeric "${field}" (status ${found.status}) — seed it from a real run rather than asserting against nothing`
    );
  return found[field];
}

export function optionalJourneyCeiling(
  key,
  metric,
  field,
  ledger = journeyLedger()
) {
  const value = journeyMetric(key, metric, ledger)[field];
  return typeof value === "number" ? value : null;
}
