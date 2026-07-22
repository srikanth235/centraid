#!/usr/bin/env node
/**
 * Gateway install-set tracer (issue #504 packaging Phase A).
 *
 * Emits a reviewable list of workspace paths that form a gateway runtime
 * closure for Docker/smoke packaging. Native modules are recorded explicitly
 * (sharp, wasm-vips, node:sqlite, tunnel/iroh wasm) — that is the hard part
 * of reproducible packaging; lockfile FOD is secondary.
 *
 * External observer: does not mutate product main.
 */

import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Packages required to run `centraid-gateway serve` after build. */
const GATEWAY_WORKSPACE_PACKAGES = [
  'packages/gateway',
  'packages/app-engine',
  'packages/agent-runtime',
  'packages/automation',
  'packages/backup',
  'packages/blueprints',
  'packages/design-tokens',
  'packages/protocol',
  'packages/tunnel',
  'packages/vault',
  'packages/blob-format',
];

/** Native / special binary surface (Phase A decision record). */
const NATIVE_MODULE_DECISION = {
  sharp: {
    role: 'image variants in gateway routes',
    packaging: 'platform-specific optional dependency; pin per docker target arch',
  },
  'wasm-vips': {
    role: 'WASM image path fallback',
    packaging: 'ship wasm assets from node_modules/wasm-vips',
  },
  'node:sqlite': {
    role: 'vault + ledger (Node built-in >= 22.5)',
    packaging: 'use node:22+ base image; no separate native addon',
  },
  'iroh/tunnel wasm': {
    role: 'browser + optional native tunnel',
    packaging: 'gateway image is HTTP/control-plane first; tunnel native optional via host network',
  },
};

function listDistIfPresent(pkgRel) {
  const dist = path.join(root, pkgRel, 'dist');
  if (!existsSync(dist)) return [`${pkgRel}/dist  (missing — run package build)`];
  const files = [];
  const walk = (dir, rel = '') => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, r);
      else files.push(`${pkgRel}/dist/${r}`);
    }
  };
  walk(dist);
  return files;
}

const entries = [];
for (const pkg of GATEWAY_WORKSPACE_PACKAGES) {
  entries.push(`${pkg}/package.json`);
  entries.push(...listDistIfPresent(pkg));
  const skills = path.join(root, pkg, 'skills');
  if (existsSync(skills)) entries.push(`${pkg}/skills/**`);
}

const report = {
  version: 1,
  issue: 504,
  phase: 'A',
  generatedAt: new Date().toISOString(),
  nativeModuleDecision: NATIVE_MODULE_DECISION,
  packages: GATEWAY_WORKSPACE_PACKAGES,
  installSetSample: entries.slice(0, 200),
  installSetCount: entries.length,
  notes: [
    'Docker (Phase C) copies built dist/ + package.json + production node_modules for these packages.',
    'Nix flake (Phase D) should consume the same package list; do not replace Bun day-to-day with a fat devShell.',
    'Host unit files: single writer is centraid-gateway service install (see docs/config-ownership.md).',
  ],
};

const outArg = process.argv.find((a) => a.startsWith('--out='));
const outPath = outArg
  ? path.resolve(outArg.slice('--out='.length))
  : path.join(root, 'artifacts/gateway-package-trace.json');

try {
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`gateway package trace → ${outPath} (${entries.length} paths)\n`);
} catch {
  // artifacts/ may not exist in all worktrees — still print to stdout
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
