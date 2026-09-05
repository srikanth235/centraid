#!/usr/bin/env node
// One turbo cache for every worktree of this repo (#988).
//
// Turbo's default `cacheDir` is `.turbo/cache`, which is per-checkout. Five
// agents each work in their own worktree, so a build every one of them has
// already paid for was re-paid five times — and a fresh worktree of `main`
// started from a fully cold graph, 349 s of which is one release cargo compile
// (docs/dev-environment.md#the-build-ci-cache-miss-diagnosed-915).
//
// The cache key is turbo's own content hash, so entries are interchangeable
// across checkouts of the same repo by construction; only the DIRECTORY was
// per-checkout. Pointing every invocation at one directory under the user's
// cache home makes a second worktree's build a restore.
//
// The directory is never inside the repo: `TURBO_CACHE_DIR` wins if the caller
// set one (CI sets none and gets the same default), then
// `CENTRAID_TURBO_CACHE_DIR`, then `${XDG_CACHE_HOME:-~/.cache}/centraid/turbo`.
// `docs/toolchain.md` names it. Run summaries still land in `.turbo/runs` per
// checkout, which is what `turbo-cache-report.mjs` reads.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";

export function turboCacheDir() {
  if (process.env.TURBO_CACHE_DIR) return process.env.TURBO_CACHE_DIR;
  if (process.env.CENTRAID_TURBO_CACHE_DIR) {
    return path.resolve(process.env.CENTRAID_TURBO_CACHE_DIR);
  }
  const cacheHome =
    process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(cacheHome, "centraid", "turbo");
}

/**
 * The environment a turbo invocation should carry.
 * @param {NodeJS.ProcessEnv} [env] Base environment; defaults to this process's.
 * @returns {NodeJS.ProcessEnv} The same environment with the shared cache directory set.
 */
export function turboEnv(env = process.env) {
  return { ...env, TURBO_CACHE_DIR: turboCacheDir() };
}

if (process.argv[1] === import.meta.filename) {
  const root = path.resolve(import.meta.dirname, "../..");
  const result = spawnSync(
    path.join(root, "node_modules/.bin/turbo"),
    process.argv.slice(2),
    { cwd: process.cwd(), env: turboEnv(), stdio: "inherit" }
  );
  if (result.error) {
    process.stderr.write(`turbo: ${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
