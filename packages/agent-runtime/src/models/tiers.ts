/*
 * Provider-agnostic capability tiers for CLI-backed runners.
 *
 * Neither the codex nor the Claude Code CLI exposes a model-list command, and
 * pinning concrete provider model ids in centraid is disallowed (lineups
 * churn — see the `no-hardcoded-model-ids` governance directive). So instead
 * of a static model catalog, the picker offers capability TIERS (the same
 * indirection automations use via `requires.model`). The runner adapter
 * resolves a tier to the runtime's native model at turn time — `resolveClaudeModel`
 * below maps them to the Claude CLI's built-in aliases — so no concrete ids
 * live here. The ACP backend feeds that alias into its match against the
 * model options the agent advertises (`AcpTurnConfig.resolveModel`).
 *
 * `RunnerModel.id` carries the tier token (persisted as the chat model);
 * `name` is the human label.
 *
 * codex is intentionally absent: it accepts neither model aliases nor a
 * tier vocabulary, so its picker stays on "Gateway default" (a custom
 * OpenAI-compatible endpoint still surfaces its live `/models` separately).
 */

import type { RunnerModel } from '@centraid/app-engine';
import type { RunnerKind } from '../types.js';

/** Capability tier tokens understood by the runner adapters. */
export type CapabilityTier = 'smart' | 'balanced' | 'fast';

export const RUNNER_TIERS: Partial<Record<RunnerKind, readonly RunnerModel[]>> = {
  'claude-code': [
    { id: 'smart', name: 'Most capable', default: true },
    { id: 'balanced', name: 'Balanced' },
    { id: 'fast', name: 'Fastest' },
  ],
};

/**
 * Map a capability tier to the Claude CLI's built-in model aliases (it
 * resolves these to the latest model in each tier). Any other value — a full
 * model id or the gateway default — passes through unchanged, so concrete ids
 * the caller supplies still work.
 */
const CLAUDE_TIER_ALIAS: Record<CapabilityTier, string> = {
  smart: 'opus',
  balanced: 'sonnet',
  fast: 'haiku',
};

export function resolveClaudeModel(model: string): string {
  return CLAUDE_TIER_ALIAS[model as CapabilityTier] ?? model;
}
