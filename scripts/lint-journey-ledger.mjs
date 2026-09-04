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
  "scripts/lint-journey-ledger.mjs",
  "scripts/lint-journey-ledger.test.mjs",
  "tests/journeys.json",
  "tests/quality/classification-ratchet.json",
]);

/**
 * Every source file a stale reference could hide in.
 * @yields {string} Absolute path of one candidate file.
 */
function* sources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(abs);
    else if (SEARCH_SUFFIXES.some((s) => entry.name.endsWith(s))) yield abs;
  }
}

export function lintJourneyLedger(root = ROOT) {
  const errors = [];
  const ledger = JSON.parse(
    readFileSync(path.join(root, "tests/journeys.json"), "utf8")
  );
  const entries = ledger.entries ?? {};

  for (const [key, entry] of Object.entries(entries)) {
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
    if (!ledger.journeys?.[journey])
      errors.push(
        `journey-ledger: "${key}" names undeclared journey ${journey}`
      );
    if (!ledger.volumes?.[volume])
      errors.push(`journey-ledger: "${key}" names undeclared volume ${volume}`);
    if (!ledger.hardware?.[hardware])
      errors.push(
        `journey-ledger: "${key}" names undeclared hardware ${hardware}`
      );
    if (!Array.isArray(entry.spans) || !Array.isArray(entry.consumers))
      errors.push(`journey-ledger: "${key}" needs spans[] and consumers[]`);
    else if (entry.spans.length === 0 && entry.consumers.length === 0)
      errors.push(
        `journey-ledger: "${key}" names no span and no consumer — a ceiling nothing measures and nothing asserts is not a gate`
      );
    for (const consumer of entry.consumers ?? []) {
      const file = consumer.split(" ")[0];
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
    for (const [name, metric] of Object.entries(entry.metrics ?? {})) {
      const numbers = Object.entries(metric).filter(
        ([field, value]) => typeof value === "number" && !field.startsWith("_")
      );
      if (
        metric.status === "bound" &&
        typeof metric._provenance?.note !== "string"
      )
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

  for (const [owner, rig] of Object.entries(ledger.rigs ?? {}))
    for (const key of rig.entries ?? [])
      if (!entries[key])
        errors.push(`journey-ledger: rig ${owner} names missing entry ${key}`);

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
