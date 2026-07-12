/*
 * Shared PATH sanitization for agent-CLI subprocess spawns.
 *
 * Coding-agent CLIs (`claude`, `codex`) are user-level tools — installed via
 * `npm i -g`, a curl installer, Homebrew, etc., living somewhere like
 * `~/.local/bin` or `/opt/homebrew/bin`. They are never installed *into* a
 * project's `node_modules/.bin`.
 *
 * `npm run` / `bun run` (and `yarn`/`pnpm` equivalents) prepend the
 * `node_modules/.bin` of the invoked package to `PATH` — and npm's run
 * mechanism actually walks up and prepends *every ancestor directory's*
 * `node_modules/.bin` up to the filesystem root. When the desktop app or
 * gateway is dev-launched through a package-manager `run` chain, any
 * ancestor of the repo (including a user's home directory, if it happens to
 * hold a stray `npm install`) lands its `node_modules/.bin` on `PATH` ahead
 * of the user's real install location. Node's `spawn('claude', …)` /
 * `spawn('codex', …)` do a plain `PATH` lookup, so a shim sitting in one of
 * those injected directories silently shadows the CLI the user's login
 * shell would actually find — reporting/running a stale version with no
 * indication anything is wrong.
 *
 * The fix: strip any `PATH` entry that ends in `node_modules/.bin` before
 * resolving or spawning an agent CLI. Since such entries only ever appear
 * on `PATH` via the run-script injection described above (a bare shell PATH
 * never contains one), this is safe to do unconditionally — including for
 * the repo's own `node_modules/.bin` — and is a no-op on a production
 * Finder launch, which never has these entries in the first place.
 *
 * An explicit `binPath` (an operator/user-configured absolute path,
 * bypassing PATH lookup entirely) skips sanitization — the caller already
 * knows exactly which binary it wants, and we should not second-guess it.
 */

import path from 'node:path';

/** Matches a PATH entry that is (or ends in) a `node_modules/.bin` dir, either separator. */
const NODE_MODULES_BIN_RE = /[\\/]node_modules[\\/]\.bin[\\/]?$/;

/**
 * Strip `node_modules/.bin` entries out of a `PATH`-shaped string. Other
 * entries — and their relative order — are preserved verbatim. Exported for
 * unit tests; most callers want `agentSpawnEnv` instead.
 */
export function sanitizeAgentPath(pathValue: string | undefined): string {
  if (!pathValue) return '';
  return pathValue
    .split(path.delimiter)
    .filter((entry) => !NODE_MODULES_BIN_RE.test(entry))
    .join(path.delimiter);
}

export interface AgentSpawnEnvOptions {
  /** Env to start from. Defaults to `process.env`; never mutated. */
  baseEnv?: NodeJS.ProcessEnv;
  /**
   * An explicit, operator/user-configured CLI path. When set, `PATH` is left
   * untouched (aside from `extraPath`) — an explicit path bypasses PATH
   * resolution entirely, so sanitizing it would be second-guessing a choice
   * the caller already made.
   */
  binPath?: string;
  /**
   * Extra directories to prepend to `PATH` after sanitization (e.g. so a
   * spawned agent's shell tool can find the `centraid` CLI by bare name).
   */
  extraPath?: string;
}

/**
 * Build the env to spawn an agent CLI (`claude`/`codex`) subprocess with —
 * `PATH` sanitized per the module doc above, unless an explicit `binPath`
 * opts out. Always returns a fresh object; never mutates `baseEnv` /
 * `process.env`, so concurrent turns can't race on `PATH`.
 */
export function agentSpawnEnv(opts: AgentSpawnEnvOptions = {}): NodeJS.ProcessEnv {
  const base = opts.baseEnv ?? process.env;
  const currentPath = base.PATH ?? '';
  const sanitized = opts.binPath ? currentPath : sanitizeAgentPath(currentPath);
  const finalPath = opts.extraPath
    ? sanitized
      ? `${opts.extraPath}${path.delimiter}${sanitized}`
      : opts.extraPath
    : sanitized;
  return { ...base, PATH: finalPath };
}
