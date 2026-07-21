/*
 * Per-runner model enumeration.
 *
 * Each CLI-backed runner reports the models it can actually run via a
 * control-plane call — we never hardcode a catalog or fetch an external one:
 *
 *  - claude-code: the Agent SDK's `query().supportedModels()` control method.
 *    The CLI reports its built-in model list (aliases like `default`/`sonnet`/
 *    `haiku`, each with a display name) over the control channel — no model
 *    turn, no tokens.
 *  - codex: the app-server `model/list` JSON-RPC method (see codex/model-list.ts).
 *
 * Each backend's enumerator lives beside its adapter in `backends/<kind>/
 * model-list.ts`; this file is just the per-runner switchboard.
 *
 * Everything is best-effort: any failure (binary missing, SDK load error,
 * timeout) resolves to `[]`, so the `CatalogWarmer` simply skips the write and
 * the cached entry (if any) is preserved. Enumeration runs only through the
 * warmer (boot + Refresh), never on a normal runner-status read.
 */

import type { RunnerKind, RunnerModel } from '@centraid/app-engine';
import { RUNNER_BACKENDS } from '../registry.js';

/**
 * Enumerate the models the active runner can serve, via the runner-backend
 * registry's per-kind `enumerateModels` hook (codex → app-server
 * `model/list`; claude → SDK `supportedModels()`; ACP kinds → empty, since
 * ACP has no model catalog). Returns `[]` on any failure or unknown kind —
 * never throws.
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
