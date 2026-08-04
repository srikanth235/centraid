#!/usr/bin/env node
/**
 * Run the accessibility contract (`scripts/accessibility-contract.test.mjs`) and
 * write report evidence so nightly zero-grey can see the 15 `*:accessibility`
 * cells (#676). `node --test` does not feed vitest.json; this wrapper is the
 * single path for both `bun run test:accessibility` and the e2e report job.
 */
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const owner = "scripts/accessibility-contract.test.mjs";
const started = Date.now();

const result = spawnSync(process.execPath, ["--test", path.join(root, owner)], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});

const elapsedMs = Date.now() - started;
const exitCode = result.status ?? 1;
const status = exitCode === 0 ? "passed" : "failed";

const evidenceDir = path.join(root, "artifacts", "e2e");
await mkdir(evidenceDir, { recursive: true });
const evidencePath = path.join(evidenceDir, "accessibility-contract.json");
await writeFile(
  evidencePath,
  `${JSON.stringify(
    {
      lane: "e2e",
      owner,
      name: "accessibility-contract",
      status,
      capturedAt: new Date().toISOString(),
      measurements: [{ name: "wall clock", value: elapsedMs, unit: "ms" }],
    },
    null,
    2
  )}\n`,
  "utf8"
);

console.log(
  `accessibility evidence: ${path.relative(root, evidencePath)} (${status}, ${elapsedMs}ms)`
);

process.exit(exitCode);
