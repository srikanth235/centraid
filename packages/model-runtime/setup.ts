#!/usr/bin/env bun
// `bun run --cwd packages/model-runtime setup` — a thin CLI over
// `ensureModelAssets` (#1011). It is the developer-facing half of the ONE
// download path; the gateway calls the same function at first boot. It:
//   1. runs `bun install` inside runtime/ (never at the repo root), which
//      is the one place native/optional recognition dependencies get installed;
//   2. calls `ensureModelAssets` for every capability the manifest knows,
//      which verifies each pinned file by sha256 and fetches what is
//      missing or altered into runtime/models/<capability>/;
//   3. prints what it fetched and each file's upstream licence.
//
// Every model here is permissively licensed (Apache-2.0/MIT) — see
// LICENSES.md for the full table and source citations. Re-run any time;
// existing, digest-matching files are left alone (idempotent).

import { spawnSync } from "node:child_process";
import path from "node:path";

import { MODELS_DIR, RUNTIME_DIR } from "./src/config.js";
import {
  ensureModelAssets,
  lockCapabilities,
  readModelLock,
} from "./src/model-assets.js";

function installRuntimeDependencies(): void {
  console.log(
    `Running "bun install" in ${RUNTIME_DIR} (installs optional local recognition runtimes)...`
  );
  const result = spawnSync("bun", ["install"], {
    cwd: RUNTIME_DIR,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `"bun install" in ${RUNTIME_DIR} exited with status ${result.status ?? "unknown"}`
    );
  }
}

async function main(): Promise<void> {
  installRuntimeDependencies();

  const lock = await readModelLock();
  const capabilities = lockCapabilities(lock);

  console.log("\nFetching model weights + auxiliary files...");
  const outcome = await ensureModelAssets({
    runtimeDir: RUNTIME_DIR,
    capabilities,
  });

  const fetched = new Set(outcome.fetched);
  for (const file of lock.files) {
    const state = fetched.has(file.path) ? "downloaded" : "cached";
    console.log(
      `  [${state}] ${path.relative(RUNTIME_DIR, path.join(MODELS_DIR, file.path))}`
    );
  }

  console.log("\nLicences (also recorded in LICENSES.md):");
  for (const licence of new Set(
    lock.files.map((file) => `${file.model} — ${file.license}`)
  )) {
    console.log(`  - ${licence}`);
  }

  if (outcome.failed.length > 0) {
    for (const failure of outcome.failed) {
      console.error(`  [failed] ${failure.capability}: ${failure.error}`);
    }
    throw new Error(
      `${outcome.failed.length} capability/capabilities could not be provisioned`
    );
  }

  console.log(
    `\nDone. ${lock.files.length} files present under ${MODELS_DIR} for ${outcome.ready.length} capabilities. Recognition automations load them directly.`
  );
}

await main();
