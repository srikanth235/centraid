/*
 * @centraid/local-chat-runner
 *
 * Local-runtime `ChatRunner` for the centraid per-app chat. Spawns the
 * user's configured coding CLI (Codex or Claude Code) as a subprocess and
 * hands it a stdio MCP server that exposes the centraid_sql_* tools
 * scoped to the active app. Centraid bundles no inference loop.
 *
 * Consumers: the Electron desktop's local-runtime path
 * (`apps/desktop/src/main/local-runtime.ts`) constructs a runner via
 * `makeLocalChatRunner` and passes it into `new Runtime({ chatRunner })`.
 */

export {
  makeLocalChatRunner,
  defaultMcpServerScript,
  type MakeLocalChatRunnerOptions,
} from './local-chat-runner.js';

export type { RunnerKind, RunnerPrefs, AdapterCtx } from './types.js';

export { runPreflight, invalidatePreflightCache } from './preflight.js';
