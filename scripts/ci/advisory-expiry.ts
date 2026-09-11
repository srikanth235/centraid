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
 * Usage: node scripts/ci/advisory-expiry.ts [--today YYYY-MM-DD]
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { INVENTORY_PATH, readLedgerSection } from "../check-ledgers.mjs";

const root = path.resolve(import.meta.dirname, "../..");
/** The advisory register: `tests/inventory.json#advisory.steps` (#915 Wave 4). */
const LEDGER_LABEL = "tests/inventory.json#advisory";
const WORKFLOW_DIR = path.join(root, ".github/workflows");
const ADVISORY_FIELDS = ["owner", "issue", "revisitBy", "why"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AdvisoryStep {
  id: string;
  name: string;
}

/** Step names that declare themselves advisory. */
export function advisorySteps(file: string, source: string): AdvisoryStep[] {
  const found: AdvisoryStep[] = [];
  for (const line of source.split("\n")) {
    const match = /^\s*-\s*name:\s*(?<name>.+?)\s*$/u.exec(line);
    if (!match) continue;
    const name = match.groups?.["name"]?.replace(/^["']|["']$/gu, "");
    if (!name) continue;
    if (!/\bAdvisory\b|\(non-blocking\)/iu.test(name)) continue;
    found.push({ id: `${file}: ${name}`, name });
  }
  return found;
}

export function checkAdvisories(
  steps: ReadonlyArray<{ id: string }>,
  ledger: Record<string, unknown>,
  today: string
): string[] {
  const errors: string[] = [];
  const ids = new Set(steps.map((step) => step.id));

  for (const step of steps) {
    const entry = ledger[step.id];
    if (!isRecord(entry)) {
      errors.push(
        `\`${step.id}\` announces itself as advisory but has no entry in ${LEDGER_LABEL}. ` +
          `A step that can never fail needs an owner, an issue and a date by which somebody decides whether it should stay one.`
      );
      continue;
    }
    for (const field of ADVISORY_FIELDS) {
      if (!entry[field]) {
        errors.push(`\`${step.id}\` ledger entry is missing \`${field}\``);
      }
    }
    const revisitBy = entry["revisitBy"];
    if (typeof revisitBy !== "string" || revisitBy.length === 0) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(revisitBy)) {
      errors.push(
        `\`${step.id}\` has revisitBy \`${revisitBy}\`, which is not an ISO date`
      );
      continue;
    }
    if (revisitBy < today) {
      errors.push(
        `\`${step.id}\` was due for a decision on ${revisitBy} (today is ${today}). ` +
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

function advisoryLedgerSteps(section: unknown): Record<string, unknown> {
  if (!isRecord(section) || !isRecord(section.steps)) return {};
  return section.steps;
}

function main(): void {
  const todayFlag = process.argv.indexOf("--today");
  const todayArg = todayFlag === -1 ? undefined : process.argv[todayFlag + 1];
  const today =
    todayArg !== undefined && todayArg.length > 0
      ? todayArg
      : new Date().toISOString().slice(0, 10);

  const steps: AdvisoryStep[] = [];
  for (const name of readdirSync(WORKFLOW_DIR).sort()) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const source = readFileSync(path.join(WORKFLOW_DIR, name), "utf8");
    steps.push(...advisorySteps(`.github/workflows/${name}`, source));
  }

  const section: unknown = readLedgerSection(INVENTORY_PATH, "advisory");
  const ledger = advisoryLedgerSteps(section);
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
