#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const HARDEN_RUNNER_ACTION = "step-security/harden-runner";
export const ACCEPTED_EGRESS_POLICIES = ["block", "audit"];

export function executesDependencyCode(source) {
  if (/uses:\s*\.\/\.github\/actions\/setup/u.test(source)) return true;
  return /^\s*(?:-\s*)?run:.*\b(?:bun install|npm ci|npm install|pnpm install|yarn install)\b/mu.test(
    source
  );
}

export function hardenRunnerSteps(source) {
  const lines = source.split("\n");
  const steps = [];
  for (let index = 0; index < lines.length; index += 1) {
    const uses = new RegExp(
      `uses:\\s*(?<ref>${HARDEN_RUNNER_ACTION}@\\S+)`,
      "u"
    ).exec(lines[index]);
    if (uses === null) continue;
    let policy = null;
    for (let scan = index + 1; scan < lines.length; scan += 1) {
      if (/^\s*-\s/u.test(lines[scan])) break;
      const match = /^\s*egress-policy:\s*(?<policy>\S+)/u.exec(lines[scan]);
      if (match !== null) {
        policy = match.groups.policy.replaceAll(/["']/gu, "");
        break;
      }
    }
    steps.push({ ref: uses.groups.ref, policy });
  }
  return steps;
}

export function auditEgress(input) {
  const problems = [];
  const hardened = [];
  const ledgered = [];
  const present = new Set(input.workflows.map((workflow) => workflow.file));

  for (const workflow of input.workflows) {
    const steps = hardenRunnerSteps(workflow.source);
    const inLedger = Object.hasOwn(input.ledger, workflow.file);
    if (steps.length > 0) {
      hardened.push(workflow.file);
      for (const step of steps) {
        if (step.policy === null)
          problems.push(
            `${workflow.file}: harden-runner declares no egress-policy — the default is audit-only, so say so explicitly`
          );
        else if (!ACCEPTED_EGRESS_POLICIES.includes(step.policy))
          problems.push(
            `${workflow.file}: unknown egress-policy "${step.policy}" (expected ${ACCEPTED_EGRESS_POLICIES.join(" or ")})`
          );
      }
      if (inLedger)
        problems.push(
          `stale ledger entry: ${workflow.file} now runs harden-runner — remove it from egress-ledger.json (this ledger only shrinks)`
        );
      continue;
    }
    if (!executesDependencyCode(workflow.source)) continue;
    if (!inLedger) {
      problems.push(
        `${workflow.file} installs and runs dependency code with no ${HARDEN_RUNNER_ACTION} step and no ledger entry — add the step, or ledger the workflow with a reason`
      );
      continue;
    }
    ledgered.push(workflow.file);
    const reason = input.ledger[workflow.file]?.reason;
    if (typeof reason !== "string" || reason.trim() === "")
      problems.push(
        `${workflow.file}: ledger entry has no reason — a bare exemption is not a decision`
      );
  }

  for (const file of Object.keys(input.ledger).sort())
    if (!present.has(file))
      problems.push(
        `stale ledger entry: ${file} is not a workflow in this repo — remove it`
      );

  return { ok: problems.length === 0, problems, hardened, ledgered };
}

function main() {
  const root = path.resolve(import.meta.dirname, "../..");
  const dir = path.join(root, ".github/workflows");
  if (!existsSync(dir)) {
    console.error("lint-ci-egress: .github/workflows is missing");
    process.exit(1);
  }
  const workflows = readdirSync(dir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort()
    .map((file) => ({
      file,
      source: readFileSync(path.join(dir, file), "utf8"),
    }));
  const ledger = JSON.parse(
    readFileSync(path.join(import.meta.dirname, "egress-ledger.json"), "utf8")
  );
  const result = auditEgress({ workflows, ledger: ledger.workflows ?? {} });
  for (const problem of result.problems)
    console.error(`lint-ci-egress: ${problem}`);
  if (!result.ok) {
    console.error(`lint-ci-egress: ${result.problems.length} problem(s)`);
    process.exit(1);
  }
  console.info(
    `lint-ci-egress: ${result.hardened.length} workflow(s) enforce an egress policy, ${result.ledgered.length} pinned as debt in egress-ledger.json`
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === `file://${process.argv[1]}`
)
  main();
