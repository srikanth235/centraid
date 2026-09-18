#!/usr/bin/env node
/**
 * The derived flow-ownership view (#915 Wave 3).
 *
 * The constitution's `coverage-scope-reachability` directive used to read
 * `tests/matrix.json#flows[].owner` directly. `tests/claims.json` keeps that
 * register now, so the directive shells out to this CLI instead of parsing the
 * file: one deterministic, offline view, and one place to change when the
 * source moves again. The mobile roster that used to contribute the other half
 * of the flows was retired with the v0 tree (#1020).
 *
 * Deterministic and offline on purpose — a network call or a clock read here
 * would make a governance check nondeterministic.
 *
 *   node scripts/test-report/derive-flows.mjs --json   # {"flows":[{id,owner}]}
 *   node scripts/test-report/derive-flows.mjs          # one owner path per line
 */

import path from "node:path";

import { loadClaims } from "./claims-schema.mjs";

/**
 * The flow ownership view: every flow the claims file declares, sorted by id.
 * @param {object} claims a parsed claims file
 * @returns {{id: string, owner: string, surface: string|null, dimension: string|null, tier: string|null, minimumTests: number|null}[]} one row per declared flow
 */
export function deriveFlows(claims) {
  return (claims.flows ?? [])
    .map((flow) => ({
      id: flow.id,
      owner: flow.owner,
      surface: flow.surface ?? null,
      dimension: flow.dimension ?? null,
      tier: flow.tier ?? null,
      minimumTests: flow.minimumTests ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The `{flows:[{id, owner}]}` view, sorted by id. */
export function flowOwnerView() {
  const { claims, errors } = loadClaims();
  if (!claims) throw new Error(errors.join("; "));
  return {
    flows: deriveFlows(claims).map((flow) => ({
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
    const view = flowOwnerView();
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
