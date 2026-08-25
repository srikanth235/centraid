// The backend-agnostic automation engine: the fire spine (`runFire` + the
// `OpenDispatch` seam) and the domain around it. `runTurn`, `openDispatch` and
// `fire` are injected, so this package never depends on a harness.

export {
  ManifestError,
  HANDLER_FILE,
  MANIFEST_FILE,
  parseManifest,
  validateManifest,
  webhookTriggerOf,
  isDeniedTriggerCursorEntity,
  isValidIanaTimeZone,
  isValidCronExpression,
  EVENT_DEFAULT_EVERY,
  EVENT_TRIGGER_CATALOG,
  type Manifest,
  type ManifestEnrich,
  type ManifestRequires,
  type ManifestVault,
  type ManifestVaultFilterClause,
  type ManifestVaultScope,
  type ConnectorSpec,
  type ConnectionBinding,
  type ManifestValidationCode,
  type Trigger,
  type CronTrigger,
  type WebhookTrigger,
  type PendingWebhookTrigger,
  type ConditionTrigger,
  type ConditionWhereClause,
  type ConditionOp,
  type DataTrigger,
  type EventTrigger,
  type OutputSchema,
  type HistoryConfig,
  type HistoryKeep,
} from "./manifest/manifest.js";

export {
  CRON_DEFAULT_TIMEZONE_PREF,
  resolveCronTimezone,
  wallClockFields,
  wallClockMinuteKey,
  type WallClockFields,
} from "./cron-timezone.js";
export { cronMatches } from "./fire/cron-match.js";

// The only trigger evaluators: no caller advances a watermark past rows it
// never delivered.
export {
  readConditionCursor,
  readDataCursor,
  type ReadConditionCursorOptions,
  type ReadDataCursorOptions,
} from "./fire/condition.js";

export { parseRef, type Ref } from "./manifest/ref.js";

// The automation directory is the source of truth, not a table (#98).
export {
  manifestPath,
  readAppOwned,
  list,
  type Row,
  type AppError,
  type ListAppsResult,
} from "./scaffold/app.js";

export type { Host, ReconcileResult } from "./fire/host.js";

// Minute timer: missed minutes during downtime are never backfilled (#149).
export {
  InProcessScheduler,
  type InProcessSchedulerOptions,
  type LocalScheduler,
} from "./fire/in-process-scheduler.js";
export {
  VaultCursorEngine,
  isDeniedCursorEntity,
  assertTriggerCursorAllowed,
  eventSourceKey,
  DEFAULT_TRIGGER_CATCH_UP_CAP,
  type VaultCursorEngineOptions,
  type TriggerCursorReadInput,
  type TriggerCursorFireInput,
  type CursorReadResult,
  type CursorElement,
  type CursorStore,
} from "./fire/cursor-engine.js";
export { dueInstants, type CronSchedule } from "./fire/cron-cursor.js";

// The ledger that makes that silence legible (#351).
export {
  SCHEDULER_LEDGER_AUTOMATION_ID,
  SCHEDULER_LEDGER_KEY,
  SchedulerLedgerStore,
  parseSchedulerLedgerSnapshot,
  computeMissedWindows,
  recordSchedulerTick,
  type MissedWindowEntry,
  type SchedulerLedgerSnapshot,
  type ComputeMissedWindowsOptions,
  type RecordSchedulerTickOptions,
} from "./fire/scheduler-ledger.js";

export {
  WEBHOOK_ROUTE_PREFIX,
  generateWebhookId,
  generateWebhookSecret,
  hashWebhookSecret,
  verifyWebhookSecret,
  makeWebhookRouteHandler,
  provisionAppPendingWebhooks,
  provisionPendingWebhooksInFiles,
  rotateWebhookInFiles,
  type ProvisionedWebhook,
  type ProvisionedWebhookInFiles,
  type RotatedWebhookInFiles,
  type WebhookFileMapEntry,
  type WebhookIngressFn,
  type WebhookIngressResult,
  type WebhookRouteOptions,
} from "./scaffold/webhook.js";

export {
  runHandler,
  type RunHandlerOptions,
  type HandlerOutcome,
  type DelegateCall,
  type DelegateDispatcher,
  type DispatchContext,
  type ConnectionAuth,
} from "./handler/runner.js";
export { coerceDelegateAnswer } from "./handler/delegate-answer.js";
// Authoring-time handler lint (#167): rejected at publish time, not fire time.
export {
  lintHandlerSource,
  formatHandlerLintError,
  type HandlerLintFinding,
} from "./handler/lint.js";
export {
  runFire,
  type RunFireOptions,
  type RunRecord,
  type DispatchSurface,
  type OpenDispatch,
  type OpenDispatchArgs,
  type ResolveConnection,
} from "./fire/fire.js";
// The enrichment tier gate, pure and exported so a host can explain a refusal.
export {
  DEFAULT_ENRICH_TRIGGER,
  ENRICH_DOMAINS,
  ENRICH_LANES,
  ENRICH_TIERS,
  automationScopeChain,
  decideEnrichmentGate,
  egressWithinCeiling,
  resolveEnrichmentPolicy,
  sealedModelTurnReason,
  tierEgressCeiling,
  type EnrichDomain,
  type EnrichEgressCeiling,
  type EnrichGateDecision,
  type EnrichGateInput,
  type EnrichLane,
  type EnrichPolicyRequest,
  type EnrichPolicyResolution,
  type EnrichTier,
  type ResolveEnrichPolicy,
  type ResolvedEnrichPolicy,
} from "./fire/enrich-gate.js";

export {
  scaffoldApp,
  scaffoldAppFiles,
  setEnabledInFiles,
  deleteFromFiles,
  validateAppId,
  type ScaffoldOptions,
} from "./scaffold/scaffold.js";
