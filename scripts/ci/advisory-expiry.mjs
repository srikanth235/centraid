#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { INVENTORY_PATH, readLedgerSection } from "../check-ledgers.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const LEDGER_LABEL = "tests/inventory.json#advisory";
const WORKFLOW_DIR = path.join(root, ".github/workflows");

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
