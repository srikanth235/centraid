#!/usr/bin/env node
/**
 * Compatibility entry for leftover `.mjs` consumers and the constitution
 * coverage-scope-reachability directive (`node …/derive-flows.mjs --json`).
 */
import { flowOwnerView } from "./derive-flows.ts";

try {
  const view = await flowOwnerView();
  const wantsJson = process.argv.includes("--json");
  process.stdout.write(
    wantsJson
      ? `${JSON.stringify(view)}\n`
      : `${view.flows.map((flow) => flow.owner).join("\n")}\n`
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`derive-flows: ${message}\n`);
  process.exitCode = 1;
}
