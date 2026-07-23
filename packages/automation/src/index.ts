/**
 * `@centraid/automation` — the backend-agnostic automation engine.
 *
 * Built around the **automation fire spine** (`runFire` + the
 * `OpenDispatch` seam) — a script-driven fan-out of many model turns
 * over the shared run ledger, run from a worker-thread `handler.js`. (Its
 * single-turn sibling, the chat-runner core `makeConversationRunnerCore`,
 * lives in `@centraid/app-engine` next to the `ConversationRunner` interface.)
 *
 * Plus the automation domain that surrounds the fire spine: the manifest
 * format, the on-disk automation-app model, the `<appId>/<id>` handle, webhook
 * ingress, the `Host` interface + in-process scheduler, the
 * mock-LLM server + persistent session, and the scaffolders.
 *
 * Backend-agnostic by construction: the model turn (`runTurn`), execution
 * (`openDispatch`), and scheduling (`fire`) are injected callbacks, so this
 * package depends on `@centraid/app-engine` (the per-app engine, the shared
 * agent-run ledger, and the turn-driver contract) but never on any agent
 * backend. `agent-runtime` provides the local codex/claude backend;
 * `gateway` wires it.
 */

// Manifest — the source of truth for an automation app, shared between
// producers (scaffolding / re-prompt) and consumers (the local automation
// runner in `@centraid/agent-runtime`, the gateway's reconciliation pass,
// and the desktop UI). See issue #91.
export {
  ManifestError,
  HANDLER_FILE,
  MANIFEST_FILE,
  parseManifest,
  validateManifest,
  webhookTriggerOf,
  type Manifest,
  type ManifestRequires,
  type ManifestVault,
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
  type OutputSchema,
  type HistoryConfig,
  type HistoryKeep,
} from './manifest/manifest.js';

// Condition-trigger evaluation — the host runs one consented read per gate
// tick and fires on unseen rows (duaility: time semantics live in the data).
export {
  evaluateConditionTrigger,
  evaluateDataTrigger,
  type ConditionEvaluation,
  type EvaluateConditionOptions,
  type DataEvaluation,
  type EvaluateDataOptions,
} from './fire/condition.js';

// Automation identity — the `<appId>/<id>` handle that scheduler labels,
// webhook routing, and `onFailure` address an automation by (issue #98).
export { parseRef, type Ref } from './manifest/ref.js';

// Automation apps on disk (issue #98 unified model). An automation
// always lives inside an app folder at `<appCodeDir>/automations/<id>/`;
// `list` scans every app's active version. The directory is
// the source of truth (no SQLite definition table).
export {
  manifestPath,
  readAppOwned,
  list,
  type Row,
  type AppError,
  type ListAppsResult,
} from './scaffold/app.js';

// The host interface every "thing that fires automations on a schedule"
// implements — the local in-process scheduler (gateway) satisfies it.
export type { Host, ReconcileResult } from './fire/host.js';

// In-process cron scheduler (issue #149, n8n semantics): the gateway-owned
// always-on minute timer that fires enabled cron automations while it runs.
// No OS scheduler; missed minutes during downtime are skipped (no backfill).
export {
  InProcessScheduler,
  type InProcessSchedulerOptions,
  type LocalScheduler,
} from './fire/in-process-scheduler.js';

// Missed-automation-run ledger (issue #351 tier 2): the honest record a
// downtime leaves behind now that the scheduler's "no backfill" silence is
// legible instead of invisible. `InProcessScheduler`'s `onTick` hook is the
// host's seam into this; the gateway wires `recordSchedulerTick` there and
// exposes `SchedulerLedgerStore`/`parseSchedulerLedgerSnapshot` to its
// health probes (scheduler liveness, missed-window counts).
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
} from './fire/scheduler-ledger.js';

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
  provisionAppPendingWebhooks,
  provisionPendingWebhooksInFiles,
  rotateWebhookInFiles,
  type ProvisionedWebhook,
  type ProvisionedWebhookInFiles,
  type RotatedWebhookInFiles,
  type WebhookFileMapEntry,
  type WebhookFireFn,
  type WebhookFireResult,
  type WebhookRouteOptions,
} from './scaffold/webhook.js';

// Automation handler runtime (issue #91). A fire executes the app's
// generated `handler.js` in a worker thread; the host supplies the
// tool / agent dispatchers. `runHandler` owns the ledger
// side — opening the `runs` row and recording the trace.
export {
  runHandler,
  type RunHandlerOptions,
  type HandlerOutcome,
  type AgentCall,
  type AgentDispatcher,
  type DispatchContext,
  type ConnectionAuth,
} from './handler/runner.js';
// Shared `ctx.agent` answer coercion — every host ends an agent turn with a
// blob of text and must turn it into the value the handler awaits the same way.
export { coerceAgentAnswer } from './handler/agent-answer.js';
// Authoring-time handler lint (issue #167): a static scan that flags ambient
// I/O and nondeterminism (`Date.now`, `Math.random`, raw `fetch`/`fs`, …) in a
// handler — effects that bypass the audited `ctx.*` rails or make a re-run
// diverge. The builder grounds on this so a handler is rejected at publish
// time, not at fire time.
export {
  lintHandlerSource,
  formatHandlerLintError,
  type HandlerLintFinding,
} from './handler/lint.js';
// The per-fire orchestration spine (issue #147, Concern 2): resolve the
// automation, open its ledger, run the handler against a host-injected
// dispatch surface, cascade `onFailure`. agent-runtime's `runAutomation`
// is a thin wrapper that injects a mock-LLM + host-agent dispatch surface.
export {
  runFire,
  type RunFireOptions,
  type RunRecord,
  type DispatchSurface,
  type OpenDispatch,
  type OpenDispatchArgs,
  type ResolveConnection,
} from './fire/fire.js';

// Automation-app scaffolders. The gateway lifecycle routes use the
// file-map (`*Files`) variants; the disk wrappers back the CLI / local
// paths. (Core app scaffolders stay in `@centraid/app-engine`.)
export {
  scaffoldApp,
  scaffoldAppFiles,
  setEnabledInFiles,
  deleteFromFiles,
  validateAppId,
  type ScaffoldOptions,
} from './scaffold/scaffold.js';
