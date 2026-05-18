/*
 * @centraid/local-chat-runner
 *
 * Local-runtime `ChatRunner` for the centraid per-app chat. Spawns the
 * user's configured coding CLI (Codex or Claude Code) as a subprocess
 * with cwd pinned to the active app's data dir and teaches it about a
 * small `centraid` CLI bin that reads/writes data.sqlite directly. No
 * MCP, no network, no token plumbing.
 *
 * Consumers: the Electron desktop's local-runtime path
 * (`apps/desktop/src/main/local-runtime.ts`) constructs a runner via
 * `makeLocalChatRunner` and passes it into `new Runtime({ chatRunner })`.
 */

export {
  makeLocalChatRunner,
  defaultCentraidCliDir,
  type MakeLocalChatRunnerOptions,
} from './local-chat-runner.js';

export type { RunnerKind, RunnerPrefs, AdapterCtx } from './types.js';

export {
  runPreflight,
  invalidatePreflightCache,
  minVersionString,
  parseSemver,
  compareSemver,
} from './preflight.js';
