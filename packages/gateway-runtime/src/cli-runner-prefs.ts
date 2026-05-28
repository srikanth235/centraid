/*
 * Seed the daemon's identity DB with `agent.runner.*` prefs from the
 * config file.
 *
 * Without this, the runtime's per-turn prefs loader would see an empty
 * user_prefs row and fall back to "codex with whatever's on $PATH" —
 * which is fine for a default but doesn't pick up the daemon operator's
 * configured binPath / provider config / extra args.
 *
 * Idempotent: runs `setPrefs` with the same patch shape the renderer's
 * Settings panel uses, so re-running with the same config is a no-op.
 * A pref key set on a previous boot that's been removed from the
 * config file is explicitly cleared (set to `null`) so the file
 * remains the source of truth.
 */

import type { UserStore } from '@centraid/runtime-core';
import type { DaemonConfig } from './cli-config.js';

const RUNNER_KEYS = [
  'agent.runner.kind',
  'agent.runner.binPath',
  'agent.runner.extraArgs',
  'agent.runner.provider.id',
  'agent.runner.provider.name',
  'agent.runner.provider.baseUrl',
  'agent.runner.provider.wireApi',
  'agent.runner.provider.envKey',
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
  if (config.provider) {
    patch['agent.runner.provider.id'] = config.provider.id;
    patch['agent.runner.provider.baseUrl'] = config.provider.baseUrl;
    if (config.provider.name !== undefined) {
      patch['agent.runner.provider.name'] = config.provider.name;
    }
    if (config.provider.wireApi !== undefined) {
      patch['agent.runner.provider.wireApi'] = config.provider.wireApi;
    }
    if (config.provider.envKey !== undefined) {
      patch['agent.runner.provider.envKey'] = config.provider.envKey;
    }
  }
  return patch;
}

export function seedRunnerPrefs(userStore: UserStore, config: DaemonConfig): void {
  // Always apply the patch, even when both blocks are absent — that's
  // the case where the operator removed a previously seeded provider
  // and expects the next boot to clear it. `buildPrefsPatch` defaults
  // every known key to `null`, so an empty config wipes prior state.
  userStore.setPrefs(buildPrefsPatch(config));
}
