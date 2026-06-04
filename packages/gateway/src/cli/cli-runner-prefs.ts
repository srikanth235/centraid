/*
 * Seed the daemon's identity DB with `agent.runner.*` prefs from the
 * config file.
 *
 * Without this, the runtime's per-turn prefs loader would see an empty
 * user_prefs row and fall back to "codex with whatever's on $PATH" —
 * which is fine for a default but doesn't pick up the daemon operator's
 * configured binPath / extra args.
 *
 * Idempotent: runs `setPrefs` with the same patch shape the renderer's
 * Settings panel uses, so re-running with the same config is a no-op.
 * A pref key set on a previous boot that's been removed from the
 * config file is explicitly cleared (set to `null`) so the file
 * remains the source of truth.
 */

import type { UserStore } from '@centraid/app-engine';
import type { DaemonConfig } from './cli-config.js';

const RUNNER_KEYS = [
  'agent.runner.kind',
  'agent.runner.binPath',
  'agent.runner.extraArgs',
] as const;

export function buildPrefsPatch(config: DaemonConfig): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const k of RUNNER_KEYS) patch[k] = null;
  if (config.runner) {
    patch['agent.runner.kind'] = config.runner.kind;
    if (config.runner.binPath !== undefined) {
      patch['agent.runner.binPath'] = config.runner.binPath;
    }
    if (config.runner.extraArgs !== undefined) {
      patch['agent.runner.extraArgs'] = config.runner.extraArgs;
    }
  }
  return patch;
}

export function seedRunnerPrefs(userStore: UserStore, config: DaemonConfig): void {
  // Always apply the patch, even when `runner` is absent — that's the case
  // where the operator removed a previously seeded runner block and expects
  // the next boot to clear it. `buildPrefsPatch` defaults every known key to
  // `null`, so an empty config wipes prior state.
  userStore.setPrefs(buildPrefsPatch(config));
}
