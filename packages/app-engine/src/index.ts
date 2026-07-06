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
  type SurfaceStatus,
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
  VaultInvokeRunner,
  VaultContentRunner,
  VaultSqlRunner,
  VaultSqlToolResult,
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
  ScopedVault,
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

export { appendLogs } from './data/log-store.js';
export type { LogEntry, LogLevel } from './data/log-store.js';

export { Registry } from './registry/registry.js';
export { appDataDir, isValidAppId } from './registry/app-paths.js';

// Wrapper-dir cleanup on app delete — removes `<appsDir>/<id>/` (logs,
// settings.json, run blobs) after the registry entry is dropped. Hosts that
// delete apps over their own surface (the gateway git-store DELETE) call
// this so a deleted app's runtime state doesn't linger under a recreated id.
export {
  cleanupDeregisteredApp,
  type CleanupOutcome,
  type DeregisterLogger,
} from './registry/deregister-cleanup.js';

// App manifest + declared-handler dispatcher (issue #107, narrowed by
// #286 phase 2: no `_sql` builtins, no live-schema reads).
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
  type ManifestExtBlock,
  type ManifestExtTable,
  type ManifestExtColumn,
  type ManifestExtIndex,
  type ManifestVaultBlock,
  type ManifestVaultScope,
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

// ctx.vault bridge contract (duaility §12). app-engine defines only the
// shape; the gateway package implements it against @centraid/vault and
// injects it via `RuntimeOptions.vaultFor`.
export type { VaultBridge, VaultCall, VaultCallResult, VaultOp } from './handlers/vault-bridge.js';

// The worker-thread handler runner — exported for host surfaces that run an
// app-authored module outside the dispatcher (the scenario-seed loader,
// issue #290 phase 1, runs `seed.js` with a demo-register vault bridge).
export {
  runHandler,
  type HandlerOutcome,
  type RunHandlerOptions,
} from './handlers/handler-runner.js';

// Error classes — hosts that want to translate them to their own response
// shapes can import these directly. (The Runtime.handle() default handler
// already converts them to JSON error responses.)
export { RegistryError } from './registry/registry.js';

// Per-app change notifications. Subscribed by the SSE endpoint at
// /centraid/<appId>/_changes; emitted after successful app writes so views
// re-derive. Hosts can subscribe from outside too —
// `runtime.changeBus.subscribe(...)`.
export { ChangeBus, type AppChange, type ChangeListener } from './changes/change-bus.js';

// Conversation-history store (the read/write facade backing the chat surface)
// + its HTTP route dispatcher. Used in two places:
//   - openclaw-plugin registers it on the gateway's HTTP surface
//   - startRuntimeHttpServer intercepts the same prefix for the embedded
//     local runtime, so the desktop sees identical behavior in both modes
// The store is conversation-first (spans kind=chat|build); the DTO types it
// returns keep the chat-surface vocabulary the renderer speaks.
export {
  ASSISTANT_APP_ID,
  ConversationHistoryStore,
  deriveTitle,
  type ConversationSummary,
  type ConversationMessageRow,
  type TurnNode,
  type ConversationTurnAttachment,
  type RecordTurnInput,
} from './conversation/history.js';
export { makeConversationRouteHandler } from './http/conversation-routes.js';
// The shared SSE turn driver (stream framing + run-ledger fold) — the
// per-app `_turn` route and the gateway's vault-assistant route both ride it.
export {
  driveTurnOverSse,
  withConversationLock,
  type DriveTurnOptions,
  type TurnAttachmentRef,
} from './http/turn-sse.js';
export { isValidConversationId } from './http/turn-routes.js';

// Blob content-addressed store for attachment bytes (issue #190). Bytes live
// at `<workspace appsDir>/<appId>/blobs/<hash>` inside the vault, deduped by
// sha256; the `attachments` rows in the vault's `transcripts.db` carry the
// metadata. GC is refcount-by-hash off `ConversationStore.referencedHashes`.
export { BlobStore, blobUrl, hashBytes, type PutResult } from './data/blob-store.js';

// SQLite state — app-engine owns ONE migration ladder (#280):
//   - transcripts (`<vaultDir>/<vaultId>/transcripts.db`): conversations,
//     turns, items, attachments, automation_state, run_summary — the
//     per-vault ledger + rollup. The old identity.sqlite (users/user_prefs)
//     and central analytics.sqlite are gone.
// Cross-file FKs aren't possible in SQLite, so `conversations.user_id` (the
// vault owner's party id) is application-enforced.
export {
  openTranscriptsDb,
  makeTranscriptsDbProvider,
  openMigratedDb,
  makeMigratedDbProvider,
  TRANSCRIPTS_MIGRATIONS,
  type DatabaseProvider,
} from './stores/gateway-db.js';

// The per-vault workspace view app-engine operates in (#280): the gateway
// resolves the ACTIVE vault and injects this shape; stores re-resolve per
// call so a vault switch lands without reconstruction.
export type { VaultWorkspace, WorkspaceProvider } from './stores/vault-workspace.js';

// Run-summary seam — the ledger emits one `RunSummary` per finished run
// through a `RunSummarySink`. The concrete sink (`AnalyticsStore`) lives in the
// `insights/` sub-module and is injected by the host; keeping the contract here
// (package root, not `insights/`) is what keeps the run ledger free of a
// reporting dependency and the boundary one-way (#151).
export type { RunSummary, RunSummarySink } from './conversation/run-summary-sink.js';

// Device-prefs store + HTTP route dispatcher (a JSON file — #280 killed the
// identity DB; the wire prefix stays `/_centraid-user` for the desktop client).
export { PrefsStore, makeUserStoreRouteHandler } from './stores/prefs-store.js';

// Per-app `settings.json` reader and the settings-merge pipeline that
// turns layered prefs/settings into the `SettingsInject` payload baked into
// each app's index.html.
export {
  readAppSettings,
  readAppSetting,
  writeAppSetting,
  deleteAppSetting,
  automationEnabledKey,
  APP_SETTINGS_FILE,
  RUNTIME_KEY_PREFIX,
} from './settings/app-settings.js';
export { buildSettingsInject, KNOWN_KEYS } from './settings/settings-merge.js';
export type { SettingsInject } from './http/static-server.js';

// Conversation ledger + ctx.state store (issue #190). The five tables
// (`conversations`, `turns`, `items`, `attachments`, `automation_state`)
// live in the runtime-owned conversation DB, never reachable from handlers.
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
