/*
 * @centraid/agent-runtime
 *
 * Engine layer for centraid's agent surfaces. Two coding-agent backends,
 * one normalized event stream:
 *
 *   - `codex app-server` — spawned as a subprocess; JSON-RPC 2.0 stdio
 *   - `@anthropic-ai/claude-agent-sdk` — imported in-process; async generator
 *
 * Both emit the same `ChatStreamEvent` shape, so downstream surfaces
 * don't need to know which one ran a given turn.
 *
 * Where this package fits in the bigger picture:
 *
 *   - `runAgentTurn` is the mode-agnostic engine primitive. The builder
 *     (`@centraid/builder-harness`) calls it directly with its own cwd /
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

// OS-level scheduler glue (launchd / systemd / Task Scheduler) for
// the local path. Pure-function artifact generators (testable
// without touching the real scheduler) plus register/unregister/list
// that shell out via an injectable execShell.
export {
  register as registerOsJob,
  unregister as unregisterOsJob,
  list as listOsJobs,
  reconcile as reconcileOsJobs,
  jobLabel,
  currentPlatform,
  buildLaunchdPlist,
  cronToLaunchdIntervals,
  buildSystemdService,
  buildSystemdTimer,
  cronToSystemdOnCalendar,
  cronToSchtasksArgs,
  defaultExecShell,
  UnsupportedOsSchedulerError,
  type OsPlatform,
  type OsSchedulerJobSpec,
  type OsSchedulerJobInstalled,
  type OsSchedulerListEntry,
  type OsSchedulerOptions,
  type OsSchedulerReconcileDesired,
  type OsSchedulerReconcileResult,
  type ExecShell,
} from './os-scheduler.js';

// AutomationHost adapter wrapping os-scheduler. The desktop wires
// this into local-runtime so toggle/delete IPC calls reach the OS
// scheduler through the same interface openclaw uses on the cloud.
export { OsSchedulerHost, type OsSchedulerHostOptions } from './os-scheduler-host.js';
