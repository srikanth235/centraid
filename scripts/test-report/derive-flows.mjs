#!/usr/bin/env node

import path from "node:path";

import { loadClaims } from "./claims-schema.mjs";
import { deriveFlows, loadRoster } from "./derive.mjs";

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
