/*
 * @centraid/agent-runtime
 *
 * Engine layer for centraid's agent surfaces. Three coding-agent
 * backends, one normalized event stream:
 *
 *   - `codex app-server` — spawned as a subprocess; JSON-RPC 2.0 stdio
 *   - `@anthropic-ai/claude-agent-sdk` — imported in-process; async generator
 *   - `openclaw acp` — spawned as a subprocess; Agent Client Protocol stdio
 *
 * All emit the same `ChatStreamEvent` shape, so downstream surfaces
 * don't need to know which one ran a given turn.
 *
 * Where this package fits in the bigger picture:
 *
 *   - `runAgentTurn` is the mode-agnostic engine primitive. The builder
 *     (`@centraid/agent-harness`) calls it directly with its own cwd /
 *     preamble / resume plumbing.
 *
 *   - `makeChatRunner` is the chat-side adapter (see ./chat-adapter.ts)
 *     that wraps `runAgentTurn` into a `ChatRunner` the gateway's
 *     `/_chat` route can inject. It's one of two `ChatRunner`
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

export { makeChatRunner, type MakeChatRunnerOptions } from './chat-adapter.js';

// The shared per-turn chat spine. `makeChatRunner` (data) and the gateway's
// `makeUnifiedChatRunner` (builder) are both thin configs over this.
export {
  makeChatRunnerCore,
  type ChatRunnerCoreOptions,
  type ChatTurnContext,
  type RunTurnFn,
} from './chat-runner-core.js';

// Builder agent sessions still want the `centraid` CLI on PATH for the
// `centraid preview snapshot` flow; expose the dist-dir resolver.
export { defaultCentraidCliDir } from './centraid-cli-dir.js';

export type { RunnerKind, RunnerPrefs, OpenAICompatProvider } from './types.js';

export {
  runAgentTurn,
  type AgentTurnInput,
  type AgentTurnConfig,
  type AgentTurnResult,
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
  runOpenClawAcpTurn,
  type OpenClawAcpInput,
  type OpenClawAcpConfig,
  type OpenClawAcpResult,
} from './openclaw-acp.js';

// ACP → ChatStreamEvent translator, exported for unit testing the mapping
// without spawning `openclaw acp`.
export { AcpStreamTranslator } from './openclaw-acp-events.js';

export {
  runPreflight,
  probeProvider,
  invalidatePreflightCache,
  minVersionString,
  parseSemver,
  compareSemver,
} from './preflight.js';

// Host tool enumeration — feeds the builder's available-tools grounding
// block so the agent declares `ctx.tool` calls + `requires` against the
// tools the host runtime actually exposes (issue #80 follow-up).
export { enumerateHostTools, type HostTool } from './host-tools.js';

// Ephemeral HTTP mock-LLM server used by the local automation runtime
// (see issue #70). Per-spawn lifecycle, bearer-token-as-dispatch-id
// correlation, speaks both Anthropic Messages and OpenAI Chat
// Completions.
export {
  startMockLlmServer,
  type MockLlmServerHandle,
  type MockLlmServerOptions,
  type StagedTurn,
  type CapturedToolResult,
} from './mock-llm-server.js';

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
