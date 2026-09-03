import type { HarnessKind, HarnessModel } from "@centraid/server/engine";

import { HARNESSES } from "../registry.js";

export function enumerateHarnessModels(prefs: {
  kind: HarnessKind;
  binPath?: string;
  extraArgs?: string[];
}): Promise<HarnessModel[]> {
  const harness = HARNESSES[prefs.kind];
  if (!harness) return Promise.resolve([]);
  return harness.enumerateModels({
    ...(prefs.binPath ? { binPath: prefs.binPath } : {}),
    ...(prefs.extraArgs ? { extraArgs: prefs.extraArgs } : {}),
  });
}
