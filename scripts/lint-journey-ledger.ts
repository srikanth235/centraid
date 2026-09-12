#!/usr/bin/env node
/*
 * THE JOURNEY LEDGER'S OWN SHAPE (#927).
 *
 * `tests/journeys.json` replaced four per-surface experience files, the rig
 * register and the query-count file. One ledger is only better than five if it
 * cannot rot in the ways they did, so this fails on exactly those:
 *
 *   - a key that is not `surface/journey/volume/hardware`, or that disagrees
 *     with the entry's own fields;
 *   - a journey, volume or hardware the ledger has not declared, so nobody can
 *     write "at year-3" without saying what year-3 is;
 *   - an entry with no SPANS and no CONSUMERS — a ceiling nothing measures and
 *     nothing asserts, which is how four of the old files' entries lived;
 *   - a consumer path that does not exist, which is how a ceiling outlives the
 *     rig that produced it;
 *   - a rig cross-link naming an entry that is gone;
 *   - a `measured` metric with no numeric ceiling, an `unmeasured` one that
 *     ships a number anyway, or a `bound` one that does not argue its bound;
 *   - a hole in the nine-journey x four-surface grid;
 *   - ANY surviving reference to the files this ledger replaced.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const RETIRED = [
  "tests/experience-budgets/",
  "tests/budgets.json#qualityRigs",
  "tests/quality-rig-budgets.json",
];
const SEARCH_ROOTS = ["apps", "packages", "scripts", "tests", ".github"];
const SEARCH_SUFFIXES = [".ts", ".tsx", ".mjs", ".js", ".json", ".yml"];
const EXEMPT = new Set([
  "scripts/lint-journey-ledger.ts",
  "scripts/lint-journey-ledger.test.ts",
  "tests/journeys.json",
  "tests/quality/classification-ratchet.json",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Every source file a stale reference could hide in.
 * @yields {string} Absolute path of one candidate file.
 */
function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(abs);
    else if (SEARCH_SUFFIXES.some((s) => entry.name.endsWith(s))) yield abs;
  }
}

export function lintJourneyLedger(root = ROOT): string[] {
  const errors: string[] = [];
  const ledger: unknown = JSON.parse(
    readFileSync(path.join(root, "tests/journeys.json"), "utf8")
  );
  const ledgerRecord = isRecord(ledger) ? ledger : {};
  const entries = isRecord(ledgerRecord.entries) ? ledgerRecord.entries : {};

  for (const [key, rawEntry] of Object.entries(entries)) {
    const entry = isRecord(rawEntry) ? rawEntry : {};
    // `entries` is a ratcheted SECTION as well as a map of journeys, and
    // scripts/check-ledgers.mjs reads a re-key's waiver from this object's own
    // `approvedDeviation` (a neighbouring section's never waives, #781). It is
    // the section's note, not a journey, so it is not held to the key grammar.
    if (key === "approvedDeviation" || key.startsWith("_")) continue;
    const parts = key.split("/");
    if (parts.length !== 4) {
      errors.push(
        `journey-ledger: "${key}" is not surface/journey/volume/hardware`
      );
      continue;
    }
    const [surface, journey, volume, hardware] = parts;
    if (
      entry.surface !== surface ||
      entry.journey !== journey ||
      entry.volume !== volume ||
      entry.hardware !== hardware
    )
      errors.push(`journey-ledger: "${key}" disagrees with its own fields`);
    const journeys = isRecord(ledgerRecord.journeys)
      ? ledgerRecord.journeys
      : {};
    const volumes = isRecord(ledgerRecord.volumes) ? ledgerRecord.volumes : {};
    const hardwareTable = isRecord(ledgerRecord.hardware)
      ? ledgerRecord.hardware
      : {};
    if (journey !== undefined && !journeys[journey])
      errors.push(
        `journey-ledger: "${key}" names undeclared journey ${journey}`
      );
    if (volume !== undefined && !volumes[volume])
      errors.push(`journey-ledger: "${key}" names undeclared volume ${volume}`);
    if (hardware !== undefined && !hardwareTable[hardware])
      errors.push(
        `journey-ledger: "${key}" names undeclared hardware ${hardware}`
      );
    if (!Array.isArray(entry.spans) || !Array.isArray(entry.consumers))
      errors.push(`journey-ledger: "${key}" needs spans[] and consumers[]`);
    else if (entry.spans.length === 0 && entry.consumers.length === 0)
      errors.push(
        `journey-ledger: "${key}" names no span and no consumer — a ceiling nothing measures and nothing asserts is not a gate`
      );
    const consumers = Array.isArray(entry.consumers) ? entry.consumers : [];
    for (const consumer of consumers) {
      if (typeof consumer !== "string") continue;
      const file = consumer.split(" ")[0];
      if (file === undefined) continue;
      try {
        statSync(path.join(root, file));
      } catch {
        errors.push(
          `journey-ledger: "${key}" names consumer ${file}, which does not exist`
        );
      }
    }
    if (typeof entry.tolerancePercent !== "number")
      errors.push(
        `journey-ledger: "${key}" needs a tolerancePercent — the paired candidate/PR run needs to know what slow-down this journey may absorb`
      );
    const metrics = isRecord(entry.metrics) ? entry.metrics : {};
    for (const [name, rawMetric] of Object.entries(metrics)) {
      const metric = isRecord(rawMetric) ? rawMetric : {};
      const numbers = Object.entries(metric).filter(
        ([field, value]) => typeof value === "number" && !field.startsWith("_")
      );
      const provenance = isRecord(metric._provenance) ? metric._provenance : {};
      if (metric.status === "bound" && typeof provenance.note !== "string")
        errors.push(
          `journey-ledger: "${key}"#${name} is a catastrophe bound with no _provenance.note arguing it`
        );
      if (metric.status === "measured" && numbers.length === 0)
        errors.push(
          `journey-ledger: "${key}"#${name} is measured but ships no ceiling`
        );
      if (metric.status === "unmeasured" && numbers.length > 0)
        errors.push(
          `journey-ledger: "${key}"#${name} is unmeasured but ships ${numbers.map(([f]) => f).join(", ")} — park it under a leading underscore or measure it`
        );
    }
  }

  // THE GRID. Nine journeys x four surfaces, and every cell has an entry —
  // `unmeasured` with a reason is an answer, a missing row is not. Before this
  // the absence of a share number on any surface was invisible: nothing named
  // the journeys, so nothing could notice one had no home.
  const NINE = [
    "cold-open",
    "warm-switch",
    "own-echo",
    "peer-echo",
    "converge",
    "share",
    "search",
    "scroll",
    "first-bootstrap",
  ];
  const covered = new Set(
    Object.values(entries).map((raw) => {
      const entry = isRecord(raw) ? raw : {};
      return `${entry.surface}/${entry.journey}`;
    })
  );
  for (const surface of ["web", "desktop", "mobile", "gateway"])
    for (const journey of NINE)
      if (!covered.has(`${surface}/${journey}`))
        errors.push(
          `journey-ledger: no entry for ${surface}/${journey} — an unmeasured entry with a reason is an answer, a missing row is not`
        );

  const rigs = isRecord(ledgerRecord.rigs) ? ledgerRecord.rigs : {};
  for (const [owner, rawRig] of Object.entries(rigs)) {
    const rig = isRecord(rawRig) ? rawRig : {};
    const rigEntries = Array.isArray(rig.entries) ? rig.entries : [];
    for (const key of rigEntries) {
      if (typeof key === "string" && !entries[key])
        errors.push(`journey-ledger: rig ${owner} names missing entry ${key}`);
    }
  }

  for (const dir of SEARCH_ROOTS)
    for (const file of sources(path.join(root, dir))) {
      const rel = path.relative(root, file);
      // A file may name what was replaced when naming it IS its subject: this
      // linter and its test, the ledger's own comment, and the classification
      // ratchet's approvedDeviation, which is the governed record of the move.
      if (EXEMPT.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const retired of RETIRED)
        if (text.includes(retired))
          errors.push(
            `journey-ledger: ${rel} still names ${retired} — the journey ledger replaced it`
          );
    }
  return errors;
}

if (process.argv[1] === import.meta.filename) {
  const errors = lintJourneyLedger();
  for (const error of errors) console.error(error);
  console.log(
    errors.length === 0
      ? "journey-ledger: ok — every entry names its volume, hardware, spans and consumers"
      : `journey-ledger: ${errors.length} problem(s)`
  );
  process.exitCode = errors.length === 0 ? 0 : 1;
}
