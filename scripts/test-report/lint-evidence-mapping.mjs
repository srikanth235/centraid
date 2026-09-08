#!/usr/bin/env node
/**
 * `bun run lint:evidence-mapping` — unmapped evidence is a rung-2 lint
 * failure, not a report banner (#915 Wave 3).
 *
 * Two directions, and both matter:
 *
 *   1. every `Write lane evidence` step in every workflow names a lane the
 *      claims file registers — otherwise the night's evidence directory
 *      carries a file the report has no row for, and the reader cannot tell a
 *      lane that vanished from a lane that was never registered;
 *   2. every such step names its lane consistently with the registry's rung
 *      and platform, so `--rung 4` in YAML and `rung: 2` in the registry
 *      cannot disagree about which question the lane answers.
 *
 * The converse — a registered lane with no workflow step yet — is a WARNING,
 * not a failure: the registry is allowed to run ahead of the wiring, and the
 * lane renders as `no evidence` on the board until the step lands, which is
 * the honest state and already visible.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { loadClaims } from "./claims-schema.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const WORKFLOWS = path.join(ROOT, ".github/workflows");

/** The `--flag value` pairs of one `write-evidence.mjs` invocation. */
export function parseStep(command) {
  const flags = {};
  for (const match of command.matchAll(
    /--(?<flag>[a-z-]+)\s+(?<value>"[^"]*"|\S+)/gu
  )) {
    flags[match.groups.flag] = match.groups.value.replace(/^"|"$/gu, "");
  }
  return flags;
}

/**
 * A lane id as the registry spells it.
 *
 * Two shapes in the workflows are not literal job ids and both are legitimate:
 * a matrix leg (`coverage-shard-${{ matrix.shard }}`) writes one file per leg
 * under one registered lane, and a loop over reusable-workflow results writes
 * several lanes from one step with `--lane "$lane"`. The first is resolved by
 * dropping the expression suffix; the second by reading the literal lane names
 * out of the loop's own list, which is why `stepsIn` keeps the block around
 * each invocation.
 */
export function resolveLanes(raw, block) {
  if (!raw) return [];
  if (!raw.includes("$")) return [raw];
  const base = raw.split(/-?\$/u)[0].replace(/-$/u, "");
  if (base && !base.includes("$")) return [base];
  const literals = [...block.matchAll(/"(?<lane>[a-z0-9][a-z0-9._-]*):/gu)].map(
    (match) => match.groups.lane
  );
  return [...new Set(literals)];
}

/**
 * Every evidence-writing step in a workflow's source, with the block around it
 * so a templated `--lane` can be resolved against the step's own lane list.
 */
export function stepsIn(source) {
  const steps = [];
  const pattern =
    /node scripts\/test-report\/write-evidence\.mjs(?<rest>[\s\S]*?)(?=\n\s*(?:-\s|\w+:)|\n\n|$)/gu;
  for (const match of source.matchAll(pattern)) {
    const flags = parseStep(match.groups.rest.replaceAll(/\\\s*\n\s*/gu, " "));
    const block = source.slice(
      Math.max(0, match.index - 900),
      match.index + match[0].length
    );
    steps.push({ ...flags, lanes: resolveLanes(flags.lane, block) });
  }
  return steps;
}

/** The rule engine, pure over an injected world. */
export function checkEvidenceMapping({ workflows, lanes }) {
  const errors = [];
  const warnings = [];
  const registry = new Map(lanes.map((lane) => [lane.id, lane]));
  const wired = new Set();

  for (const [file, source] of Object.entries(workflows)) {
    for (const step of stepsIn(source)) {
      if (step.lanes.length === 0) {
        errors.push(
          `${file}: a \`Write lane evidence\` step names no resolvable --lane (got ${JSON.stringify(step.lane ?? null)})`
        );
        continue;
      }
      for (const lane of step.lanes) {
        wired.add(lane);
        const registered = registry.get(lane);
        if (!registered) {
          errors.push(
            `${file}: writes evidence for lane "${lane}", which tests/claims.json#lanes does not register. ` +
              `Register it (id, rung, platform, budgetMs, qualities, surfaces, status) or stop writing it — ` +
              `unmapped evidence is a file the report has no row for.`
          );
          continue;
        }
        if (step.rung && Number(step.rung) !== registered.rung) {
          errors.push(
            `${file}: lane "${lane}" writes --rung ${step.rung}; the registry puts it on rung ${registered.rung}`
          );
        }
        if (
          step.platform &&
          !step.platform.includes("$") &&
          step.lanes.length === 1 &&
          step.platform !== registered.platform
        ) {
          errors.push(
            `${file}: lane "${lane}" writes --platform ${step.platform}; the registry says ${registered.platform}`
          );
        }
      }
    }
  }

  for (const lane of registry.keys()) {
    if (!wired.has(lane)) {
      warnings.push(
        `lane "${lane}" is registered but no workflow writes its evidence yet — it renders as no evidence`
      );
    }
  }
  return { errors, warnings };
}

/** Read every workflow file. */
function readWorkflows(dir) {
  const workflows = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    workflows[`.github/workflows/${name}`] = readFileSync(
      path.join(dir, name),
      "utf8"
    );
  }
  return workflows;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  const { claims, errors: claimErrors } = loadClaims();
  if (claimErrors.length > 0) {
    for (const error of claimErrors)
      process.stderr.write(`evidence-mapping: ${error}\n`);
    process.exitCode = 1;
  } else {
    const { errors, warnings } = checkEvidenceMapping({
      workflows: readWorkflows(WORKFLOWS),
      lanes: claims.lanes,
    });
    for (const warning of warnings)
      process.stderr.write(`evidence-mapping: warning: ${warning}\n`);
    if (errors.length > 0) {
      for (const error of errors)
        process.stderr.write(`evidence-mapping: ${error}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `evidence-mapping: ${claims.lanes.length} registered lanes, every evidence step mapped\n`
      );
    }
  }
}
