#!/usr/bin/env node
/**
 * `bun run test:claims` — the claims-file law (#915 Wave 3).
 *
 * The predecessor, `validate-matrix.mjs`, was 622 lines because it graded a
 * hand-typed 15 × 11 assessment grid against evidence: every cell had a
 * declared status, a computed ceiling, an owner and a note, and the validator
 * held all four in agreement. #915 deleted the declared half — §7 is now the
 * join of lane tags with tonight's verdicts — so what is left to check is much
 * smaller and much sharper:
 *
 *   1. the file matches its schema (`claims-schema.mjs`);
 *   2. every owner path a claim, flow, law, join law or consent layer names
 *      exists on disk — a registry pointing at a deleted file is a claim with
 *      nothing behind it;
 *   3. the app-axis registries still agree with the code (`validate-app-axes`,
 *      which calls `validate-app-scenarios` and `validate-report-registries`);
 *   4. every revisit trigger that has fired is reported.
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { validateClaims } from "./claims-schema.mjs";
import { deriveFlows, loadRoster } from "./derive.mjs";
import { validateAppAxes } from "./validate-app-axes.mjs";

const root = path.resolve(import.meta.dirname, "../..");

/** True when `relative` exists under `base`. */
async function exists(base, relative) {
  try {
    await access(path.join(base, String(relative).split("#")[0]));
    return true;
  } catch {
    return false;
  }
}

/**
 * A revisit trigger has FIRED when a file matching its glob contains its
 * pattern: the compat tripwire that says "this cell's assumption may have
 * moved, go and look".
 */
export async function firedTriggers(claims, { root: base, glob }) {
  const triggers = Object.entries(claims.revisitTriggers ?? {});
  const scans = await Promise.all(
    triggers.map(async ([cell, trigger]) => {
      const pattern = new RegExp(trigger.contains, "u");
      const files = await Array.fromAsync(glob(trigger.glob, { cwd: base }));
      const sources = await Promise.all(
        files.map((file) => readFile(path.join(base, file), "utf8"))
      );
      const hit = files.find((_file, index) => pattern.test(sources[index]));
      return hit
        ? { cell, file: hit, trackingIssue: trigger.trackingIssue }
        : null;
    })
  );
  return scans.filter(Boolean);
}

/**
 * The whole law, as errors and warnings.
 * @param {object} claims a parsed claims file
 * @param {{root?: string, checkFiles?: boolean}} [options] the repo root, and whether to stat the owner paths
 */
export async function validateClaimsFile(claims, options = {}) {
  const base = options.root ?? root;
  const checkFiles = options.checkFiles !== false;
  const { errors } = validateClaims(claims);
  const warnings = [];

  const roster = await loadRoster();
  const flows = deriveFlows(claims, roster);
  const flowIds = new Set(flows.map((flow) => flow.id));

  if (checkFiles) {
    const owners = new Map();
    for (const claim of claims.claims ?? [])
      owners.set(claim.owner, `claim ${claim.id}`);
    for (const flow of flows) owners.set(flow.owner, `flow ${flow.id}`);
    for (const [tag, law] of Object.entries(claims.laws ?? {}))
      owners.set(law.owner, `law ${tag}`);
    for (const law of claims.joinLaws ?? [])
      owners.set(law.owner, `join law ${law.id}`);
    for (const layer of claims.consentLedger ?? []) {
      for (const enforcement of layer.enforcement ?? []) {
        owners.set(enforcement, `consent layer ${layer.id}`);
      }
    }
    const entries = [...owners].filter(([owner]) => owner);
    const present = await Promise.all(
      entries.map(([owner]) => exists(base, owner))
    );
    entries.forEach(([owner, who], index) => {
      if (!present[index]) {
        errors.push(`${who}: owner "${owner}" does not exist on disk`);
      }
    });
  }

  for (const [tag, law] of Object.entries(claims.laws ?? {})) {
    if (law.flow && !flowIds.has(law.flow)) {
      errors.push(
        `law "${tag}" names flow "${law.flow}", which is not a derived flow id`
      );
    }
  }

  // The lane registry is the contract the evidence writer and the workflows
  // build against; a rung with no lane at all is a rung nobody is watching.
  for (const rung of [2, 3, 4, 5]) {
    if (!(claims.lanes ?? []).some((lane) => lane.rung === rung)) {
      warnings.push(`no lane is registered on rung ${rung}`);
    }
  }

  errors.push(
    ...(await validateAppAxes(claims, { root: base, checkFiles }, flowIds))
  );

  return { errors, warnings, flowIds, lanes: claims.lanes ?? [] };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  const file = path.resolve(
    process.argv[2] ?? path.join(root, "tests/claims.json")
  );
  const claims = JSON.parse(await readFile(file, "utf8"));
  const { errors, warnings, flowIds, lanes } = await validateClaimsFile(claims);
  for (const warning of warnings)
    process.stderr.write(`claims: warning: ${warning}\n`);
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`claims: ${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `claims: ${(claims.claims ?? []).length} claims, ${lanes.length} lanes, ${flowIds.size} derived flows, ${Object.keys(claims.naCells ?? {}).length} deliberate n/a cells\n`
    );
  }
}
