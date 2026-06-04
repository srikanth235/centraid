/*
 * Default model seed for the chat picker.
 *
 * Shown by DEFAULT — before the user has ever hit Refresh — so the picker
 * offers real models out of the box. A manually-maintained seed: the moment
 * the user clicks Refresh, live enumeration (`enumerateRunnerModels`)
 * supersedes this table and the result is persisted to the gateway-owned
 * model-catalog.json.
 *
 * claude-code seeds with the SDK's capability aliases (`default`/`sonnet`/
 * `haiku`) — the same vocabulary `supportedModels()` returns on Refresh, so
 * the seed and the refreshed catalog agree. These are stable aliases, not
 * pinned provider ids, so they need no `no-hardcoded-model-ids` waiver.
 *
 * codex has no alias vocabulary, so it seeds with concrete ids — the one place
 * in production source that names concrete provider model ids, hence the
 * per-line `no-hardcoded-model-ids` waiver. That table drifts as lineups churn;
 * it only matters until first Refresh. Keep it current as a courtesy; Refresh
 * is the source of truth.
 */

import type { RunnerKind, RunnerModel } from '@centraid/app-engine';

export const DEFAULT_MODELS: Record<RunnerKind, RunnerModel[]> = {
  'claude-code': [
    { id: 'default', name: 'Default (recommended)', default: true },
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'haiku', name: 'Haiku' },
  ],
  // Mirrors OpenClaw's FALLBACK_CODEX_MODELS (extensions/codex/provider-catalog.ts).
  codex: [
    { id: 'gpt-5.5', name: 'GPT-5.5', default: true }, // governance: allow-no-hardcoded-model-ids default picker seed, superseded by Refresh
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' }, // governance: allow-no-hardcoded-model-ids default picker seed, superseded by Refresh
  ],
};

/** Default models for a runner, or `[]` for kinds with no seed. */
export function defaultModelsFor(kind: RunnerKind): RunnerModel[] {
  return DEFAULT_MODELS[kind] ?? [];
}
