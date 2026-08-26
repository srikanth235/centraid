/*
 * `npm run`/`bun run` prepend every ancestor's `node_modules/.bin` to `PATH`,
 * where a shim silently shadows the user-level `claude`/`codex`. Strip those
 * entries unconditionally — only run-script injection creates them, so this is
 * a no-op on a real launch. An explicit `binPath` skips PATH lookup entirely.
 */

import path from "node:path";

const NODE_MODULES_BIN_RE = /[\\/]node_modules[\\/]\.bin[\\/]?$/u;

/** Preserves every other entry and its order. */
export function sanitizeHarnessPath(pathValue: string | undefined): string {
  if (!pathValue) return "";
  return pathValue
    .split(path.delimiter)
    .filter((entry) => !NODE_MODULES_BIN_RE.test(entry))
    .join(path.delimiter);
}

export interface HarnessSpawnEnvOptions {
  /** Defaults to `process.env`; never mutated. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Leaves `PATH` unsanitized. */
  binPath?: string;
  /** Prepended after sanitization, so a harness finds `centraid` by name. */
  extraPath?: string;
}

/** A fresh object: mutating `baseEnv` would race concurrent turns. */
export function harnessSpawnEnv(
  opts: HarnessSpawnEnvOptions = {}
): NodeJS.ProcessEnv {
  const base = opts.baseEnv ?? process.env;
  const currentPath = base.PATH ?? "";
  const sanitized = opts.binPath
    ? currentPath
    : sanitizeHarnessPath(currentPath);
  const finalPath = opts.extraPath
    ? sanitized
      ? `${opts.extraPath}${path.delimiter}${sanitized}`
      : opts.extraPath
    : sanitized;
  return { ...base, PATH: finalPath };
}
