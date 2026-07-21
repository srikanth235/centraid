/*
 * Per-runner model enumeration.
 *
 * There is no per-kind enumeration strategy any more (issue #484). A runner
 * reports its models the same way it reports anything else — over ACP: an
 * agent advertises its model selector as a `configOptions` entry on the
 * `session/new` result. So enumeration is one generic ACP probe (launch →
 * initialize → session/new → read the model option; see `backends/acp/
 * enumerate-models.ts`), and it only echoes what the agent itself offers — we
 * never hardcode a catalog or fetch an external one.
 *
 * The probe is opt-in per kind (`AcpBackendSpec.probeModels`): the two
 * adapter-backed kinds that once had bespoke enumerators — codex (was
 * `codex app-server model/list`) and claude-code (was the Agent SDK's
 * `supportedModels()`) — opt in. Native ACP kinds stay on "Gateway default"
 * and pin a model per-session at turn time instead.
 *
 * This file is just the switchboard onto the registry hook. Everything is
 * best-effort: any failure (binary missing, adapter not installed, timeout,
 * AUTH_REQUIRED) resolves to `[]`, so the `CatalogWarmer` skips the write and
 * the cached entry (if any) is preserved. Enumeration runs only through the
 * warmer (boot + Refresh), never on a normal runner-status read.
 */

import type { RunnerKind, RunnerModel } from '@centraid/app-engine';
import { RUNNER_BACKENDS } from '../registry.js';

/**
 * Enumerate the models the active runner can serve, via the runner-backend
 * registry's per-kind `enumerateModels` hook (codex / claude-code → the
 * generic ACP model probe; every other kind → empty, since it pins its model
 * per-session rather than exposing a catalog). Returns `[]` on any failure or
 * unknown kind — never throws.
 */
export function enumerateRunnerModels(prefs: {
  kind: RunnerKind;
  binPath?: string;
  extraArgs?: string[];
}): Promise<RunnerModel[]> {
  const backend = RUNNER_BACKENDS[prefs.kind];
  if (!backend) return Promise.resolve([]);
  return backend.enumerateModels({
    ...(prefs.binPath ? { binPath: prefs.binPath } : {}),
    ...(prefs.extraArgs ? { extraArgs: prefs.extraArgs } : {}),
  });
}
