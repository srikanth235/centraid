#!/usr/bin/env node
/**
 * Ensure the browser Iroh WASM artifact exists (issue #468 K15).
 * The binary is gitignored; CI and clean checkouts must build it via
 * scripts/build-iroh-wasm.sh. If the file is already present (local cache
 * or a prior build), skip the expensive rustc step.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wasm = path.join(root, 'src/generated/centraid_web_iroh_bg.wasm');
const force = process.env.FORCE_IROH_WASM === '1';

if (!force && existsSync(wasm)) {
  process.exit(0);
}

console.log('[web] building iroh wasm (apps/web/scripts/build-iroh-wasm.sh)…');
const result = spawnSync('bash', [path.join(root, 'scripts/build-iroh-wasm.sh')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
