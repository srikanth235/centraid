/*
 * @centraid/runtime-core
 *
 * Transport-agnostic engine for centraid apps:
 *   - registry, versioned uploads, sqlite-backed handler runner
 *   - the full `/centraid/...` URL surface as a `Runtime.handle(req, res)` fn
 *
 * Hosts: `@centraid/openclaw-plugin` (OpenClaw gateway shim) and the
 * desktop in-process embed in `@centraid/desktop`.
 */

export { Runtime, type RuntimeOptions, type RuntimeLogger, type RunnerStatus } from './runtime.js';

// Per-app chat surface — `ChatRunner` is the host-injected seam, both
// OpenClaw and the desktop local-runtime implement it. The HTTP routes
// (`POST /centraid/<id>/_chat`, list / load / delete windows) are dispatched
// by `Runtime.handle` when `RuntimeOptions.chatRunner` is set.
export type {
  ChatRunner,
  ChatRunInput,
  ChatRunResult,
  ChatStreamEvent,
  ChatMode,
} from './chat-runner.js';
export {
  ChatStore,
  isValidWindowId,
  chatDir,
  chatSessionFile,
  chatIndexPath,
  CHAT_DIR_NAME,
  CHAT_INDEX_FILE,
  type ChatWindowMeta,
  type ChatIndex,
} from './chat-store.js';
export { buildExtraPrompt, type BuildExtraPromptInput } from './build-extra-prompt.js';

export {
  startRuntimeHttpServer,
  type RuntimeHttpServerOptions,
  type RuntimeHttpServerHandle,
} from './http-server.js';

// Public handler types — apps written in TypeScript import these to type
// their default exports.
export type {
  QueryHandler,
  ActionHandler,
  QueryHandlerArgs,
  ActionHandlerArgs,
  ActionResult,
  ScopedDb,
  ScopedLog,
  AppRef,
  AppId,
  AppMode,
  RegistryEntry,
  QueryModule,
  ActionModule,
  HandlerFn,
  ScopedFetch,
  CommonHandlerArgs,
} from './types.js';

// Live-schema and cloud-panel payload shapes — consumed by builder-harness
// and the chat-harness, and by the desktop cloud panel.
export type {
  AppSchema,
  AppSchemaTable,
  AppSchemaColumn,
  AppSchemaIndex,
  AppSchemaView,
} from './schema.js';
export type { AppTableRows } from './table-rows.js';
export type { RunQueryResult } from './run-query.js';
export type { LogEntry, LogLevel } from './log-store.js';

// Low-level helpers the openclaw plugin uses to expose SQL + schema as
// agent tools without round-tripping through the HTTP surface.
export { runQuery, RunQueryError, RUN_QUERY_ROW_CAP, type RunQueryOptions } from './run-query.js';

// Shared SQL operations exposed as agent tools (`centraid_sql_*`). Used by
// the codex / claude adapter tool registrations and by the legacy
// `centraid` CLI bin in `@centraid/agent-runtime`.
export {
  describeOp,
  readOp,
  writeOp,
  isSelectOnly,
  isWriteDml,
  SqlOpRefusal,
  SELECT_ROW_CAP,
  type DescribeResult,
  type ReadResult,
  type WriteResult,
  type WriteOpOptions,
} from './sql-ops.js';
export { readAppSchema } from './schema.js';
export { Registry } from './registry.js';
export { appDataDir } from './app-paths.js';

// Error classes — hosts that want to translate them to their own response
// shapes can import these directly. (The Runtime.handle() default handler
// already converts them to JSON error responses.)
export { RegistryError } from './registry.js';
export { VersionStoreError } from './version-store.js';
export { UploadError } from './upload.js';
export { MigrationError } from './migrate.js';

// Per-app change notifications. Subscribed by the SSE endpoint at
// /centraid/<appId>/_changes; emitted by any code path that writes to an
// app's data.sqlite (HTTP query route, openclaw legacy tool, app handlers).
// Hosts can subscribe from outside too — `runtime.changeBus.subscribe(...)`.
export { ChangeBus, type AppChange, type ChangeListener } from './change-bus.js';

// Chat-history store + HTTP route dispatcher. Used in two places:
//   - openclaw-plugin registers it on the gateway's HTTP surface
//   - startRuntimeHttpServer intercepts the same prefix for the embedded
//     local runtime, so the desktop sees identical behavior in both modes
export {
  ChatHistoryStore,
  deriveTitle,
  isUserMessage,
  type ChatSessionMeta,
  type ChatMessageRow,
  type AppendBatchResult,
  type UserIdProvider,
} from './chat-history.js';
export { makeChatHistoryRouteHandler } from './chat-history-routes.js';

// Shared gateway DB (single SQLite file holding `users`, `user_prefs`,
// `chat_sessions`, `chat_messages`). Hosts construct one provider and
// pass it to both UserStore and ChatHistoryStore so they share a
// connection + a single migration ladder + real cross-table FKs.
export {
  openGatewayDb,
  makeGatewayDbProvider,
  MIGRATIONS as GATEWAY_MIGRATIONS,
  type DatabaseProvider,
} from './gateway-db.js';

// User-prefs store + HTTP route dispatcher. Wraps the gateway DB; mounted
// by both hosts at `/_centraid-user`.
export { UserStore, makeUserStoreRouteHandler } from './user-store.js';

// Per-app `__centraid_settings` reader and the settings-merge pipeline that
// turns layered prefs/settings into the `SettingsInject` payload baked into
// each app's index.html.
export { readAppSettings, APP_SETTINGS_TABLE } from './app-settings.js';
export { buildSettingsInject, KNOWN_KEYS } from './settings-merge.js';
export type { SettingsInject } from './static-server.js';
