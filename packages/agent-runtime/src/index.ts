/*
 * @centraid/agent-runtime
 *
 * Engine layer for centraid's agent surfaces. Two coding-agent backends,
 * one normalized event stream:
 *
 *   - `codex app-server` — spawned as a subprocess; JSON-RPC 2.0 stdio
 *   - `@anthropic-ai/claude-agent-sdk` — imported in-process; async generator
 *
 * Both emit the same `TurnStreamEvent` shape, so downstream surfaces
 * don't need to know which one ran a given turn.
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
 *     implementations in the repo — the other lives in
 *     `@centraid/openclaw-plugin` and drives an in-process openclaw
 *     agent. Desktop's embedded runtime injects this one; openclaw
 *     injects its own.
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
export { defaultCentraidCliDir } from './centraid-cli-dir.js';

export type { RunnerKind, RunnerPrefs } from './types.js';

export {
  runTurn,
  type TurnInput,
  type TurnConfig,
  type TurnResult,
  type ToolContext,
} from './runtime.js';

export {
  runCodexAppServerTurn,
  type CodexAppServerInput,
  type CodexAppServerConfig,
  type CodexAppServerResult,
} from './codex-app-server.js';

export {
  runClaudeSdkTurn,
  type ClaudeSdkInput,
  type ClaudeSdkConfig,
  type ClaudeSdkResult,
} from './claude-sdk.js';

export {
  runPreflight,
  probeCliAvailability,
  type CliAvailability,
  invalidatePreflightCache,
  minVersionString,
  parseSemver,
  compareSemver,
} from './preflight.js';

// Per-runner model catalog + default seed (issue #188). Exposed so the gateway
// can resolve each agent's models for the per-agent picker in Settings →
// Agents, not just the active runner's via runner-status.
export { resolveRunnerModels, resolveRunnerTools, readRunnerTools } from './model-catalog.js';
export { defaultModelsFor, DEFAULT_MODELS } from './model-defaults.js';
export { enumerateRunnerModels } from './model-enumerators.js';

// Host tool enumeration — feeds the builder's available-tools grounding
// block so the agent declares `ctx.tool` calls + `requires` against the
// tools the host runtime actually exposes (issue #80 follow-up).
export { enumerateHostTools, type HostTool } from './host-tools.js';

// Mock-LLM server (issue #70) now lives in `@centraid/automation` so
// both the CLI host (here) and the in-process host (openclaw-plugin) share one
// persistent-session runtime (issue #166). Re-exported here for back-compat.
export {
  startMockLlmServer,
  type MockLlmServerHandle,
  type MockLlmServerOptions,
  type StagedTurn,
  type CapturedToolResult,
} from '@centraid/automation';

// Local-side per-fire orchestrator for automations (issue #90 model-B).
// Looks up the user-owned automation row and runs its manifest prompt
// as an agent turn by spawning the claude / codex CLI.
export {
  runAutomationLocal,
  defaultSpawnCli,
  type RunAutomationLocalOptions,
  type AutomationRunRecord,
  type LocalRunnerKind,
  type SpawnCli,
  type SpawnCliInput,
  type SpawnCliResult,
} from './run-automation-local.js';

// Scheduling lives in `@centraid/automation` now (issue #149): the gateway
// owns an in-process cron `InProcessScheduler` and fires automations while it
// runs. The OS scheduler (launchd / systemd / Task Scheduler) and its
// `centraid run-automation` entry point are gone.
