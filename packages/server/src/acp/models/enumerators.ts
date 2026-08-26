/*
 * Per-harness model enumeration (#484): one generic ACP probe (see
 * `backends/acp/enumerate-models.ts`) echoing only what the harness itself
 * advertises — never a hardcoded or external catalog. Opt-in per kind via
 * `AcpBackendSpec.probeModels` (codex, claude-code); other kinds stay on
 * "Gateway default" and pin a model at turn time.
 */

import type { HarnessKind, HarnessModel } from "@centraid/server/engine";

import { HARNESSES } from "../registry.js";

/**
 * Via the registry's `enumerateModels` hook; best-effort only through the
 * CatalogWarmer. Resolves `[]` on any failure or unknown kind — never throws.
 */
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
