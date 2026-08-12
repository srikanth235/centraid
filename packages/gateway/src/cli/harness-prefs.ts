/*
 * Seed the daemon's prefs file with `harness.*` prefs from the
 * config file.
 *
 * Without this, the runtime's per-turn prefs loader would see an empty
 * gateway preferences and fall back to "codex with whatever's on $PATH" —
 * which is fine for a default but doesn't pick up the daemon operator's
 * configured binPath / extra args.
 *
 * Idempotent: runs `setPrefs` with the same patch shape the renderer's
 * Settings panel uses, so re-running with the same config is a no-op.
 * A pref key set on a previous boot that's been removed from the
 * config file is explicitly cleared (set to `null`) so the file
 * remains the source of truth.
 */

import type { PrefsStore } from "@centraid/app-engine";

import type { DaemonConfig } from "./config.js";

const HARNESS_KEYS = [
  "harness.kind",
  "harness.binPath",
  "harness.extraArgs",
] as const;

export function buildPrefsPatch(config: DaemonConfig): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const k of HARNESS_KEYS) patch[k] = null;
  if (config.harness) {
    patch["harness.kind"] = config.harness.kind;
    if (config.harness.binPath !== undefined) {
      patch["harness.binPath"] = config.harness.binPath;
    }
    if (config.harness.extraArgs !== undefined) {
      patch["harness.extraArgs"] = config.harness.extraArgs;
    }
  }
  return patch;
}

export function seedHarnessPrefs(
  prefs: PrefsStore,
  config: DaemonConfig
): void {
  // Always apply the patch, even when `harness` is absent — that's the case
  // where the operator removed a previously seeded harness block and expects
  // the next boot to clear it. `buildPrefsPatch` defaults every known key to
  // `null`, so an empty config wipes prior state.
  prefs.setPrefs(buildPrefsPatch(config));
}
