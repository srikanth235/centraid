/*
 * @centraid/server/engine — transport-agnostic engine for centraid apps: the
 * registry, the handler runner, and the whole `/centraid/...` URL surface as a
 * `Runtime.handle(req, res)` function.
 */

export {
  WorkerPool,
  workerPoolSizeFromEnv,
  workerResourceLimitsFromEnv,
  type WorkerResourceLimits,
} from "./handlers/worker-pool.js";
export {
  Runtime,
  type RuntimeOptions,
  type RuntimeLogger,
  type HarnessStatus,
  type HarnessStatusOptions,
  type HarnessModel,
  type ModelTier,
  type SurfaceStatus,
} from "./runtime.js";

export {
  isValidConversationId,
  type AskModelInfo,
  type AskModelOption,
  type AskModelPrefs,
} from "./http/turn-routes.js";

export type {
  ConversationRunner,
  ConversationTurnInput,
  ConversationTurnResult,
  TurnStreamEvent,
  HarnessFailureClass,
} from "./conversation/runner.js";
export {
  makeConversationRunnerCore,
  type ConversationRunnerCoreOptions,
  type TurnContext,
} from "./conversation/runner-core.js";
export {
  buildExtraPrompt,
  type BuildExtraPromptInput,
} from "./handlers/build-extra-prompt.js";

export type {
  HarnessKind,
  HarnessPrefs,
  ToolContext,
  TurnInput,
  TurnConfig,
  TurnResult,
  TurnAttachment,
  HarnessUsageSnapshot,
  RunTurnFn,
  VaultInvokeRunner,
  VaultContentRunner,
  VaultSqlRunner,
  VaultSqlToolResult,
} from "./conversation/turn.js";
export { HARNESS_KINDS, isHarnessKind } from "./conversation/turn.js";
export {
  TurnPlane,
  TURN_HYDRATION_MIN_TURNS,
  TURN_HYDRATION_TOKEN_BUDGET,
  type TurnPlaneEgressDeniedError,
  type TurnPosture,
} from "./conversation/turn-plane.js";
export {
  HarnessSessions,
  type HarnessSessionBinding,
  type HarnessSessionObservation,
  type HarnessSessionSource,
} from "./conversation/harness-sessions.js";

export {
  startRuntimeHttpServer,
  AUTHED_DEVICE_HEADER,
  AUTHED_PLANE_HEADER,
  type RuntimeHttpServerOptions,
  type RuntimeHttpServerHandle,
  type BearerAuthorization,
} from "./http/http-server.js";
export { COMPANION_GRANTS_HEADER } from "./http/internal-headers.js";
export {
  tuneGatewayHttpServer,
  GATEWAY_KEEP_ALIVE_TIMEOUT_MS,
  GATEWAY_HEADERS_TIMEOUT_MS,
  GATEWAY_REQUEST_TIMEOUT_MS,
  GATEWAY_MAX_CONNECTIONS,
  GATEWAY_SHUTDOWN_GRACE_MS,
} from "./http/server-tuning.js";
export { negotiateEncoding, type Encoding } from "./http/compression.js";

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
  ScopedTime,
  CommonHandlerArgs,
} from "./types.js";

export { appendLogs } from "./data/log-store.js";
export type { LogEntry, LogLevel } from "./data/log-store.js";

export { Registry } from "./registry/registry.js";
export { appDataDir, isValidAppId } from "./registry/app-paths.js";

export {
  cleanupDeregisteredApp,
  type CleanupOutcome,
  type DeregisterLogger,
} from "./registry/deregister-cleanup.js";

export {
  APP_MANIFEST_FILE,
  CANONICAL_DESIGNED_STATES,
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
  type ManifestSeatsBlock,
  type ManifestStatesBlock,
  type ManifestStateExclusion,
  type ManifestDesignedState,
  type HandlerConfirmation,
  type JsonSchema,
  type ManifestValidationCode as AppManifestValidationCode,
} from "./registry/manifest.js";
export {
  scanCssTokenPurity,
  formatTokenPurityError,
  type TokenPurityFinding,
  type TokenPurityOptions,
} from "./registry/token-purity.js";
export {
  Dispatcher,
  statusForToolError,
  type CentraidWriteInput,
  type CentraidReadInput,
  type CentraidDescribeInput,
  type DispatcherOptions,
  type ToolErrorCode,
  type ToolErrorContent,
  type ToolErrorResult,
  type ToolSuccessResult,
  type ToolResult,
} from "./handlers/dispatcher.js";

export type {
  VaultBridge,
  VaultCall,
  VaultCallResult,
  VaultOp,
} from "./handlers/vault-bridge.js";

export {
  runHandler,
  type HandlerOutcome,
  type RunHandlerOptions,
} from "./handlers/handler-runner.js";

export {
  WorkerAdmission,
  gatewayBusyError,
  workerAdmissionStats,
  WORKER_MAX_CONCURRENT,
  WORKER_MAX_QUEUE,
  WORKER_MAX_QUEUE_WAIT_MS,
} from "./handlers/worker-admission.js";

export { RegistryError } from "./registry/registry.js";

export {
  ChangeBus,
  type AppChange,
  type ChangeListener,
} from "./changes/change-bus.js";
// The cap is per-appId, never global: a user may legitimately have several
// windows of the SAME app open.
export {
  changesSubscriberCount,
  ChangesSubscriberCap,
  CHANGES_SSE_MAX_SUBSCRIBERS_PER_APP,
} from "./http/changes-sse.js";

export { SseStream } from "./http/sse-stream.js";

export {
  ASSISTANT_APP_ID,
  ConversationHistoryStore,
  deriveTitle,
  type ConversationSummary,
  type ConversationSearchResult,
  type ConversationMessageRow,
  type ConversationAttachmentPayload,
  type TurnNode,
  type ConversationTurnAttachment,
  type RecordTurnInput,
  type RecordedTurnReplay,
  type SessionTranscript,
} from "./conversation/history.js";
export type { ArchiveBlobReader } from "./conversation/rehydrate.js";
export {
  generateConversationTitle,
  cleanTitle,
  type GenerateTitleDeps,
} from "./conversation/auto-title.js";
export {
  classifyCaptureWithHarness,
  parseCapturePreview,
  type CapturePreview,
  type ClassifyCaptureDeps,
} from "./conversation/capture-classifier.js";
export { makeConversationRouteHandler } from "./http/conversation-routes.js";
export {
  driveTurnOverSse,
  withConversationLock,
  parseTurnAttachmentRefs,
  resolveTurnAttachments,
  validateTurnAttachmentRefs,
  type DriveTurnOptions,
  type TurnAttachmentRef,
} from "./http/turn-sse.js";
export {
  parseAdditionalDirectories,
  parseWorkspaceKind,
} from "./http/turn-sse-support.js";
export { buildReplayEvents } from "./http/turn-replay.js";
export {
  TurnLimiter,
  writeTurnBusy,
  DEFAULT_MAX_CONCURRENT_TURNS,
  TURN_RETRY_AFTER_SECONDS,
} from "./http/turn-limiter.js";

export {
  BlobStore,
  blobUrl,
  hashBytes,
  type PutResult,
} from "./data/blob-store.js";

// app-engine reads and writes the conversation-ledger BAND of `vault.db`
// (#280, #916); the vault package composes its shape. `conversations.user_id`
// names a gateway owner, which lives in another file, so it is
// application-enforced.
export {
  openLedgerDb,
  makeLedgerDbProvider,
  type DatabaseProvider,
} from "./stores/gateway-db.js";

export {
  runConversationArchival,
  readArchivedConversationSegment,
  DEFAULT_CONVERSATION_ARCHIVE_WINDOW_DAYS,
  type ConversationArchivalDeps,
  type ConversationArchivalOptions,
  type ConversationArchivalResult,
  type ArchivedRange,
  type ArchivedConversationSegment,
  type BlobSink,
  type CustodyProven,
} from "./conversation/archive/index.js";

export type {
  VaultWorkspace,
  WorkspaceProvider,
} from "./stores/vault-workspace.js";

// `run_summary` is a VIEW, with no write-through sink. The type stays at the
// package root so the `insights/` boundary remains one-way (#151).
export type { RunSummary } from "./conversation/run-summary-sink.js";
export {
  compileHydrationPlan,
  hydrationMessagesFromLedger,
  type HydrationMessage,
  type HydrationOptions,
  type HydrationPlan,
} from "./conversation/hydration.js";
export {
  HarnessHealthStore,
  HARNESS_HEALTH_POLICIES,
  type HarnessHealthController,
  type HarnessHealthEntry,
  type HarnessHealthPolicy,
  type HarnessHealthStatus,
} from "./conversation/harness-health.js";
export {
  ProviderEgressConsentStore,
  type ProviderEgressConsentController,
  type ProviderConsentSource,
} from "./conversation/provider-egress-consent.js";

// A JSON file, not a DB (#280); the wire prefix stays `/_centraid-user`.
export {
  PrefsStore,
  makeUserStoreRouteHandler,
  resolveSubsystemConfigPins,
  resolveSubsystemModel,
  resolveSubsystemHarness,
  resolveSubsystemHarnessLadder,
  type ModelSubsystem,
} from "./stores/prefs-store.js";

export {
  readAppSettings,
  readAppSetting,
  writeAppSetting,
  deleteAppSetting,
  automationEnabledKey,
  APP_SETTINGS_FILE,
  RUNTIME_KEY_PREFIX,
} from "./settings/app-settings.js";
export {
  buildSettingsInject,
  KNOWN_KEYS,
  type SettingsInject,
} from "./settings/settings-merge.js";

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
} from "./conversation/store.js";
export {
  AutomationTriggerStore,
  type AutomationTriggerCursor,
  type PutAutomationTriggerCursor,
  type TriggerIngressRecord,
  type AppendTriggerIngress,
  type TriggerIngressBounds,
  type TriggerIngressGap,
  type PruneIngressResult,
} from "./conversation/trigger-store.js";
export type { AutomationTurnStreamEvent } from "./conversation/automation-turn-stream-event.js";
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
} from "./conversation/schema.js";

// Prefer harness-reported USD, else the catalog. Unknown → NULL (#514).
export {
  priceForModel,
  costForUsage,
  resolveItemCost,
  setPricingCatalog,
  filterLiteLLM,
  type ModelPrice,
  type TokenUsage,
  type CostSource,
  type ResolvedItemCost,
  type PricingCatalog,
  type PricingEntry,
} from "./model-pricing.js";

export {
  repriceLedger,
  type RepriceResult,
  type RepriceOptions,
} from "./conversation/reprice.js";

// A ONE-WAY boundary: `insights/` consumes a journal `DatabaseProvider` and
// the `run_summary` view; the rest of app-engine never imports back into it.
export * from "./insights/index.js";
