/*
 * @centraid/local-chat-runner
 *
 * Unified local agent runtime for both the per-app chat AND the app
 * builder. Drives one turn through either:
 *
 *   - `codex app-server` — spawned as a subprocess; JSON-RPC 2.0 stdio
 *   - `@anthropic-ai/claude-agent-sdk` — imported in-process; async generator
 *
 * Both backends emit the same normalized `ChatStreamEvent` stream so
 * downstream surfaces (chat-harness, builder-harness) don't have to
 * know which one ran a given turn.
 *
 * The package also ships a tiny `centraid` CLI bin (subcommands:
 * `sql describe/read/write`, `preview snapshot`) that agent shell tools
 * can invoke when they need host-side capabilities (reading the
 * per-app sqlite or checking the preview snapshot's freshness).
 *
 * Two consumption shapes:
 *
 *   - `makeLocalChatRunner({ appsDir, prefsLoader })` — chat-specific
 *     `ChatRunner` factory the desktop's local-runtime path constructs
 *     and passes into `new Runtime({ chatRunner })`. Handles app-scoped
 *     cwd, ChatStore resume, and the chat preamble.
 *
 *   - `runAgentTurn(input, config)` — mode-agnostic primitive. Builder-
 *     mode consumers (and any future programmatic agent surface)
 *     import this directly and own their own cwd / preamble /
 *     resume-id plumbing.
 */

export {
  makeLocalChatRunner,
  defaultCentraidCliDir,
  type MakeLocalChatRunnerOptions,
} from './local-chat-runner.js';

export type { RunnerKind, RunnerPrefs } from './types.js';

export {
  runAgentTurn,
  type AgentTurnInput,
  type AgentTurnConfig,
  type AgentTurnResult,
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
  invalidatePreflightCache,
  minVersionString,
  parseSemver,
  compareSemver,
} from './preflight.js';
