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
  readlinkSync,
  symlinkSync,
  realpathSync,
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

/**
 * Node's cpSync({dereference:false}) rewrites relative symlinks as absolute
 * paths into the *source* tree. In a multi-stage Docker copy that means
 * node_modules/@centraid/* → /src/packages/* which is missing at runtime.
 * Recreate kept workspace links as relative paths into out/packages/*.
 *
 * Also walk node_modules: drop absolute links that resolve outside `out`
 * (leftover monorepo apps/* etc.), and leave relative links that already
 * resolve under `out` alone.
 */
export function rewriteRuntimeSymlinks(out) {
  // Resolve once — macOS /var vs /private/var breaks naive path.relative checks.
  const outAbs = realpathSync(path.resolve(out));
  const nmDest = path.join(outAbs, 'node_modules');
  const scope = path.join(nmDest, '@centraid');
  mkdirSync(scope, { recursive: true });

  // Drop non-closure workspace names first.
  if (existsSync(scope)) {
    for (const name of readdirSync(scope)) {
      if (!KEEP_CENTRAID_NAMES.has(name)) {
        rmSync(path.join(scope, name), { recursive: true, force: true });
      }
    }
  }

  // Force relative workspace links into the lean packages/ we assembled.
  for (const name of KEEP_CENTRAID_NAMES) {
    const pkgDir = path.join(outAbs, 'packages', name);
    if (!existsSync(pkgDir)) {
      throw new Error(`rewriteRuntimeSymlinks: missing ${pkgDir}`);
    }
    const linkPath = path.join(scope, name);
    rmSync(linkPath, { recursive: true, force: true });
    // From node_modules/@centraid/<name> → ../../packages/<name>
    const rel = path.relative(scope, pkgDir);
    symlinkSync(rel, linkPath);
  }

  // Fix absolute symlinks that cpSync rewrote under top-level node_modules
  // and .bin only — do not deep-walk Electron.app bundles (rmSync landmines
  // and irrelevant to the gateway image after production prune).
  const fixLink = (full) => {
    let st;
    try {
      st = lstatSync(full);
    } catch {
      return;
    }
    if (!st.isSymbolicLink()) return;
    let target;
    try {
      target = readlinkSync(full);
    } catch {
      rmSync(full, { recursive: true, force: true });
      return;
    }
    let resolved = path.isAbsolute(target)
      ? path.normalize(target)
      : path.resolve(path.dirname(full), target);
    try {
      if (existsSync(resolved)) resolved = realpathSync(resolved);
    } catch {
      // dangling
    }
    const relToOut = path.relative(outAbs, resolved);
    if (relToOut.startsWith('..') || path.isAbsolute(relToOut)) {
      // Points outside the runtime (host monorepo path). Drop it.
      rmSync(full, { recursive: true, force: true });
      return;
    }
    if (path.isAbsolute(target)) {
      const rel = path.relative(path.dirname(full), resolved);
      rmSync(full, { recursive: true, force: true });
      symlinkSync(rel, full);
    }
  };

  // Top-level entries + one level under @scopes + .bin
  for (const name of readdirSync(nmDest)) {
    const full = path.join(nmDest, name);
    fixLink(full);
    if (name === '.bin' || name.startsWith('@')) {
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      for (const child of readdirSync(full)) {
        fixLink(path.join(full, child));
      }
    }
  }

  // Sanity: every kept @centraid name must resolve under out/packages.
  for (const name of KEEP_CENTRAID_NAMES) {
    const linkPath = path.join(scope, name);
    const target = readlinkSync(linkPath);
    if (path.isAbsolute(target)) {
      throw new Error(`@centraid/${name} still absolute after rewrite: ${target}`);
    }
    const resolved = realpathSync(linkPath);
    const rel = path.relative(outAbs, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`@centraid/${name} resolves outside runtime: ${resolved} (out=${outAbs})`);
    }
    if (!resolved.includes(`${path.sep}packages${path.sep}${name}`)) {
      throw new Error(`@centraid/${name} expected under packages/${name}, got ${resolved}`);
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
    const pkgJsonPath = path.join(src, 'package.json');
    cpSync(pkgJsonPath, path.join(dest, 'package.json'));
    if (!copyIfExists(path.join(src, 'dist'), path.join(dest, 'dist'))) {
      throw new Error(`${pkg}/dist missing — build gateway closure first`);
    }
    // Ship package.json "files" assets (blueprints manifest/apps, gateway skills,
    // tunnel native/*.node, …). Skip README and other markdown docs.
    let filesField;
    try {
      filesField = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).files;
    } catch {
      filesField = undefined;
    }
    if (Array.isArray(filesField)) {
      for (const entry of filesField) {
        if (typeof entry !== 'string') continue;
        if (entry === 'dist' || entry === 'README.md' || entry.endsWith('.md')) continue;
        if (entry.includes('*')) {
          // e.g. tunnel "native/*.node" — copy matching files only.
          const slash = entry.lastIndexOf('/');
          const dirRel = slash === -1 ? '.' : entry.slice(0, slash);
          const pattern = slash === -1 ? entry : entry.slice(slash + 1);
          const dirSrc = path.join(src, dirRel);
          if (!existsSync(dirSrc)) continue;
          const dirDest = path.join(dest, dirRel);
          mkdirSync(dirDest, { recursive: true });
          const suffix = pattern.startsWith('*') ? pattern.slice(1) : null;
          for (const name of readdirSync(dirSrc)) {
            if (suffix !== null) {
              if (!name.endsWith(suffix)) continue;
            } else if (name !== pattern) continue;
            cpSync(path.join(dirSrc, name), path.join(dirDest, name), {
              recursive: true,
              force: true,
            });
          }
          continue;
        }
        copyIfExists(path.join(src, entry), path.join(dest, entry));
      }
    } else {
      // Fallback when package.json has no "files" field.
      copyIfExists(path.join(src, 'skills'), path.join(dest, 'skills'));
    }
  }

  // Hoisted deps. Node rewrites relative workspace links to absolute paths
  // into `root` — rewriteRuntimeSymlinks fixes that for relocatable trees.
  const nmSrc = path.join(root, 'node_modules');
  const nmDest = path.join(out, 'node_modules');
  if (!existsSync(nmSrc)) {
    throw new Error(`node_modules missing under ${root}`);
  }
  cpSync(nmSrc, nmDest, { recursive: true, dereference: false, force: true });

  rewriteRuntimeSymlinks(out);

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
