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

export {
  Runtime,
  type RuntimeOptions,
  type RuntimeLogger,
  type RunnerStatus,
  type ProviderStatus,
} from './runtime.js';

// Per-app chat surface — `ChatRunner` is the host-injected seam, both
// OpenClaw and the desktop local-runtime implement it. The HTTP route
// (`POST /centraid/<id>/_chat`) is dispatched by `Runtime.handle` when
// `RuntimeOptions.chatRunner` is set. The transcript itself lives in the
// central gateway SQLite (`ChatHistoryStore`), not a per-app folder.
export type {
  ChatRunner,
  ChatRunInput,
  ChatRunResult,
  ChatStreamEvent,
  ChatMode,
} from './chat-runner.js';
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
export { appDataDir, readActiveCodeDir } from './app-paths.js';

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
  type ChatSessionMeta,
  type ChatMessageRow,
  type ChatTurnNode,
  type RecordTurnInput,
  type UserIdProvider,
} from './chat-history.js';
export { makeChatHistoryRouteHandler } from './chat-history-routes.js';

// Gateway state DBs — two separate SQLite files, each with its own
// connection + migration ladder:
//   - gateway  (`centraid-gateway.sqlite`):  users, user_prefs
//   - activity (`centraid-activity.sqlite`): automations, chat_sessions,
//                                            runs, run_nodes, automation_state
// Hosts construct one provider per file and pass each to the matching
// store: UserStore ← gateway; ChatHistoryStore + AutomationStore +
// AutomationRunsStore all share the activity provider. Cross-file FKs
// aren't possible in SQLite, so `chat_sessions.user_id` /
// `automations.user_id` are application-enforced.
export {
  openGatewayDb,
  makeGatewayDbProvider,
  openActivityDb,
  makeActivityDbProvider,
  GATEWAY_MIGRATIONS,
  ACTIVITY_MIGRATIONS,
  type DatabaseProvider,
} from './gateway-db.js';

// User-prefs store + HTTP route dispatcher. Wraps the gateway DB; mounted
// by both hosts at `/_centraid-user`.
export { UserStore, makeUserStoreRouteHandler } from './user-store.js';

// Per-app `__centraid_settings` reader and the settings-merge pipeline that
// turns layered prefs/settings into the `SettingsInject` payload baked into
// each app's index.html.
export {
  readAppSettings,
  readAppSetting,
  writeAppSetting,
  deleteAppSetting,
  automationEnabledKey,
  APP_SETTINGS_TABLE,
  RUNTIME_KEY_PREFIX,
} from './app-settings.js';
export { buildSettingsInject, KNOWN_KEYS } from './settings-merge.js';
export type { SettingsInject } from './static-server.js';

// Automation manifest schema + validator. Shared between producers
// (`@centraid/builder-harness` writes manifests during scaffolding /
// re-prompt) and consumers (the local automation runner in
// `@centraid/agent-runtime`, the openclaw plugin's reconciliation pass,
// and the desktop UI). See issue #70.
export {
  AutomationManifestError,
  isValidAutomationName,
  isValidCronExpression,
  parseManifest,
  validateManifest,
  validateOutputAgainstSchema,
  type AutomationManifest,
  type AutomationManifestRequires,
  type AutomationCostEstimate,
  type AutomationGeneratedMeta,
  type AutomationManifestValidationCode,
  type AutomationTrigger,
  type AutomationOutputSchema,
  type AutomationHistoryConfig,
  type AutomationHistoryKeep,
} from './automation-manifest.js';

// Unified agent-run ledger + ctx.state store. The three tables
// (`runs`, `run_nodes`, `automation_state`) live in the activity DB;
// the store is runtime-owned and never reachable from handler `db` or
// the `centraid_sql_*` agent tools. See issues #80 and #90.
export {
  AutomationRunsStore,
  type InsertRunInput,
  type FinishRunInput,
  type InsertNodeInput,
  type ListRunsOptions,
} from './automation-runs-store.js';
export type {
  AutomationRunRow,
  AutomationRunNodeRow,
  AutomationStateEntry,
  AutomationTriggerKind,
  AutomationRunNodeKind,
  RunKind,
} from './automation-runs-schema.js';

// Per-model token pricing. `run_nodes.cost_usd` is frozen at write time
// via `costForUsage`; an unknown model yields `undefined` so the ledger
// records NULL (distinct from a genuine $0). See issue #90 question 4.
export { priceForModel, costForUsage, type ModelPrice, type TokenUsage } from './model-pricing.js';

// Per-gateway automations mirror table (`gateway-db.ts` ACTIVITY_MIGRATIONS[0]).
// The host scheduler (openclaw cron remote, OS scheduler local) owns
// runtime state; this is centraid's own registration surface for the
// list/UI and the reconciliation pass.
export { AutomationStore, type AutomationRow } from './automation-store.js';
export type { AutomationHost, AutomationReconcileResult } from './automation-host.js';

// Deploy boundary for automations: scan an app's `automations/*.json`
// and bring the mirror into agreement. Called by `handleAppUpload`
// after a publish lands; hosts can also call directly for out-of-band
// syncs (tests, manual refresh).
export {
  syncAutomationsFromDisk,
  type SyncAutomationsOptions,
  type SyncAutomationsResult,
  type SyncAutomationError,
} from './sync-automations.js';

// Agent-driven automation runner (issue #90 model-B). An automation
// fire is an agent turn driven by the manifest prompt — no JS handler,
// no worker. Hosts supply an `AutomationAgentDispatcher` that runs the
// turn against their agent backend (codex / claude locally, the
// openclaw in-process StreamFn on the gateway) and yield the trace
// events the runner records as `step` / `tool` nodes.
export {
  runAutomationAgent,
  type RunAutomationAgentOptions,
  type AutomationAgentOutcome,
  type AutomationAgentDispatcher,
  type AutomationAgentRunInput,
  type AutomationAgentEvent,
} from './automation-agent-runner.js';
