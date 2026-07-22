#!/usr/bin/env node
/**
 * Assemble a production-lean gateway runtime tree for the Docker image.
 *
 * External observer tooling (issue #504): copies only the gateway install
 * set (package.json + dist + skills) plus the post-production node_modules
 * tree. Does not mutate product main.
 *
 * Usage:
 *   node scripts/gateway-package/assemble-runtime.mjs --root=<monorepo> --out=<dir>
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  readFileSync,
  lstatSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Must stay aligned with scripts/gateway-package/trace.mjs. */
export const GATEWAY_WORKSPACE_PACKAGES = [
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

/** Package directory names under packages/ that belong in the runtime. */
const KEEP_CENTRAID_NAMES = new Set(
  GATEWAY_WORKSPACE_PACKAGES.map((p) => p.replace(/^packages\//, '')),
);

function arg(name, fallback) {
  const prefix = `${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function copyIfExists(src, dest) {
  if (!existsSync(src)) return false;
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: false, force: true });
  return true;
}

function walkRm(dir, pred) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory() && !st.isSymbolicLink()) {
      walkRm(full, pred);
      try {
        if (readdirSync(full).length === 0) rmSync(full, { recursive: true, force: true });
      } catch {
        // race / non-empty
      }
    } else if (pred(full, name, st)) {
      rmSync(full, { recursive: true, force: true });
    }
  }
}

export function assembleRuntime({ root, out }) {
  if (!root || !out) throw new Error('--root and --out are required');
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // Minimal root package.json — workspaces only the gateway closure.
  const rootPkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  writeFileSync(
    path.join(out, 'package.json'),
    `${JSON.stringify(
      {
        name: 'centraid-gateway-runtime',
        version: rootPkg.version ?? '0.0.0',
        private: true,
        type: 'module',
        workspaces: GATEWAY_WORKSPACE_PACKAGES,
      },
      null,
      2,
    )}\n`,
  );

  if (existsSync(path.join(root, 'bun.lock'))) {
    cpSync(path.join(root, 'bun.lock'), path.join(out, 'bun.lock'));
  }

  for (const pkg of GATEWAY_WORKSPACE_PACKAGES) {
    const src = path.join(root, pkg);
    const dest = path.join(out, pkg);
    if (!existsSync(src)) {
      throw new Error(`missing package ${pkg} under ${root}`);
    }
    mkdirSync(dest, { recursive: true });
    cpSync(path.join(src, 'package.json'), path.join(dest, 'package.json'));
    if (!copyIfExists(path.join(src, 'dist'), path.join(dest, 'dist'))) {
      throw new Error(`${pkg}/dist missing — build gateway closure first`);
    }
    copyIfExists(path.join(src, 'skills'), path.join(dest, 'skills'));
  }

  // Hoisted deps: preserve workspace symlinks into packages/* we just wrote.
  const nmSrc = path.join(root, 'node_modules');
  const nmDest = path.join(out, 'node_modules');
  if (!existsSync(nmSrc)) {
    throw new Error(`node_modules missing under ${root}`);
  }
  cpSync(nmSrc, nmDest, { recursive: true, dereference: false, force: true });

  // Keep only gateway-closure workspace links under @centraid.
  const scope = path.join(nmDest, '@centraid');
  if (existsSync(scope)) {
    for (const name of readdirSync(scope)) {
      if (!KEEP_CENTRAID_NAMES.has(name)) {
        rmSync(path.join(scope, name), { recursive: true, force: true });
      }
    }
  }

  // Drop obvious non-runtime weight (dev tooling left after --production is best-effort).
  const dropTop = [
    'typescript',
    'vitest',
    '@vitest',
    'eslint',
    'oxlint',
    'oxfmt',
    'prettier',
    '@playwright',
    'playwright',
    'turbo',
    '@types',
  ];
  for (const name of dropTop) {
    const p = path.join(nmDest, name);
    if (existsSync(p)) rmSync(p, { recursive: true, force: true });
  }

  // Remove source maps optional? keep for ops debug.
  // Remove any stray test files under packages.
  walkRm(path.join(out, 'packages'), (full, name) => {
    if (name.endsWith('.test.js') || name.endsWith('.test.d.ts')) return true;
    if (name === 'src' && statSync(full).isDirectory()) return true;
    return false;
  });

  const report = {
    version: 1,
    packages: GATEWAY_WORKSPACE_PACKAGES,
    out,
  };
  writeFileSync(path.join(out, 'runtime-manifest.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(
    arg('--root', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')),
  );
  const out = path.resolve(arg('--out', path.join(root, 'artifacts/gateway-runtime')));
  try {
    const report = assembleRuntime({ root, out });
    process.stdout.write(
      `gateway runtime assembled → ${out} (${report.packages.length} packages)\n`,
    );
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.stack : err}\n`);
    process.exit(1);
  }
}
