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

// Automation manifest schema + validator. The `automation.json`
// manifest is the source of truth for an automation project — shared
// between producers (`@centraid/builder-harness` writes manifests
// during scaffolding / re-prompt) and consumers (the local automation
// runner in `@centraid/agent-runtime`, the openclaw plugin's
// reconciliation pass, and the desktop UI). See issue #91.
export {
  AutomationManifestError,
  AUTOMATION_HANDLER_FILE,
  AUTOMATION_MANIFEST_FILE,
  isValidAutomationId,
  isValidCronExpression,
  parseManifest,
  validateManifest,
  validateOutputAgainstSchema,
  cronTriggersOf,
  webhookTriggerOf,
  type AutomationManifest,
  type AutomationManifestRequires,
  type AutomationCostEstimate,
  type AutomationGeneratedMeta,
  type AutomationManifestValidationCode,
  type AutomationTrigger,
  type CronTrigger,
  type WebhookTrigger,
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
  AutomationTriggerOrigin,
  AutomationRunNodeKind,
  RunKind,
} from './automation-runs-schema.js';

// Per-model token pricing. `run_nodes.cost_usd` is frozen at write time
// via `costForUsage`; an unknown model yields `undefined` so the ledger
// records NULL (distinct from a genuine $0). See issue #90 question 4.
export { priceForModel, costForUsage, type ModelPrice, type TokenUsage } from './model-pricing.js';

// Insights — read-only analytics over the run ledger (issue #90). Powers
// the desktop Insights screen via an `INSIGHTS_SUMMARY` IPC handler.
export {
  InsightsStore,
  INSIGHTS_QUOTA_TOKENS,
  type InsightsSummary,
  type InsightsKpis,
  type InsightsDailyPoint,
  type InsightsAutomationRow,
  type InsightsModelRow,
  type InsightsActivityRow,
} from './insights-store.js';

// Automation projects on disk (issue #91). An automation is a
// first-class project — its own directory under `automationsDir` — and
// the directory is the source of truth (no SQLite definition table).
export {
  APP_AUTOMATIONS_SUBDIR,
  automationManifestPath,
  automationHandlerPath,
  readAutomationProject,
  readAutomationProjectAt,
  listAutomationProjects,
  listAppOwnedAutomations,
  listAllAutomationProjects,
  writeAutomationManifest,
  setAutomationEnabled,
  deleteAutomationProject,
  type AutomationRow,
  type AutomationProjectError,
  type ListAutomationProjectsResult,
} from './automation-project.js';
export type { AutomationHost, AutomationReconcileResult } from './automation-host.js';

// Webhook trigger dispatch (issue #96). A `webhook` trigger fires an
// automation on an inbound HTTP POST; the gateway mounts the route
// built by `makeWebhookRouteHandler`. Secret helpers are shared by the
// desktop's create flow (hash at scaffold time) and the route (verify).
export {
  WEBHOOK_ROUTE_PREFIX,
  generateWebhookId,
  generateWebhookSecret,
  hashWebhookSecret,
  verifyWebhookSecret,
  makeWebhookRouteHandler,
  type WebhookFireFn,
  type WebhookFireResult,
  type WebhookRouteOptions,
} from './automation-webhook.js';

// Automation handler runtime (issue #91). A fire executes the project's
// generated `handler.js` in a worker thread; the host supplies the
// tool / agent / invoke dispatchers. `runAutomationHandler` owns the
// ledger side — opening the `runs` row and recording the trace.
export {
  runAutomationHandler,
  type RunAutomationHandlerOptions,
  type AutomationHandlerOutcome,
  type AutomationToolCall,
  type AutomationToolResult,
  type AutomationToolDispatcher,
  type AutomationAgentCall,
  type AutomationAgentDispatcher,
  type AutomationInvokeResult,
  type AutomationInvokeDispatcher,
  type AutomationDispatchContext,
} from './automation-handler-runner.js';
export { truncateForAudit } from './automation-handler-audit.js';
