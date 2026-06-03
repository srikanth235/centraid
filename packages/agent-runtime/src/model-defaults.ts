/*
 * Hardcoded default model seed for the chat picker.
 *
 * These concrete ids are shown by DEFAULT — before the user has ever hit
 * Refresh — so the picker offers real, reproducible models out of the box
 * instead of a vague capability tier. They are a manually-maintained seed:
 * the moment the user clicks Refresh, live self-report enumeration
 * (`enumerateRunnerModels`) supersedes this table and the result is
 * persisted to the gateway-owned model-catalog.json.
 *
 * This is the one place in production source that names concrete provider
 * model ids, so each entry carries a per-line `no-hardcoded-model-ids`
 * waiver. The trade-off (a table that drifts as lineups churn) is accepted
 * deliberately: it only matters until first Refresh, which always reflects
 * the live runtime. Keep it current as a courtesy; Refresh is the source of
 * truth.
 */

import type { RunnerKind, RunnerModel } from '@centraid/app-engine';

export const DEFAULT_MODELS: Record<RunnerKind, RunnerModel[]> = {
  'claude-code': [
    { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', default: true }, // governance: allow-no-hardcoded-model-ids default picker seed, superseded by Refresh
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }, // governance: allow-no-hardcoded-model-ids default picker seed, superseded by Refresh
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' }, // governance: allow-no-hardcoded-model-ids default picker seed, superseded by Refresh
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
