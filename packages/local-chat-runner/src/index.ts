/*
 * @centraid/local-chat-runner
 *
 * Local-runtime `ChatRunner` for the centraid per-app chat. Spawns the
 * user's configured coding CLI (Codex or Claude Code) as a subprocess
 * with cwd pinned to the active app's data dir and teaches it about a
 * small `centraid` CLI bin that reads/writes data.sqlite directly. No
 * MCP, no network, no token plumbing.
 *
 * Two consumption shapes:
 *
 *   - `makeLocalChatRunner(...)` — chat-specific `ChatRunner` factory the
 *     desktop's local-runtime path constructs and passes into
 *     `new Runtime({ chatRunner })`. Handles app-scoped cwd, ChatStore
 *     resume, and the centraid-CLI preamble.
 *
 *   - `runCodexTurn` / `runClaudeTurn` — mode-agnostic primitives that
 *     drive one CLI turn against a caller-supplied workspace and
 *     `extraSystemPrompt`. Builder-mode consumers import these directly
 *     and own their own cwd / preamble / resume-id plumbing.
 */

export {
  makeLocalChatRunner,
  defaultCentraidCliDir,
  type MakeLocalChatRunnerOptions,
} from './local-chat-runner.js';

export type { RunnerKind, RunnerPrefs } from './types.js';

export {
  runCodexTurn,
  type CodexTurnInput,
  type CodexTurnConfig,
  type CodexTurnResult,
  translateCodexLine,
} from './codex-adapter.js';

export {
  runClaudeTurn,
  type ClaudeTurnInput,
  type ClaudeTurnConfig,
  type ClaudeTurnResult,
  translateClaudeLine,
} from './claude-adapter.js';

export {
  runPreflight,
  invalidatePreflightCache,
  minVersionString,
  parseSemver,
  compareSemver,
} from './preflight.js';
