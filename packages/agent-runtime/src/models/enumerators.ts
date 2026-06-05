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
import { enumerateCodexModels } from '../backends/codex/model-list.js';
import { enumerateClaudeModels } from '../backends/claude/model-list.js';

/**
 * Enumerate the models the active runner can serve. Returns `[]` on any
 * failure — never throws.
 */
export function enumerateRunnerModels(prefs: {
  kind: RunnerKind;
  binPath?: string;
  extraArgs?: string[];
}): Promise<RunnerModel[]> {
  switch (prefs.kind) {
    case 'claude-code':
      // The claude SDK turn path ignores extraArgs, so enumeration does too.
      return enumerateClaudeModels(prefs.binPath);
    case 'codex':
      // Mirror the runner's `codex app-server` args so we enumerate the same
      // catalog the real runner serves (e.g. a `-c`/profile override).
      return enumerateCodexModels(prefs.binPath, prefs.extraArgs);
    default:
      return Promise.resolve([]);
  }
}
