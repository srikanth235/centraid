#!/usr/bin/env node
/**
 * Advisory-output expiry ratchet (#892 Phase 3).
 *
 * Everything else in this repo that could go quietly wrong has a budget, a
 * ledger or an expiry: quarantined tests expire, environment-red tests carry an
 * issue and a revisit trigger, sleeps and assertion-hygiene counts are down-only,
 * every coverage and mutation floor is tighten-only. Two CI outputs had none —
 *
 *   ci.yml `Report generated binding drift (non-blocking)`
 *   ci.yml `Advisory — Expo compatibility map (non-blocking)`
 *
 * — and they are the ones that need it most, because a non-blocking annotation
 * is exactly where a real regression hides longest: it is printed on every run,
 * nobody is on the hook to read it, and its normal state is "there is output".
 *
 * THE RULE. A step whose NAME declares it advisory (`Advisory` or
 * `(non-blocking)`) must be registered in `tests/inventory.json#advisory` with an
 * owner, an issue and a `revisitBy` date. A past date fails this gate — the
 * advisory has been advisory for as long as somebody said it should be, and the
 * next move is a decision (make it blocking, delete it, or extend the date on
 * purpose), not another quarter of nobody reading it.
 *
 * A ledger entry naming a step that no longer exists ALSO fails: a stale
 * exemption reads like a reviewed decision.
 *
 * Deliberately NOT covered: `continue-on-error: true` in general. Most of those
 * are artifact restores whose failure is benign and whose consequence IS
 * re-checked (the nightly quality lane reads every step outcome back and fails
 * on any non-success). Sweeping them in would flood the gate and teach people to
 * widen it. This rule is about steps that ANNOUNCE they will never fail.
 *
 * Usage: node scripts/ci/advisory-expiry.mjs [--today YYYY-MM-DD]
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { INVENTORY_PATH, readLedgerSection } from "../check-ledgers.mjs";

const root = path.resolve(import.meta.dirname, "../..");
/** The advisory register: `tests/inventory.json#advisory.steps` (#915 Wave 4). */
const LEDGER_LABEL = "tests/inventory.json#advisory";
const WORKFLOW_DIR = path.join(root, ".github/workflows");

/** Step names that declare themselves advisory. */
export function advisorySteps(file, source) {
  const found = [];
  for (const line of source.split("\n")) {
    const match = /^\s*-\s*name:\s*(?<name>.+?)\s*$/u.exec(line);
    if (!match) continue;
    const name = match.groups.name.replace(/^["']|["']$/gu, "");
    if (!/\bAdvisory\b|\(non-blocking\)/iu.test(name)) continue;
    found.push({ id: `${file}: ${name}`, name });
  }
  return found;
}

/**
 * @param {{id: string}[]} steps advisory steps discovered in the workflows
 * @param {Record<string, {owner?: string, issue?: string, revisitBy?: string, why?: string}>} ledger the recorded owners, issues and dates
 * @param {string} today ISO date to compare `revisitBy` against
 */
export function checkAdvisories(steps, ledger, today) {
  const errors = [];
  const ids = new Set(steps.map((step) => step.id));

  for (const step of steps) {
    const entry = ledger[step.id];
    if (!entry) {
      errors.push(
        `\`${step.id}\` announces itself as advisory but has no entry in ${LEDGER_LABEL}. ` +
          `A step that can never fail needs an owner, an issue and a date by which somebody decides whether it should stay one.`
      );
      continue;
    }
    for (const field of ["owner", "issue", "revisitBy", "why"]) {
      if (!entry[field]) {
        errors.push(`\`${step.id}\` ledger entry is missing \`${field}\``);
      }
    }
    if (!entry.revisitBy) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(entry.revisitBy)) {
      errors.push(
        `\`${step.id}\` has revisitBy \`${entry.revisitBy}\`, which is not an ISO date`
      );
      continue;
    }
    if (entry.revisitBy < today) {
      errors.push(
        `\`${step.id}\` was due for a decision on ${entry.revisitBy} (today is ${today}). ` +
          `Make it blocking, delete it, or extend the date deliberately — an advisory nobody revisits is where a regression hides longest.`
      );
    }
  }

  for (const id of Object.keys(ledger)) {
    if (id.startsWith("_")) continue;
    if (!ids.has(id)) {
      errors.push(
        `ledger entry \`${id}\` names an advisory step that no longer exists — a stale exemption reads like a reviewed decision. Remove it.`
      );
    }
  }

  return errors;
}

function main() {
  const todayFlag = process.argv.indexOf("--today");
  const today =
    todayFlag !== -1 && process.argv[todayFlag + 1]
      ? process.argv[todayFlag + 1]
      : new Date().toISOString().slice(0, 10);

  const steps = [];
  for (const name of readdirSync(WORKFLOW_DIR).sort()) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const source = readFileSync(path.join(WORKFLOW_DIR, name), "utf8");
    steps.push(...advisorySteps(`.github/workflows/${name}`, source));
  }

  const ledger = readLedgerSection(INVENTORY_PATH, "advisory")?.steps ?? {};
  const errors = checkAdvisories(steps, ledger, today);
  if (errors.length) {
    for (const error of errors) console.error(`advisory-expiry: ${error}`);
    console.error(`advisory-expiry: ${errors.length} problem(s)`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `advisory-expiry: ${steps.length} advisory step(s) owned, dated and unexpired as of ${today}`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  main();
}
