/*
 * Seeds the daemon's prefs with `harness.*` from the config file. Without it
 * the per-turn prefs loader sees empty gateway prefs and falls back to
 * "codex on $PATH", missing the operator's binPath/extraArgs.
 *
 * Idempotent; a key removed from the config file is explicitly cleared
 * (`null`) so the file stays the source of truth.
 */

import type { PrefsStore } from "@centraid/server/engine";

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
