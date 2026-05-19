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

// Local-side per-fire orchestrator for automations. Loads the manifest,
// stands up the mock-LLM, drives the worker, spawns claude / codex
// subprocesses per ctx.tool batch, routes ctx.agent through the user's
// real provider. See issue #70.
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
  type OsSchedulerOptions,
  type ExecShell,
} from './os-scheduler.js';
