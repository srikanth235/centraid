#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.dirname(import.meta.dirname);
const wasm = path.join(root, "src/generated/centraid_web_iroh_bg.wasm");
const force = process.env.FORCE_IROH_WASM === "1";

if (!force && existsSync(wasm)) {
  process.exit(0);
}

console.log("[web] building iroh wasm (apps/web/scripts/build-iroh-wasm.sh)…");
const result = spawnSync(
  "bash",
  [path.join(root, "scripts/build-iroh-wasm.sh")],
  {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  }
);
process.exit(result.status ?? 1);
