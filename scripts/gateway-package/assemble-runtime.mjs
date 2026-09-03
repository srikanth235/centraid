#!/usr/bin/env node

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
} from "node:fs";
import path from "node:path";

export const GATEWAY_WORKSPACE_PACKAGES = [
  "packages/server",
  "packages/backup",
  "packages/blueprints",
  "packages/design",
  "packages/core",
  "packages/tunnel",
  "packages/vault",
];

const KEEP_CENTRAID_NAMES = new Set(
  GATEWAY_WORKSPACE_PACKAGES.map((p) => p.replace(/^packages\//u, ""))
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
        if (readdirSync(full).length === 0)
          rmSync(full, { recursive: true, force: true });
      } catch {
        // Intentionally empty.
      }
    } else if (pred(full, name, st)) {
      rmSync(full, { recursive: true, force: true });
    }
  }
}

export function rewriteRuntimeSymlinks(out, root) {
  const outAbs = realpathSync(path.resolve(out));
  const rootAbs = realpathSync(path.resolve(root));
  const nmDest = path.join(outAbs, "node_modules");
  const scope = path.join(nmDest, "@centraid");
  mkdirSync(scope, { recursive: true });

  const mapIntoOut = (resolved) => {
    const norm = path.normalize(resolved);
    const relFromRoot = path.relative(rootAbs, norm);
    if (!relFromRoot.startsWith("..") && !path.isAbsolute(relFromRoot)) {
      return path.join(outAbs, relFromRoot);
    }
    const relFromOut = path.relative(outAbs, norm);
    if (!relFromOut.startsWith("..") && !path.isAbsolute(relFromOut)) {
      return path.join(outAbs, relFromOut);
    }
    try {
      const real = realpathSync(norm);
      const rRoot = path.relative(rootAbs, real);
      if (!rRoot.startsWith("..") && !path.isAbsolute(rRoot)) {
        return path.join(outAbs, rRoot);
      }
      const rOut = path.relative(outAbs, real);
      if (!rOut.startsWith("..") && !path.isAbsolute(rOut)) {
        return path.join(outAbs, rOut);
      }
    } catch {
      // Intentionally empty.
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
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        rmSync(full, { recursive: true, force: true });
        symlinkSync(rel, full);
      } else {
        throw error;
      }
    }
  };

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

  if (existsSync(scope)) {
    for (const name of readdirSync(scope)) {
      if (!KEEP_CENTRAID_NAMES.has(name)) {
        rmSync(path.join(scope, name), { recursive: true, force: true });
      }
    }
  }
  for (const name of KEEP_CENTRAID_NAMES) {
    const pkgDir = path.join(outAbs, "packages", name);
    if (!existsSync(pkgDir)) {
      throw new Error(`rewriteRuntimeSymlinks: missing ${pkgDir}`);
    }
    const linkPath = path.join(scope, name);
    rmSync(linkPath, { recursive: true, force: true });
    symlinkSync(path.relative(scope, pkgDir), linkPath);
  }

  for (const name of KEEP_CENTRAID_NAMES) {
    const linkPath = path.join(scope, name);
    const target = readlinkSync(linkPath);
    if (path.isAbsolute(target)) {
      throw new Error(
        `@centraid/${name} still absolute after rewrite: ${target}`
      );
    }
    const resolved = realpathSync(linkPath);
    const rel = path.relative(outAbs, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `@centraid/${name} resolves outside runtime: ${resolved} (out=${outAbs})`
      );
    }
    if (!resolved.includes(`${path.sep}packages${path.sep}${name}`)) {
      throw new Error(
        `@centraid/${name} expected under packages/${name}, got ${resolved}`
      );
    }
  }
}

export function assembleRuntime({ root, out, packagesOnly = false }) {
  if (!root || !out) throw new Error("--root and --out are required");
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const rootPkg = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8")
  );
  writeFileSync(
    path.join(out, "package.json"),
    `${JSON.stringify(
      {
        name: "centraid-gateway-runtime",
        version: rootPkg.version ?? "0.0.0",
        private: true,
        type: "module",
        dependencies: {
          "@centraid/server": "workspace:*",
        },
        workspaces: GATEWAY_WORKSPACE_PACKAGES,
      },
      null,
      2
    )}\n`
  );

  if (existsSync(path.join(root, "bun.lock"))) {
    cpSync(path.join(root, "bun.lock"), path.join(out, "bun.lock"));
  }

  for (const pkg of GATEWAY_WORKSPACE_PACKAGES) {
    const src = path.join(root, pkg);
    const dest = path.join(out, pkg);
    if (!existsSync(src)) {
      throw new Error(`missing package ${pkg} under ${root}`);
    }
    mkdirSync(dest, { recursive: true });
    const pkgJsonPath = path.join(src, "package.json");
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    const runtimePkg = { ...pkgJson };
    delete runtimePkg.devDependencies;
    delete runtimePkg.scripts;
    writeFileSync(
      path.join(dest, "package.json"),
      `${JSON.stringify(runtimePkg, null, 2)}\n`
    );
    if (!copyIfExists(path.join(src, "dist"), path.join(dest, "dist"))) {
      throw new Error(`${pkg}/dist missing — build gateway closure first`);
    }
    const filesField = Array.isArray(pkgJson.files) ? pkgJson.files : undefined;
    if (filesField) {
      for (const entry of filesField) {
        if (typeof entry !== "string") continue;
        if (entry === "dist" || entry === "README.md" || entry.endsWith(".md"))
          continue;
        if (entry.includes("*")) {
          const slash = entry.lastIndexOf("/");
          const dirRel = slash === -1 ? "." : entry.slice(0, slash);
          const pattern = slash === -1 ? entry : entry.slice(slash + 1);
          const dirSrc = path.join(src, dirRel);
          if (!existsSync(dirSrc)) continue;
          const dirDest = path.join(dest, dirRel);
          mkdirSync(dirDest, { recursive: true });
          const suffix = pattern.startsWith("*") ? pattern.slice(1) : null;
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
      copyIfExists(path.join(src, "skills"), path.join(dest, "skills"));
    }
  }

  walkRm(path.join(out, "packages"), (full, name) => {
    if (name.endsWith(".test.js") || name.endsWith(".test.d.ts")) return true;
    if (name === "src" && statSync(full).isDirectory()) return true;
    return false;
  });

  if (!packagesOnly) {
    const nmSrc = path.join(root, "node_modules");
    const nmDest = path.join(out, "node_modules");
    if (!existsSync(nmSrc)) {
      throw new Error(`node_modules missing under ${root}`);
    }
    cpSync(nmSrc, nmDest, { recursive: true, dereference: false, force: true });
    rewriteRuntimeSymlinks(out, root);

    const dropTop = [
      "typescript",
      "vitest",
      "@vitest",
      "eslint",
      "oxlint",
      "oxfmt",
      "prettier",
      "@playwright",
      "playwright",
      "turbo",
      "@types",
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
  writeFileSync(
    path.join(out, "runtime-manifest.json"),
    `${JSON.stringify(report, null, 2)}\n`
  );
  return report;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename;
if (isMain) {
  const root = path.resolve(
    arg("--root", path.resolve(import.meta.dirname, "../.."))
  );
  const out = path.resolve(
    arg("--out", path.join(root, "artifacts/gateway-runtime"))
  );
  const packagesOnly = process.argv.includes("--packages-only");
  try {
    const report = assembleRuntime({ root, out, packagesOnly });
    process.stdout.write(
      `gateway runtime assembled → ${out} (${report.packages.length} packages${packagesOnly ? ", packages-only" : ""})\n`
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
    process.exit(1);
  }
}
