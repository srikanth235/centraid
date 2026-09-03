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
  prefs.setPrefs(buildPrefsPatch(config));
}
