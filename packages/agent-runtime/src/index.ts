/*
 * @centraid/agent-runtime
 *
 * Engine layer for centraid's agent surfaces. Every coding-agent kind runs
 * through ONE integration path — the Agent Client Protocol (ACP): JSON-RPC
 * 2.0 over stdio, spoken natively by most kinds and via a first-party adapter
 * for claude-code and codex (issue #479). A single backend normalizes every
 * kind's stream into the same `TurnStreamEvent` shape, so downstream surfaces
 * don't need to know which agent ran a given turn.
 *
 * Where this package fits in the bigger picture:
 *
 *   - `runTurn` is the mode-agnostic engine primitive. The builder
 *     (`@centraid/agent-harness`) calls it directly with its own cwd /
 *     preamble / resume plumbing.
 *
 *   - `makeConversationRunner` is the chat-side adapter (see ./conversation-adapter.ts)
 *     that wraps `runTurn` into a `ConversationRunner` the gateway's
 *     `/_turn` route can inject. It's one of two `ConversationRunner`
 *     implementations in the repo — the other is the gateway's
 *     `makeUnifiedConversationRunner`.
 *
 * The package also ships a tiny `centraid` CLI bin (subcommands:
 * `sql describe/read/write`, `preview snapshot`) that agent shell tools
 * can invoke when they need host-side capabilities (reading the
 * per-app sqlite or checking the preview snapshot's freshness).
 */

export {
  makeConversationRunner,
  type MakeConversationRunnerOptions,
} from './conversation-adapter.js';

// The shared per-turn chat spine (`makeConversationRunnerCore`) lives in
// `@centraid/app-engine`, next to the `ConversationRunner` interface and the
// agent-turn contract it wires together. `makeConversationRunner` (above) is
// this backend's thin config over it, injecting `runTurn` as the `RunTurnFn`;
// the gateway's `makeUnifiedConversationRunner` configures the same core.

// Builder agent sessions still want the `centraid` CLI on PATH for the
// `centraid preview snapshot` flow; expose the dist-dir resolver.
export { defaultCentraidCliDir } from './cli/centraid-cli-dir.js';

export type { RunnerKind, RunnerPrefs } from './types.js';

export {
  runTurn,
  type TurnInput,
  type TurnConfig,
  type TurnResult,
  type ToolContext,
} from './runtime.js';

// The backend-neutral vault-register tool specs (name / description /
// inputSchema). Both coding-agent backends declare their tools from these.
export { VAULT_SQL_TOOL, VAULT_INVOKE_TOOL, VAULT_CONTENT_TOOL } from './vault-sql-tool.js';

// The single turn-driving path (issue #479). codex and claude-code no longer
// have bespoke backends — they are ACP entries whose adapter is launched by
// `AcpAdapterSpec`, same as every other kind.
export {
  runAcpTurn,
  type AcpAdapterSpec,
  type AcpTurnInput,
  type AcpTurnConfig,
  type AcpTurnResult,
} from './backends/acp/backend.js';

export {
  resolveAcpCapabilities,
  clearCapabilitiesCache,
  type AcpAgentCapabilities,
} from './backends/acp/capabilities-cache.js';

// Runner-backend registry — the single dispatch table every runner kind
// registers with. `runTurn`, preflight, and model enumeration all read from
// it; the gateway can enumerate `RUNNER_BACKENDS` for labels / defaults.
export {
  RUNNER_BACKENDS,
  getRunnerBackend,
  type RunnerBackend,
  type RunnerVersion,
} from './registry.js';

export {
  runPreflight,
  probeCliAvailability,
  type CliAvailability,
  invalidatePreflightCache,
  minVersionString,
  parseSemver,
  compareSemver,
} from './preflight.js';

// Per-runner model catalog (issue #188). The pure read (`readRunnerModels`) is
// exposed so the gateway can surface each agent's models for the per-agent
// picker in Settings → Agents and the active runner via runner-status; the
// `CatalogWarmer` owns enumeration (boot + Refresh) and `deriveStatus` turns
// the cache into the picker's loading/ready/empty tri-state.
export { readRunnerModels } from './models/catalog.js';
export {
  CatalogWarmer,
  deriveStatus,
  type CatalogSurface,
  type CatalogWarmerOptions,
  type SurfaceStatus,
} from './models/catalog-warmer.js';
export { enumerateRunnerModels } from './models/enumerators.js';

// Local-side per-fire orchestrator for automations (issue #90 model-B).
// Looks up the user-owned automation and runs its handler against a live
// dispatch surface. The only billed rail is `ctx.agent` — a bounded model
// turn routed through the runner registry (issue #479); the deterministic
// rails (`ctx.vault` / `ctx.fetch` / `ctx.state` / `ctx.runs`) run in-process.
export { runAutomation, type RunAutomationOptions } from './automation/run-automation.js';

// Scheduling lives in `@centraid/automation` now (issue #149): the gateway
// owns an in-process cron `InProcessScheduler` and fires automations while it
// runs. The OS scheduler (launchd / systemd / Task Scheduler) and its
// `centraid run-automation` entry point are gone.
