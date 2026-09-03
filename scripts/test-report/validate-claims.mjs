#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { validateClaims } from "./claims-schema.mjs";
import { deriveFlows, loadRoster } from "./derive.mjs";
import { validateAppAxes } from "./validate-app-axes.mjs";

const root = path.resolve(import.meta.dirname, "../..");

async function exists(base, relative) {
  try {
    await access(path.join(base, String(relative).split("#")[0]));
    return true;
  } catch {
    return false;
  }
}

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
