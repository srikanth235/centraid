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
  unlinkSync,
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
 * paths into the *source* tree. Bun's node_modules is almost entirely
 * symlinks into node_modules/.bun/… — after copy those become absolute
 * /src/node_modules/.bun/… links. Deleting them empties the runtime tree.
 *
 * Strategy:
 * 1. Remap any absolute target under `root` → same relative path under `out`.
 * 2. Rewrite every remaining link as relative so the tree is relocatable.
 * 3. Force @centraid/* → ../../packages/<name> (lean package copies).
 * 4. Drop links that still resolve outside `out` (apps/desktop etc.).
 *
 * @param {string} out runtime root
 * @param {string} root monorepo root that was copied from
 */
export function rewriteRuntimeSymlinks(out, root) {
  const outAbs = realpathSync(path.resolve(out));
  const rootAbs = realpathSync(path.resolve(root));
  const nmDest = path.join(outAbs, 'node_modules');
  const scope = path.join(nmDest, '@centraid');
  mkdirSync(scope, { recursive: true });

  /** Map a path under the source monorepo into the runtime tree. */
  const mapIntoOut = (resolved) => {
    const norm = path.normalize(resolved);
    const relFromRoot = path.relative(rootAbs, norm);
    if (!relFromRoot.startsWith('..') && !path.isAbsolute(relFromRoot)) {
      return path.join(outAbs, relFromRoot);
    }
    // Already under out (or equivalent via /var vs /private/var)?
    const relFromOut = path.relative(outAbs, norm);
    if (!relFromOut.startsWith('..') && !path.isAbsolute(relFromOut)) {
      return path.join(outAbs, relFromOut);
    }
    try {
      const real = realpathSync(norm);
      const rRoot = path.relative(rootAbs, real);
      if (!rRoot.startsWith('..') && !path.isAbsolute(rRoot)) {
        return path.join(outAbs, rRoot);
      }
      const rOut = path.relative(outAbs, real);
      if (!rOut.startsWith('..') && !path.isAbsolute(rOut)) {
        return path.join(outAbs, rOut);
      }
    } catch {
      // dangling
    }
    return null;
  };

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
    const resolved = path.isAbsolute(target)
      ? path.normalize(target)
      : path.resolve(path.dirname(full), target);
    const mapped = mapIntoOut(resolved);
    if (mapped === null) {
      // Host monorepo apps/*, random absolute paths — not in the image.
      rmSync(full, { recursive: true, force: true });
      return;
    }
    const rel = path.relative(path.dirname(full), mapped);
    if (rel === target) return; // already correct relative
    try {
      unlinkSync(full);
    } catch {
      rmSync(full, { recursive: true, force: true });
    }
    try {
      symlinkSync(rel, full);
    } catch (err) {
      // Another walk step may race; replace aggressively.
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EEXIST') {
        rmSync(full, { recursive: true, force: true });
        symlinkSync(rel, full);
      } else {
        throw err;
      }
    }
  };

  // Walk all of node_modules (including .bun) so bun's store links survive.
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = path.join(dir, name);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        fixLink(full);
        continue;
      }
      if (st.isDirectory()) walk(full);
    }
  };
  if (existsSync(nmDest)) walk(nmDest);

  // Drop non-closure workspace names, then force lean package links.
  if (existsSync(scope)) {
    for (const name of readdirSync(scope)) {
      if (!KEEP_CENTRAID_NAMES.has(name)) {
        rmSync(path.join(scope, name), { recursive: true, force: true });
      }
    }
  }
  for (const name of KEEP_CENTRAID_NAMES) {
    const pkgDir = path.join(outAbs, 'packages', name);
    if (!existsSync(pkgDir)) {
      throw new Error(`rewriteRuntimeSymlinks: missing ${pkgDir}`);
    }
    const linkPath = path.join(scope, name);
    rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(path.relative(scope, pkgDir), linkPath);
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

/**
 * @param {{ root: string; out: string; packagesOnly?: boolean }} opts
 *   packagesOnly: skip node_modules copy (Dockerfile re-installs production deps;
 *   bun's .bun store cannot be relocated by symlink rewrite alone).
 */
export function assembleRuntime({ root, out, packagesOnly = false }) {
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
        // Root depends on gateway so bun hoists production deps (esbuild, ajv, …)
        // into node_modules for Node's resolver — workspaces alone leave only .bun.
        dependencies: {
          '@centraid/gateway': 'workspace:*',
        },
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
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    // Drop devDependencies so a packages-only + production install does not
    // require @centraid/test-kit / @centraid/web workspace packages.
    const runtimePkg = { ...pkgJson };
    delete runtimePkg.devDependencies;
    delete runtimePkg.scripts;
    writeFileSync(path.join(dest, 'package.json'), `${JSON.stringify(runtimePkg, null, 2)}\n`);
    if (!copyIfExists(path.join(src, 'dist'), path.join(dest, 'dist'))) {
      throw new Error(`${pkg}/dist missing — build gateway closure first`);
    }
    // Ship package.json "files" assets (blueprints manifest/apps, gateway skills,
    // tunnel native/*.node, …). Skip README and other markdown docs.
    const filesField = Array.isArray(pkgJson.files) ? pkgJson.files : undefined;
    if (filesField) {
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

  // Remove stray test artifacts under packages.
  walkRm(path.join(out, 'packages'), (full, name) => {
    if (name.endsWith('.test.js') || name.endsWith('.test.d.ts')) return true;
    if (name === 'src' && statSync(full).isDirectory()) return true;
    return false;
  });

  if (!packagesOnly) {
    // Host/local path: copy + rewrite (tests use this). Docker prefers
    // packagesOnly + fresh bun install — bun's .bun content-addressed store
    // does not relocate cleanly via symlink rewrite.
    const nmSrc = path.join(root, 'node_modules');
    const nmDest = path.join(out, 'node_modules');
    if (!existsSync(nmSrc)) {
      throw new Error(`node_modules missing under ${root}`);
    }
    cpSync(nmSrc, nmDest, { recursive: true, dereference: false, force: true });
    rewriteRuntimeSymlinks(out, root);

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
  }

  const report = {
    version: 1,
    packages: GATEWAY_WORKSPACE_PACKAGES,
    out,
    packagesOnly,
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
  const packagesOnly = process.argv.includes('--packages-only');
  try {
    const report = assembleRuntime({ root, out, packagesOnly });
    process.stdout.write(
      `gateway runtime assembled → ${out} (${report.packages.length} packages${packagesOnly ? ', packages-only' : ''})\n`,
    );
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.stack : err}\n`);
    process.exit(1);
  }
}
