/**
 * `@centraid/automation-engine` — the backend-agnostic automation engine.
 *
 * Built around the **automation fire spine** (`runAutomationFire` + the
 * `OpenAutomationDispatch` seam) — a script-driven fan-out of many model turns
 * over the shared run ledger, run from a worker-thread `handler.js`. (Its
 * single-turn sibling, the chat-runner core `makeConversationRunnerCore`,
 * lives in `@centraid/app-engine` next to the `ConversationRunner` interface.)
 *
 * Plus the automation domain that surrounds the fire spine: the manifest
 * format, the on-disk automation-app model, the `<appId>/<id>` handle, webhook
 * ingress, the `AutomationHost` interface + in-process scheduler, the
 * mock-LLM server + persistent session, and the scaffolders.
 *
 * Backend-agnostic by construction: the model turn (`runTurn`), execution
 * (`openDispatch`), and scheduling (`fire`) are injected callbacks, so this
 * package depends on `@centraid/app-engine` (the per-app engine, the shared
 * agent-run ledger, and the turn-driver contract) but never on any agent
 * backend. `agent-runtime` provides the local codex/claude backend;
 * `openclaw-plugin` the cloud host; `gateway` wires them.
 */

// Manifest — the source of truth for an automation app, shared between
// producers (scaffolding / re-prompt) and consumers (the local automation
// runner in `@centraid/agent-runtime`, the openclaw plugin's
// reconciliation pass, and the desktop UI). See issue #91.
export {
  AutomationManifestError,
  AUTOMATION_HANDLER_FILE,
  AUTOMATION_MANIFEST_FILE,
  isValidCronExpression,
  isPendingWebhookTrigger,
  parseManifest,
  validateManifest,
  validateOutputAgainstSchema,
  cronTriggersOf,
  webhookTriggerOf,
  pendingWebhookTriggerOf,
  type AutomationManifest,
  type AutomationManifestRequires,
  type AutomationCostEstimate,
  type AutomationGeneratedMeta,
  type AutomationManifestValidationCode,
  type AutomationTrigger,
  type CronTrigger,
  type WebhookTrigger,
  type PendingWebhookTrigger,
  type AutomationOutputSchema,
  type AutomationHistoryConfig,
  type AutomationHistoryKeep,
} from './manifest.js';

// Automation identity — the directory-slug grammar and the
// `<appId>/<id>` handle that scheduler labels, webhook routing,
// and `onFailure` address an automation by (issue #98).
export {
  isValidAutomationId,
  isValidAutomationRef,
  formatAutomationRef,
  parseAutomationRef,
  type AutomationRef,
} from './ref.js';

// Automation apps on disk (issue #98 unified model). An automation
// always lives inside an app folder at `<appCodeDir>/automations/<id>/`;
// `listAutomations` scans every app's active version. The directory is
// the source of truth (no SQLite definition table).
export {
  APP_AUTOMATIONS_SUBDIR,
  automationManifestPath,
  automationHandlerPath,
  readAutomationAppAt,
  readAppOwnedAutomation,
  listAutomations,
  writeAutomationManifestAt,
  setAutomationEnabledAt,
  deleteAutomationAt,
  type AutomationRow,
  type AutomationAppError,
  type ListAutomationAppsResult,
} from './app.js';

// The host interface every "thing that fires automations on a schedule"
// implements — the local in-process scheduler (gateway) and the cloud
// openclaw cron host both satisfy it.
export type { AutomationHost, AutomationReconcileResult } from './host.js';

// In-process cron scheduler (issue #149, n8n semantics): the gateway-owned
// always-on minute timer that fires enabled cron automations while it runs.
// No OS scheduler; missed minutes during downtime are skipped (no backfill).
export {
  InProcessScheduler,
  type InProcessSchedulerOptions,
  type LocalScheduler,
} from './in-process-scheduler.js';
export { cronMatches } from './cron-match.js';

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
  provisionPendingWebhookAt,
  provisionAppPendingWebhooks,
  provisionPendingWebhooksInFiles,
  type ProvisionedWebhook,
  type ProvisionedWebhookInFiles,
  type WebhookFileMapEntry,
  type WebhookFireFn,
  type WebhookFireResult,
  type WebhookRouteOptions,
} from './webhook.js';

// Automation handler runtime (issue #91). A fire executes the app's
// generated `handler.js` in a worker thread; the host supplies the
// tool / agent dispatchers. `runAutomationHandler` owns the ledger
// side — opening the `runs` row and recording the trace.
export {
  runAutomationHandler,
  type RunAutomationHandlerOptions,
  type AutomationHandlerOutcome,
  type AutomationToolCall,
  type AutomationToolResult,
  type AutomationToolDispatcher,
  type AutomationAgentCall,
  type AutomationAgentDispatcher,
  type AutomationDispatchContext,
} from './handler-runner.js';
export { truncateForAudit } from './handler-audit.js';
// Shared `ctx.agent` answer coercion — every host ends an agent turn with a
// blob of text and must turn it into the value the handler awaits the same way.
export { coerceAgentAnswer } from './agent-answer.js';
// Mock-LLM server + host-agnostic persistent session (issue #166): the
// token-free `ctx.tool` rail. One long-lived agent session per fire, puppeted
// by the mock, executes every tool batch; the per-host `driveAgent` is the
// only thing that varies (CLI subprocess vs. embedded agent).
export {
  startMockLlmServer,
  type MockLlmServerHandle,
  type MockLlmServerOptions,
  type StagedTurn,
  type CapturedToolResult,
} from './mock-llm-server.js';
export {
  startPersistentMockSession,
  type AgentDriver,
  type AgentDriveInput,
  type AgentDriveResult,
  type PersistentMockSession,
  type PersistentMockSessionOptions,
} from './persistent-mock-session.js';
// Authoring-time handler lint (issue #167): a static scan that flags ambient
// I/O and nondeterminism (`Date.now`, `Math.random`, raw `fetch`/`fs`, …) in a
// handler — effects that bypass the audited `ctx.*` rails or make a re-run
// diverge. The builder grounds on this so a handler is rejected at publish
// time, not at fire time.
export {
  lintAutomationHandlerSource,
  formatHandlerLintError,
  type HandlerLintFinding,
} from './handler-lint.js';
// The per-fire orchestration spine (issue #147, Concern 2): resolve the
// automation, open its ledger, run the handler against a host-injected
// dispatch surface, cascade `onFailure`. agent-runtime's `runAutomationLocal`
// is a thin wrapper that injects a mock-LLM + CLI-spawn dispatch surface.
export {
  runAutomationFire,
  type RunAutomationFireOptions,
  type AutomationRunRecord,
  type AutomationDispatchSurface,
  type OpenAutomationDispatch,
  type OpenAutomationDispatchArgs,
} from './fire.js';

// Automation-app scaffolders. The gateway lifecycle routes use the
// file-map (`*Files`) variants; the disk wrappers back the CLI / local
// paths. (Core app scaffolders stay in `@centraid/app-engine`.)
export {
  scaffoldAutomationApp,
  scaffoldAutomationAppFiles,
  setAutomationEnabledInFiles,
  deleteAutomationFromFiles,
  validateAutomationId,
  validateAutomationAppId,
  type AutomationScaffoldOptions,
} from './scaffold.js';
