#!/usr/bin/env node
/**
 * Single-source monorepo version → workspace package.jsons (issue #501 / #468
 * J6).
 *
 * Canonical string: root package.json `version`, stamped into every root
 * workspace (`packages/*`, `desktop/electron`, `extension`) that carried the
 * previous version. The store build number is not a file here: it is derived
 * from the version by `nativeBuildNumber` and reported, never hand-set.
 *
 *   node scripts/release/sync-versions.mjs [--version X.Y.Z] [--dry-run]
 *
 * When --version is omitted, re-stamps workspaces to match root.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");

/** The workspaces at fixed paths; every child of `packages/` is one too. */
const FIXED_WORKSPACES = ["desktop/electron", "extension"];

/**
 * Store build number from semver: major*1e6 + minor*1e3 + patch —
 * reproducible from source, no remote counter.
 * @param {string} version A `X.Y.Z` version.
 * @returns {number} The build number.
 */
export function nativeBuildNumber(version) {
  const m = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/u.exec(
    String(version).trim()
  );
  if (!m) throw new Error(`unparseable semver: ${version}`);
  const major = Number(m.groups?.major);
  const minor = Number(m.groups?.minor);
  const patch = Number(m.groups?.patch);
  return major * 1_000_000 + minor * 1_000 + patch;
}

function collectPackageJsons(rootDir) {
  const out = [path.join(rootDir, "package.json")];
  const packages = path.join(rootDir, "packages");
  if (existsSync(packages)) {
    for (const name of readdirSync(packages)) {
      const p = path.join(packages, name, "package.json");
      if (existsSync(p)) out.push(p);
    }
  }
  for (const dir of FIXED_WORKSPACES) {
    const p = path.join(rootDir, dir, "package.json");
    if (existsSync(p)) out.push(p);
  }
  return out;
}

export function runSyncVersions({
  rootDir = root,
  version,
  dryRun = false,
} = {}) {
  const rootPkgPath = path.join(rootDir, "package.json");
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
  const prev = rootPkg.version;
  const ver = version || prev;
  if (!/^\d+\.\d+\.\d+$/u.test(ver)) {
    throw new Error(`unparseable version ${ver}`);
  }
  const build = nativeBuildNumber(ver);

  /** @param {string} filePath @param {string} content */
  function write(filePath, content) {
    if (dryRun) return;
    writeFileSync(filePath, content);
  }

  const workspaces = [];
  for (const p of collectPackageJsons(rootDir)) {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j.version === prev || p === rootPkgPath) {
      j.version = ver;
      write(p, JSON.stringify(j, null, 2) + "\n");
      workspaces.push(path.relative(rootDir, p));
    }
  }

  return { prev, version: ver, build, dryRun, workspaces };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = process.argv.slice(2);
  let version = null;
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--version") version = args[++i];
    else if (args[i] === "--dry-run") dryRun = true;
  }
  try {
    const report = runSyncVersions({ version: version || undefined, dryRun });
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
