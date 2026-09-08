#!/usr/bin/env node
/**
 * The derived flow-ownership view (#915 Wave 3).
 *
 * The constitution's `coverage-scope-reachability` directive used to read
 * `tests/matrix.json#flows[].owner` directly. `tests/claims.json` keeps the
 * hand-typed half of that register and the mobile roster owns the rest, so the
 * directive now shells out to this CLI instead of parsing either file: one
 * deterministic, offline view, and one place to change when the sources move
 * again.
 *
 *   node scripts/test-report/derive-flows.mjs --json   # {"flows":[{id,owner}]}
 *   node scripts/test-report/derive-flows.mjs          # one owner path per line
 */

import path from "node:path";

import { loadClaims } from "./claims-schema.mjs";
import { deriveFlows, loadRoster } from "./derive.mjs";

/** The `{flows:[{id, owner}]}` view, sorted by id. */
export async function flowOwnerView() {
  const { claims, errors } = loadClaims();
  if (!claims) throw new Error(errors.join("; "));
  const roster = await loadRoster();
  return {
    flows: deriveFlows(claims, roster).map((flow) => ({
      id: flow.id,
      owner: flow.owner,
    })),
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.filename)
) {
  try {
    const view = await flowOwnerView();
    const wantsJson = process.argv.includes("--json");
    process.stdout.write(
      wantsJson
        ? `${JSON.stringify(view)}\n`
        : `${view.flows.map((flow) => flow.owner).join("\n")}\n`
    );
  } catch (error) {
    process.stderr.write(`derive-flows: ${error.message}\n`);
    process.exitCode = 1;
  }
}
