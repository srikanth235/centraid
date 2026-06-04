/*
 * @centraid/app-engine
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
  type RunnerStatusOptions,
  type RunnerModel,
  type ModelTier,
} from './runtime.js';

// Per-app chat surface — `ConversationRunner` is the host-injected seam, both
// OpenClaw and the desktop local-runtime implement it. The HTTP route
// (`POST /centraid/<id>/_turn`) is dispatched by `Runtime.handle` when
// `RuntimeOptions.conversationRunner` is set. The transcript lives in each app's
// per-app `runtime.sqlite`, fronted by `ConversationHistoryStore`.
export type {
  ConversationRunner,
  ConversationTurnInput,
  ConversationTurnResult,
  TurnStreamEvent,
} from './conversation/runner.js';
// Chat-runner core — the per-turn chat spine, sibling to the automation fire
// spine in `@centraid/automation`. The model turn is injected as a
// `RunTurnFn`; agent-runtime's `makeConversationRunner` and the gateway's
// `makeUnifiedConversationRunner` are thin configs over it (issue #147).
export {
  makeConversationRunnerCore,
  type ConversationRunnerCoreOptions,
  type TurnContext,
} from './conversation/runner-core.js';
export { buildExtraPrompt, type BuildExtraPromptInput } from './handlers/build-extra-prompt.js';

// Agent-turn contract — the host-agnostic interface between a run spine
// (chat-runner core, automation fire) and the backend that drives one model
// turn. The codex/claude implementation (`runTurn`) lives in
// `@centraid/agent-runtime`; hosts inject a `RunTurnFn` satisfying it.
export type {
  RunnerKind,
  RunnerPrefs,
  ToolContext,
  TurnInput,
  TurnConfig,
  TurnResult,
  TurnAttachment,
  RunTurnFn,
} from './conversation/turn.js';

export {
  startRuntimeHttpServer,
  type RuntimeHttpServerOptions,
  type RuntimeHttpServerHandle,
} from './http/http-server.js';

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
  RegistryEntry,
  QueryModule,
  ActionModule,
  HandlerFn,
  ScopedFetch,
  CommonHandlerArgs,
} from './types.js';

// Live-schema and cloud-panel payload shapes — consumed by agent-harness
// and the chat surface, and by the desktop cloud panel.
export type {
  AppSchema,
  AppSchemaTable,
  AppSchemaColumn,
  AppSchemaIndex,
  AppSchemaView,
} from './data/schema.js';
export type { AppTableRows } from './data/table-rows.js';
export type { RunQueryResult } from './handlers/run-query.js';
export { appendLogs } from './data/log-store.js';
export type { LogEntry, LogLevel } from './data/log-store.js';

// Low-level helpers the openclaw plugin uses to expose SQL + schema as
// agent tools without round-tripping through the HTTP surface.
export {
  runQuery,
  RunQueryError,
  RUN_QUERY_ROW_CAP,
  type RunQueryOptions,
} from './handlers/run-query.js';

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
} from './handlers/sql-ops.js';
export { readAppSchema } from './data/schema.js';
export { Registry } from './registry/registry.js';
export { appDataDir, isValidAppId } from './registry/app-paths.js';

// Wrapper-dir cleanup on app delete — removes `<appsDir>/<id>/` (data.sqlite
// + run ledgers) after the registry entry is dropped. Hosts that delete apps
// over their own surface (the gateway git-store DELETE) call this so a
// deleted app's data doesn't linger and resurrect under a recreated id.
export {
  cleanupDeregisteredApp,
  type CleanupOutcome,
  type DeregisterLogger,
} from './registry/deregister-cleanup.js';

// App manifest + three-tool dispatcher (issue #107). The dispatcher
// replaces the per-handler HTTP routes; openclaw-plugin registers MCP
// tools that delegate to `runtime.dispatcher.write/read/describe`.
export {
  APP_MANIFEST_FILE,
  MANIFEST_VERSION,
  MANIFEST_JSON_SCHEMA,
  RESERVED_HANDLER_PREFIX,
  ManifestError,
  isReservedHandlerName,
  parseManifest as parseAppManifest,
  validateManifest as validateAppManifest,
  compileSchema,
  findAction,
  findQuery,
  type Manifest as AppManifest,
  type ManifestActionEntry,
  type ManifestQueryEntry,
  type ManifestTable,
  type ManifestColumn,
  type HandlerConfirmation,
  type JsonSchema,
  type ManifestValidationCode as AppManifestValidationCode,
} from './registry/manifest.js';
export {
  Dispatcher,
  isToolName,
  statusForToolError,
  TOOL_NAMES,
  type CentraidWriteInput,
  type CentraidReadInput,
  type CentraidDescribeInput,
  type DispatcherOptions,
  type ToolErrorCode,
  type ToolErrorContent,
  type ToolErrorResult,
  type ToolSuccessResult,
  type ToolResult,
  type ToolName,
} from './handlers/dispatcher.js';

// Error classes — hosts that want to translate them to their own response
// shapes can import these directly. (The Runtime.handle() default handler
// already converts them to JSON error responses.)
export { RegistryError } from './registry/registry.js';
export { MigrationError, runPendingMigrations, type MigrationsApplied } from './data/migrate.js';

// Per-app change notifications. Subscribed by the SSE endpoint at
// /centraid/<appId>/_changes; emitted by any code path that writes to an
// app's data.sqlite (HTTP query route, openclaw legacy tool, app handlers).
// Hosts can subscribe from outside too — `runtime.changeBus.subscribe(...)`.
export { ChangeBus, type AppChange, type ChangeListener } from './changes/change-bus.js';

// Conversation-history store (the read/write facade backing the chat surface)
// + its HTTP route dispatcher. Used in two places:
//   - openclaw-plugin registers it on the gateway's HTTP surface
//   - startRuntimeHttpServer intercepts the same prefix for the embedded
//     local runtime, so the desktop sees identical behavior in both modes
// The store is conversation-first (spans kind=chat|build); the DTO types it
// returns keep the chat-surface vocabulary the renderer speaks.
export {
  ConversationHistoryStore,
  deriveTitle,
  type ConversationSummary,
  type ConversationMessageRow,
  type TurnNode,
  type ConversationTurnAttachment,
  type RecordTurnInput,
  type UserIdProvider,
} from './conversation/history.js';
export { makeConversationRouteHandler } from './http/conversation-routes.js';

// Per-app blob content-addressed store for attachment bytes (issue #190).
// Bytes live at `<appsDir>/<appId>/blobs/<hash>`, deduped by sha256; the
// `attachments` rows in `runtime.sqlite` carry the metadata. GC is
// refcount-by-hash off `ConversationStore.referencedHashes`.
export { BlobStore, blobUrl, hashBytes, type PutResult } from './data/blob-store.js';

// SQLite state — app-engine owns two migration ladders, each its own file +
// connection:
//   - gateway (`centraid-gateway.sqlite`):  users, user_prefs
//   - runtime (`<appRoot>/runtime.sqlite`): conversations, turns, items,
//                                           attachments, automation_state
// `UserStore` ← gateway; `ConversationHistoryStore` + the per-app conversation
// ledger ← each app's runtime.sqlite. Cross-file FKs aren't possible in SQLite, so
// `conversations.user_id` is application-enforced. The third (analytics)
// ladder lives in the `insights/` sub-module, built through `makeMigratedDbProvider`.
export {
  openGatewayDb,
  makeGatewayDbProvider,
  openRuntimeDb,
  makeRuntimeDbProvider,
  openMigratedDb,
  makeMigratedDbProvider,
  GATEWAY_MIGRATIONS,
  RUNTIME_MIGRATIONS,
  type DatabaseProvider,
} from './stores/gateway-db.js';

// Run-summary seam — the ledger emits one `RunSummary` per finished run
// through a `RunSummarySink`. The concrete sink (`AnalyticsStore`) lives in the
// `insights/` sub-module and is injected by the host; keeping the contract here
// (package root, not `insights/`) is what keeps the run ledger free of a
// reporting dependency and the boundary one-way (#151).
export type { RunSummary, RunSummarySink } from './conversation/run-summary-sink.js';

// User-prefs store + HTTP route dispatcher. Wraps the gateway DB; mounted
// by both hosts at `/_centraid-user`.
export { UserStore, makeUserStoreRouteHandler } from './stores/user-store.js';

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
} from './settings/app-settings.js';
export { buildSettingsInject, KNOWN_KEYS } from './settings/settings-merge.js';
export type { SettingsInject } from './http/static-server.js';

// Conversation ledger + ctx.state store (issue #190). The five tables
// (`conversations`, `turns`, `items`, `attachments`, `automation_state`)
// live in the per-app runtime DB; the store is runtime-owned and never
// reachable from handler `db` or the `centraid_sql_*` agent tools.
export {
  ConversationStore,
  type ConversationMeta,
  type CreateConversationInput,
  type InsertTurnInput,
  type FinishTurnInput,
  type InsertMessageInInput,
  type InsertItemInput,
  type OpenItemInput,
  type CloseItemInput,
  type InsertAttachmentInput,
  type ListTurnsOptions,
} from './conversation/store.js';
export type { RunStreamEvent } from './conversation/run-stream-event.js';
export type {
  Conversation,
  Turn,
  Item,
  Attachment,
  AutomationStateEntry,
  AutomationTriggerKind,
  AutomationTriggerOrigin,
  ItemKind,
  RunKind,
} from './conversation/schema.js';

// Per-model token pricing. `run_nodes.cost_usd` is frozen at write time
// via `costForUsage`; an unknown model yields `undefined` so the ledger
// records NULL (distinct from a genuine $0). See issue #90 question 4.
export { priceForModel, costForUsage, type ModelPrice, type TokenUsage } from './model-pricing.js';

// Insights domain — AnalyticsStore + InsightsStore + the analytics DB ladder.
// Lives in the `insights/` sub-module behind a one-way internal boundary:
// `insights/` builds its provider through the shared `makeMigratedDbProvider`
// above and implements the `RunSummarySink` contract, while the rest of
// app-engine emits run summaries through the injected sink and never imports
// back into `insights/`. Folded in from the former `@centraid/analytics`
// package (#151), kept as its own folder + barrel.
export * from './insights/index.js';

// App scaffolders + clone moved to @centraid/blueprints (#151).
