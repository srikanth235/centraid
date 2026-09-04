// governance: allow-repo-hygiene file-size-limit orchestration hub already at the cap; pending split of the route-handler wiring into a sibling module
/*
 * `buildGateway()` — the host-agnostic gateway core (#280, #289).
 *
 * Every personal surface resolves through the vault the CURRENT REQUEST is
 * addressed to, because `composedHandler` runs the whole chain inside that
 * ambient scope. There is NO server-global active vault: switching is a
 * client-side view change, and N clients ride N vaults concurrently.
 *
 * The per-vault host bundle is built lazily and cached by vault id.
 * `start()` mounts every vault's workspace and starts each vault's scheduler,
 * so automations fire in every vault regardless of what a client looks at.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

import {
  bundledAppDir,
  listBundledAppTemplates,
  listTemplates,
  readTemplateFiles,
} from "@centraid/blueprints";
import { ROUTES } from "@centraid/core/protocol";
import {
  runAutomation,
  runPreflight,
  runTurn,
  CatalogWarmer,
  deriveStatus,
  readHarnessModels,
  enumerateHarnessModels,
  probeCliAvailability,
  resolveAcpCapabilities,
} from "@centraid/server/acp";
import type {
  CatalogSurface,
  HarnessKind,
  HarnessPrefs,
  SurfaceStatus,
} from "@centraid/server/acp";
import * as automation from "@centraid/server/automation";
import type {
  AskModelInfo,
  AutomationTriggerKind,
  AutomationTriggerOrigin,
  ConversationRunner,
  ConversationStore,
  ModelSubsystem,
  RunTurnFn,
  HarnessHealthController,
  RuntimeLogger,
  ToolResult,
  VaultWorkspace,
} from "@centraid/server/engine";
import {
  AnalyticsStore,
  ASSISTANT_APP_ID,
  AUTHED_DEVICE_HEADER,
  AUTHED_PLANE_HEADER,
  COMPANION_GRANTS_HEADER,
  ConversationHistoryStore,
  AutomationTriggerStore,
  Dispatcher,
  InsightsStore,
  PrefsStore,
  ProviderEgressConsentStore,
  HarnessHealthStore,
  HARNESS_KINDS,
  Runtime,
  changesSubscriberCount,
  cleanupDeregisteredApp,
  classifyCaptureWithHarness,
  deriveTitle,
  generateConversationTitle,
  makeConversationRouteHandler,
  makeConversationRunnerCore,
  makeLedgerDbProvider,
  makeUserStoreRouteHandler,
  resolveSubsystemModel,
  resolveSubsystemHarnessLadder,
  validateTurnAttachmentRefs,
  TurnLimiter,
  workerAdmissionStats,
} from "@centraid/server/engine";
import {
  createTokenBucket,
  PEER_ENDPOINT_HEADER,
  PEER_PLANE_BUDGET,
  PEER_PROOF_HEADER,
  PEER_VAULT_HEADER,
} from "@centraid/tunnel";
import {
  KeyStore,
  recompileCommonsGrants,
  readBlobStoreSettings,
  readEnrichPolicyResolutionInput,
  custodyStateCounts,
  jitterDelayMs,
  DEFAULT_VAULT_FOOTPRINT,
} from "@centraid/vault";
import type {
  FilterClause,
  InvokeOutcome,
  PreviewCodec,
} from "@centraid/vault";

import type { BackupConfig } from "../backup/backup-config.js";
import { BackupService } from "../backup/backup-service.js";
import { deriveBackupSourceInstanceId } from "../backup/backup-state.js";
import { RecoveryKitStateStore } from "../backup/recovery-kit-state.js";
import { openStorageConnectionStore } from "../backup/storage-connections.js";
import { makeStorageCredentialsResolver } from "../backup/storage-credentials.js";
import { StorageUsagePoller } from "../backup/storage-usage.js";
import { makeCaptureOcrRecognizer } from "../capture/capture-ocr.js";
import { readEnrichConsentForChain } from "../enrich/egress-consent-lookup.js";
import {
  readEngineProfile,
  validateEngineProfilePatch,
} from "../enrich/engine-profiles.js";
import {
  isSystemRecognitionRef,
  SYSTEM_RECOGNITION_TEMPLATE_IDS,
} from "../enrich/system-recognition.js";
import {
  closeLedgerConversationStores,
  ledgerConversationStore,
} from "../ledger-stores.js";
import { unrefTimer } from "../lib/unref-timer.js";
import {
  resolveAutomationAnchors,
  scopesForAutomationAnchors,
} from "../lifecycle/automation-anchor-scopes.js";
import {
  resolveAutomationHarnessSelection,
  resolveAutomationRewriteModel,
} from "../lifecycle/automation-harness-selection.js";
import type { AutomationHarnessSelection } from "../lifecycle/automation-harness-selection.js";
import { reviseAutomationInstructions } from "../lifecycle/automation-revision.js";
import { makeDraftCodeDirResolver } from "../lifecycle/ext-band.js";
import type { ExtBandOps } from "../lifecycle/ext-band.js";
import {
  finalizeCompiledManifest,
  recordFailedAutomationCompile,
  runHeadlessAutomationCompile,
} from "../lifecycle/headless-automation-compile.js";
import { runInteractiveAutomationTurn } from "../lifecycle/interactive-automation-turn.js";
import {
  ensureSession,
  prepareLifecycleSession,
  publishAndReconcile,
  stageAndMaybePublish,
} from "../lifecycle/lifecycle-shared.js";
import type { LifecycleRouteOptions } from "../lifecycle/lifecycle-shared.js";
import { rewriteAutomationInstructions } from "../lifecycle/rewrite-automation-instructions.js";
import type { GatewayPaths } from "../paths.js";
import { createImagePreviewCodec } from "../preview/codec.js";
import { makeAppsStoreRouteHandler } from "../routes/apps-store-routes.js";
import { makeAssistantRouteHandler } from "../routes/assistant-routes.js";
import {
  makeAutomationsRouteHandler,
  turnEventsSubscriberCount,
} from "../routes/automations-routes.js";
import { makeBackupRouteHandler } from "../routes/backup-routes.js";
import { makeBlobRouteHandler } from "../routes/blob-routes.js";
import { makeCaptureRouteHandler } from "../routes/capture-routes.js";
import {
  COMMONS_RECOVERY_PATH,
  makeCommonsRecoveryRouteHandler,
} from "../routes/commons-recovery-routes.js";
import {
  COMMONS_PATH,
  makeCommonsRouteHandler,
} from "../routes/commons-routes.js";
import { makeConnectionsRouteHandler } from "../routes/connections-routes.js";
import { makeDataPlaneControlHandler } from "../routes/data-plane-control.js";
import type { DataPlaneControlOptions } from "../routes/data-plane-control.js";
import { makeDemoRouteHandler } from "../routes/demo-routes.js";
import { makeDeviceWorkRouteHandler } from "../routes/device-work-routes.js";
import { makeDevicesRouteHandler } from "../routes/devices-routes.js";
import { makeDiagnosticsRouteHandler } from "../routes/diagnostics-routes.js";
import { EDGES_PATH, makeEdgesRouteHandler } from "../routes/edges-routes.js";
import {
  ENRICH_PROFILES_PREFIX,
  makeEnrichProfilesRouteHandler,
} from "../routes/enrich-profiles-routes.js";
import {
  SEMANTIC_SEARCH_PATH,
  makeEnrichSearchRouteHandler,
} from "../routes/enrich-search-routes.js";
import { makeGatewayInfoRouteHandler } from "../routes/gateway-info-routes.js";
import { GRANTS_PATH, makeGrantRouteHandler } from "../routes/grant-routes.js";
import { makeHarnessesRouteHandler } from "../routes/harnesses-routes.js";
import type { HarnessAcpCapabilities } from "../routes/harnesses-routes.js";
import { makeHealthRouteHandler } from "../routes/health-routes.js";
import { makeImportRouteHandler } from "../routes/import-routes.js";
import { makeLifecycleRouteHandler } from "../routes/lifecycle-routes.js";
import {
  logsEventsSubscriberCount,
  makeLogsRouteHandler,
} from "../routes/logs-routes.js";
import {
  makeMultiplexReplicaRouteHandler,
  MULTIPLEX_REPLICA_CHANGES_PATH,
} from "../routes/multiplex-replica-routes.js";
import { makeOwnersRouteHandler } from "../routes/owners-routes.js";
import { makePeerPlaneHandler } from "../routes/peer-plane.js";
import {
  makePushRegistrationRouteHandler,
  PUSH_REGISTRATIONS_PATH,
  PushWakeRelay,
} from "../routes/push-wake-routes.js";
import { makeRemindersRouteHandler } from "../routes/reminders-routes.js";
import type { ReplicaIntentDispatchOutcome } from "../routes/replica-intent-route.js";
import { makeReplicaRouteHandler } from "../routes/replica-routes.js";
import { makeResourceRouteHandler } from "../routes/resource-routes.js";
import {
  isDirectHostRequest,
  isLoopbackRequest,
  readFileMap,
  sendJson,
} from "../routes/route-helpers.js";
import {
  assertRouteSecurityCoverage,
  ROUTE_SECURITY_REGISTRY,
} from "../routes/route-security.js";
import {
  makeScopesRouteHandler,
  SCOPES_PATH,
} from "../routes/scopes-routes.js";
import { makeStorageRouteHandler } from "../routes/storage-routes.js";
import { makeTemplatesRouteHandler } from "../routes/templates-routes.js";
import { makeVaultLinksRouteHandler } from "../routes/vault-links-routes.js";
import { makeVaultRouteHandler } from "../routes/vault-routes.js";
import {
  assistantCwd,
  makeAssistantConversationRunner,
  makeVaultToolRunners,
} from "../runs/assistant-conversation-runner.js";
import { buildAssistantPrompt } from "../runs/assistant-prompt.js";
import { RunEventBus } from "../runs/run-event-bus.js";
import { makeUnifiedConversationRunner } from "../runs/unified-conversation-runner.js";
import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_VERSION,
} from "../version.js";
import { WorktreeStore } from "../worktree-store/index.js";
import { readAnomalyLedger } from "./anomaly-ledger.js";
import type { AssistOAuthConfig } from "./assist-oauth.js";
import { pollProviderEventSource } from "./automation-event-sources.js";
import { createBlobSweepHealthProbe } from "./blob-sweep-health.js";
import { createBrokerHealthProbe } from "./broker-health.js";
import { commonsObservabilitySection } from "./commons-observability.js";
import { companionRequestAllowed } from "./companion-access.js";
import { ConnectionBroker } from "./connection-broker.js";
import type { DataPlaneHttpOptions } from "./data-plane-handoff.js";
import { defaultLogger } from "./default-logger.js";
import { createDiskHealthProbe, formatBytes } from "./disk-health.js";
import { createEnrichmentHealthProbe } from "./enrichment-health.js";
import { EnrollmentStore } from "./enrollment-store.js";
import { recoverPendingVaultErases } from "./erase-recovery.js";
import { resolveExperimentalFeatures } from "./experimental-features.js";
import type { ExperimentalFeatureSet } from "./experimental-features.js";
import { GatewayDatabase } from "./gateway-db.js";
import { GatewayLogStore } from "./gateway-log-store.js";
import { GatewayPerformanceMonitor } from "./gateway-performance.js";
import { createGrantRefreshDoorbell } from "./grant-fulfillment.js";
import {
  formatHardwareProfileDetail,
  resolveGatewayHardwareProfile,
  toStructuredResourceProfile,
} from "./hardware-profile.js";
import {
  removedHarnessLadderMembers,
  resolveGatewayHarnessPrefs,
  resolveStrictGatewayHarnessPrefs,
} from "./harness-prefs.js";
import { HealthRegistry } from "./health-registry.js";
import { kitlessHostIdentity } from "./host-identity.js";
import { probeHostLimits } from "./host-limits.js";
import { reconcileLinkBindings } from "./link-party-bindings.js";
import { LocalUsageScanner } from "./local-usage.js";
import {
  enrichRefusalNotice,
  humanizeAutomationRef,
  noticeGist,
  shouldWriteAutomationNotice,
  shouldWriteEnrichRefusalNotice,
} from "./notices.js";
import {
  createNotificationsDecisionWakeTracker,
  notificationsDecisionKeys,
  NotificationsEventBus,
} from "./notifications-events.js";
import { OutboxExecutor } from "./outbox-executor.js";
import type { PairingTicketStore } from "./pairing-store.js";
import {
  claimPeerCommonsInvitation,
  invitePeerToCommons,
  pullPeerCommons,
  refusePeerCommonsInvitation,
} from "./peer-commons-client.js";
import type { PeerDial } from "./peer-link-client.js";
import { createPeerPlaneSweep } from "./peer-plane-sweep.js";
import { announceLocalRoutes } from "./peer-route-announce.js";
import { PowerContextMonitor } from "./power-context.js";
import { PricingWarmer } from "./pricing-warmer.js";
import { ResourceAccounting } from "./resource-accounting.js";
import {
  formatEventLoopDetail,
  formatPowerPostureDeferringDetail,
  formatPowerPostureNormalDetail,
  parseResourceKnobPrefs,
  resolveResourceMode,
  RESOURCE_MODE_PREF_KEY,
} from "./resource-mode.js";
import type { ResourceMode } from "./resource-mode.js";
import { RouteLatencyMetrics } from "./route-latency.js";
import { createSchedulerHealthProbe } from "./scheduler-health.js";
import { findSequentially, forEachSequentially } from "./sequential.js";
import { measureStorageLatency } from "./storage-latency.js";
import { StorageLimitsStore, evaluateStorageLimit } from "./storage-limits.js";
import { createStorageQuotaHealthProbe } from "./storage-quota-health.js";
import { collectSupportBundleInput } from "./support-bundle-source.js";
import { renderSupportBundle } from "./support-bundle.js";
import {
  ingressElement,
  ingressRetentionGap,
  readIngressCursor,
} from "./trigger-ingress-cursor.js";
import { runWithVaultContext, VAULT_HEADER } from "./vault-context.js";
import type { DeviceAccess } from "./vault-context.js";
import { createVaultIntegrityHealthProbe } from "./vault-integrity-health.js";
import { VaultLinksStore } from "./vault-links-store.js";
import type { InstallScopeBlock, VaultPlane } from "./vault-plane.js";
import { openVaultRegistry } from "./vault-registry.js";
import type { VaultRegistry } from "./vault-registry.js";
import { WebControlSessions } from "./web-control-sessions.js";
import { WebControlSessionStore } from "./web-session-store.js";

export type { DeviceAccess } from "./vault-context.js";

const TIME_ENGINE_MODULE_URL = import.meta.resolve("@centraid/core/time");

export interface BuildGatewayOptions {
  paths: GatewayPaths;
  gatewayDatabase?: GatewayDatabase;
  assistOAuth?: AssistOAuthConfig;
  resourceMode?: ResourceMode;
  /**
   * When a feature is off the gateway does not advertise its capability,
   * mount its routes, or start its background work — durable data stays
   * intact. Resolution: `CENTRAID_EXPERIMENTAL` > durable prefs > this > off.
   */
  experimental?: Partial<ExperimentalFeatureSet>;
  /**
   * One in-process cron scheduler PER VAULT (#149, #289), each a
   * minute-boundary timer firing through the same `runAutomation` path as
   * "run now". No OS scheduler, and missed minutes are skipped — no backfill.
   * An injected override becomes the DEFAULT vault's scheduler only.
   */
  scheduler?: automation.LocalScheduler;
  logger?: RuntimeLogger;
  logTag?: string;
  /** Defaults to `chat-<appId>`; a host sharing the draft with another editor
   *  injects its own scheme so both edit ONE worktree. */
  sessionIdFor?: (appId: string) => string;
  /** A loopback embed omitting this seam gets a persisted host enrollment
   *  keyed by the gateway endpoint id (#289). */
  deviceAccess?: DeviceAccess;
  keyStore?: KeyStore;
  hostDeviceEndpointId?: string;
  /**
   * An authenticated caller on this box that is NOT iroh-forwarded (whose
   * upstream socket is loopback too). Gates the host-only lanes:
   * pairing-ticket mint, owner administration, cross-vault scopes listing.
   */
  isHostCustody?: (req: IncomingMessage) => boolean;
  dataPlaneHttp?: DataPlaneHttpOptions;
  dataPlaneControl?: DataPlaneControlOptions;
  previewCodec?: PreviewCodec;
  devicePairing?: {
    enrollments: EnrollmentStore;
    tickets: PairingTicketStore;
    endpointTicket?: () => string | undefined;
    endpointId?: () => string | undefined;
    onEndpointRevoked?: (endpointId: string) => void | Promise<void>;
  };
  /**
   * The gateway↔gateway peer lane (#726). Absent means this build serves no
   * peer plane and every peer-marked request is `not_found`. `proof` is the
   * per-boot secret ONLY the forwarder and the peer route layer know —
   * nothing else in this file may read it.
   */
  peerPlane?: {
    proof: string;
    localRoute: () => { endpointId?: string; relayHints: string[] };
    /** Absent ⇒ this build can receive peer requests but never initiate one;
     *  a remote edge or D9 accept parks instead of dialing (#726). */
    dial?: PeerDial;
    blobPullIntervalMs?: number;
  };
  /**
   * When `controlsFile` is set, CONTROL cookies persist there so a web pairing
   * survives a restart and the sliding 30-day idle window (#376).
   * `isDeviceValid` propagates `devices revoke` to live cookies at once.
   * Absent → in-memory control sessions with no revocation hook.
   */
  webSessions?: {
    controlStore?: WebControlSessionStore;
    controlsFile?: string;
    isDeviceValid?: (deviceKey: string) => boolean;
  };
  /** A stub lets HTTP lifecycle paths finish without spawning a harness, so
   *  check:pr stays green on harnessless hosts (#504). */
  runTurn?: RunTurnFn;
  backup?: BackupConfig;
  /**
   * Coalescing window for the Notifications doorbell (#647): otherwise every
   * journalled commit recomputes the whole projection and rings SSE to every
   * subscriber. First commit after idle fires promptly; the burst collapses
   * into one trailing recomputation. Tests shorten it, hosts leave it alone.
   */
  notificationsDoorbellWindowMs?: number;
}

export type FireAutomation = (
  automationRef: string,
  opts: {
    runId?: string;
    triggerKind: AutomationTriggerKind;
    triggerOrigin: AutomationTriggerOrigin;
    input?: unknown;
    note?: string;
    /** Reuse a source-stable run id and replay an interrupted ledger turn. */
    idempotent?: boolean;
    /** Let the cursor engine retain its pending receipt on infra failure. */
    propagateError?: boolean;
  }
) => Promise<{
  turnId: string;
  outcome?: automation.HandlerOutcome;
  record?: automation.RunRecord;
}>;

export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<boolean>;

export interface RoutePrefixRegistration {
  readonly prefixes: readonly string[];
  readonly handler: RouteHandler;
}

export function forRoutePrefixes(
  prefixes: string | readonly string[],
  handler: RouteHandler
): RoutePrefixRegistration {
  return {
    prefixes: typeof prefixes === "string" ? [prefixes] : prefixes,
    handler,
  };
}

interface RoutePrefixNode {
  readonly children: Map<string, RoutePrefixNode>;
  readonly registrations: RoutePrefixRegistration[];
}

function routeSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

export function createRoutePrefixDispatch(
  registrations: readonly RoutePrefixRegistration[]
): RouteHandler {
  const root: RoutePrefixNode = { children: new Map(), registrations: [] };
  for (const registration of registrations) {
    for (const prefix of registration.prefixes) {
      let node = root;
      for (const segment of routeSegments(prefix)) {
        let child = node.children.get(segment);
        if (!child) {
          child = { children: new Map(), registrations: [] };
          node.children.set(segment, child);
        }
        node = child;
      }
      node.registrations.push(registration);
    }
  }

  return async (req, res) => {
    const raw = req.url ?? "/";
    const query = raw.indexOf("?");
    const pathname = query === -1 ? raw : raw.slice(0, query);
    const matches: RoutePrefixRegistration[][] = [];
    let node: RoutePrefixNode | undefined = root;
    if (node.registrations.length > 0) matches.push(node.registrations);
    for (const segment of routeSegments(pathname)) {
      node = node.children.get(segment);
      if (!node) break;
      if (node.registrations.length > 0) matches.push(node.registrations);
    }

    const invoked = new Set<RoutePrefixRegistration>();
    const matched = await findSequentially(
      matches.toReversed().flat(),
      async (registration) => {
        if (invoked.has(registration)) return false;
        invoked.add(registration);
        return registration.handler(req, res);
      }
    );
    return matched !== undefined;
  };
}

export function replicaDispatchOutcome(
  result: ToolResult
): ReplicaIntentDispatchOutcome {
  if (result.isError) {
    const denied = new Set([
      "UNKNOWN_APP",
      "UNKNOWN_ACTION",
      "WRONG_KIND",
      "INVALID_INPUT",
      "INVALID_MANIFEST",
      "NO_ACTIVE_VERSION",
    ]).has(result.structuredContent.code);
    return denied
      ? { status: "denied", reason: result.structuredContent.message }
      : {
          // HANDLER_ERROR can mean a bridge failure after the command
          // committed, so retry is safe: the route keeps the intent in
          // `sending` and deterministic intent-bound invocation ids dedupe it.
          status: "retryable",
          reason: result.structuredContent.message,
        };
  }
  const value = result.structuredContent;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const outcome = value as {
      status?: unknown;
      invocationId?: unknown;
      reason?: unknown;
      output?: unknown;
    };
    const reason =
      typeof outcome.reason === "string" ? outcome.reason : undefined;
    if (outcome.status === "parked") {
      return {
        status: "parked",
        ...(typeof outcome.invocationId === "string"
          ? { invocationId: outcome.invocationId }
          : {}),
        ...(reason ? { reason } : {}),
      };
    }
    if (outcome.status === "denied" || outcome.status === "failed") {
      return {
        status: outcome.status,
        reason: reason ?? `app action ${outcome.status}`,
        ...(outcome.output === undefined ? {} : { output: outcome.output }),
      };
    }
    if (outcome.status === "executed" || outcome.status === "replayed") {
      return {
        status: "executed",
        ...(outcome.output === undefined ? {} : { output: outcome.output }),
      };
    }
  }
  return {
    status: "executed",
    ...(value === undefined ? {} : { output: value }),
  };
}

const CONVERSATIONS_PREFIX = "/_centraid-conversations";
const USER_STORE_PREFIX = "/_centraid-user";

interface VaultHost {
  vaultId: string;
  store: WorktreeStore;
  codeAppsDir: () => string;
  draftCodeDir: (
    appId: string,
    sessionId: string
  ) => Promise<string | undefined>;
  runner: ConversationRunner;
  ensureSystemRecognitionRecipes: () => Promise<void>;
  handlers: RouteHandler[];
}

export interface BuiltGateway {
  runtime: Runtime;
  health: HealthRegistry;
  backup?: BackupService;
  prefs: PrefsStore;
  analyticsStore: AnalyticsStore;
  conversationHistoryStore: ConversationHistoryStore;
  vaults: VaultRegistry;
  appsStore: () => Promise<WorktreeStore>;
  /** The request vault's live `main` apps dir, rotating atomically per
   *  publish/rollback. Throws before `start()` mounted the workspace. */
  codeAppsDir: () => string;
  syncApps: (vaultId?: string) => Promise<void>;
  webControlSessions: WebControlSessions;
  /**
   * Handlers run after auth, before `runtime.handle`. They resolve the
   * request's vault from the AMBIENT context, so mount them through
   * `composedHandler` unless the host establishes that scope itself.
   */
  extraHandlers: RouteHandler[];
  composedHandler: RouteHandler;
  /**
   * The `/_centraid-hook/<id>` route (#96), mounted AHEAD of the bearer check —
   * the shared secret in the request IS the auth. Returns `false` on a
   * non-matching URL so the host falls through to `composedHandler`.
   */
  webhookHandler: RouteHandler;
  logs: GatewayLogStore;
  start: (publicBaseUrl: string) => Promise<void>;
  stop: () => Promise<void>;
}

export async function buildGateway(
  options: BuildGatewayOptions
): Promise<BuiltGateway> {
  const { paths } = options;
  const dataDir = paths.dataDir ?? path.dirname(paths.vaultDir);
  const gatewayDatabase =
    options.gatewayDatabase ??
    GatewayDatabase.open(dataDir, { lock: "exclusive" });
  const instanceId = crypto.randomUUID();
  const logStore = new GatewayLogStore(
    undefined,
    paths.logsDir ? { dir: paths.logsDir } : {}
  );
  const logger = logStore.wrap(options.logger ?? defaultLogger(options.logTag));

  const health = new HealthRegistry();
  health.registerExpectedPushComponents();
  const performanceMonitor = new GatewayPerformanceMonitor();
  const routeLatency = new RouteLatencyMetrics();
  health.setPerformanceMetricsSource(
    () => ({
      ...performanceMonitor.snapshot(),
      routeLatency: routeLatency.snapshot(),
    }),
    () => {
      performanceMonitor.resetMeasurement();
      routeLatency.reset();
    }
  );
  let storageFsyncMs: number | undefined;
  try {
    const storageLatency = await measureStorageLatency(dataDir);
    storageFsyncMs = storageLatency.fsyncMs;
    performanceMonitor.setStorageFsyncMs(storageLatency.fsyncMs);
    health.reportOk(
      "storage-latency",
      `4 KiB fsync ${storageLatency.fsyncMs.toFixed(1)} ms`
    );
  } catch (error) {
    health.reportDegraded(
      "storage-latency",
      `boot fsync probe failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  health.registerProbe("event-loop", async () => {
    const sample = performanceMonitor.snapshot();
    const detail = formatEventLoopDetail(sample);
    return sample.eventLoopLagP99Ms >= 50
      ? { status: "degraded", detail }
      : { status: "ok", detail };
  });
  const prefsEarly = new PrefsStore({
    read: () =>
      Object.fromEntries(
        gatewayDatabase.prefRows().flatMap((row) => {
          try {
            return [[row.key, JSON.parse(row.value_json) as unknown] as const];
          } catch {
            return [];
          }
        })
      ),
    write: (prefs) => gatewayDatabase.replacePrefs(prefs),
  });
  const earlyPrefs = prefsEarly.getAllPrefs();
  const resourceMode = resolveResourceMode({
    env: process.env,
    optionsMode: options.resourceMode,
    prefsMode: earlyPrefs[RESOURCE_MODE_PREF_KEY],
  });
  const resourceKnobPrefs = parseResourceKnobPrefs(earlyPrefs);
  const experimentalResolution = resolveExperimentalFeatures({
    env: process.env,
    prefs: earlyPrefs,
    ...(options.experimental ? { options: options.experimental } : {}),
  });
  const experimental = experimentalResolution.features;
  for (const token of experimentalResolution.unknownEnvTokens) {
    logger.warn(
      `CENTRAID_EXPERIMENTAL names no known experimental feature: "${token}"`
    );
  }
  const hostLimits = probeHostLimits();
  const hardwareProfile = resolveGatewayHardwareProfile({
    ...(storageFsyncMs === undefined ? {} : { storageFsyncMs }),
    cgroupCpuLimit: hostLimits.cgroupCpuLimit,
    cgroupMemoryLimitBytes: hostLimits.cgroupMemoryLimitBytes,
    stealPercent: hostLimits.stealPercent,
    resourceMode,
    prefsOverrides: resourceKnobPrefs,
  });
  process.env.CENTRAID_RESOLVED_HARDWARE_PROFILE = hardwareProfile.class;
  process.env.CENTRAID_WORKER_MAX_CONCURRENT = String(
    hardwareProfile.workerMaxConcurrent
  );
  process.env.CENTRAID_WORKER_MAX_OLD_GENERATION_MB = String(
    hardwareProfile.workerMaxOldGenerationMb
  );
  // NOT the resolved default (#922 B3): the warm-pool default has one source,
  // `CONSTRAINED_WORKER_POOL_SIZE`/`DEFAULT_WORKER_POOL_SIZE` beside the pool,
  // and boot used to overwrite it with a second number. Only a durable UI
  // override still has to reach the engine this way — an operator env var is
  // already in the environment the pool reads.
  if (hardwareProfile.sources.workerPoolSize.source === "prefs") {
    process.env.CENTRAID_WORKER_POOL_SIZE = String(
      hardwareProfile.workerPoolSize
    );
  }
  process.env.CENTRAID_REPLICATION_CONCURRENCY = String(
    hardwareProfile.replicationConcurrency
  );
  health.reportOk(
    "hardware-profile",
    formatHardwareProfileDetail(hardwareProfile)
  );
  const webControlSessions = new WebControlSessions({
    ...options.webSessions,
    controlStore:
      options.webSessions?.controlStore ??
      WebControlSessionStore.open(gatewayDatabase),
  });

  // Bundled blueprint ids are RESERVED — a code-store app must never shadow
  // one (#434). The set is the release's catalog, fixed for the process life.
  const bundledAppIds = new Set(
    (await listBundledAppTemplates()).map((t) => t.id)
  );
  const recognitionTemplateIds = new Set<string>(
    SYSTEM_RECOGNITION_TEMPLATE_IDS
  );
  const systemRecognitionTemplates = (await listTemplates()).filter(
    (template) =>
      template.kind === "automation" && recognitionTemplateIds.has(template.id)
  );
  if (systemRecognitionTemplates.length !== recognitionTemplateIds.size) {
    const found = new Set(
      systemRecognitionTemplates.map((template) => template.id)
    );
    const missing = [...recognitionTemplateIds].filter((id) => !found.has(id));
    throw new Error(
      `bundled recognition catalog is incomplete: missing ${missing.join(", ")}`
    );
  }
  const isBundledAppId = (id: string): boolean =>
    bundledAppIds.has(id) || recognitionTemplateIds.has(id);

  health.reportOk("instance", "gateway.db exclusive process lock held");
  if (gatewayDatabase.networkFileSystem) {
    const message =
      "gateway data directory is on a network filesystem; cross-host locking is not guaranteed and orphan blob deletion is disabled";
    logger.warn(message);
    health.reportDegraded("filesystem", message);
  } else {
    health.reportOk("filesystem", "local filesystem");
  }

  const gatewayKeys =
    options.keyStore ??
    new KeyStore(path.join(dataDir, "keys"), {
      warn: (message) => logger.warn(message),
    });
  recoverPendingVaultErases({
    gatewayDatabase,
    vaultRoot: paths.vaultDir,
    cacheRoot: paths.cacheDir ?? path.join(dataDir, "cache"),
    keys: gatewayKeys,
    logger,
  });
  const storageConnections = await openStorageConnectionStore({
    database: gatewayDatabase,
    keyStore: gatewayKeys,
  });
  let walCaptureConfigured =
    options.backup?.enabled === true ||
    (await storageConnections.list()).length > 0;
  const recoveryKit = new RecoveryKitStateStore(gatewayDatabase);
  const storageUsage = new StorageUsagePoller({ storageConnections });
  const storageLimits = new StorageLimitsStore(gatewayDatabase);
  await storageLimits.load();

  const pricingCacheFile =
    paths.modelPricingFile ??
    (paths.modelCatalogFile
      ? path.join(path.dirname(paths.modelCatalogFile), "model-pricing.json")
      : undefined);
  const pricingWarmer = new PricingWarmer({
    ...(pricingCacheFile ? { cacheFile: pricingCacheFile } : {}),
    logger: health.loggerFor("pricing", logger),
  });
  void pricingWarmer.boot();

  const resourceAccounting = new ResourceAccounting({
    workerPoolStats: workerAdmissionStats,
  });

  // A third "not now" signal in the SAME safe-loop gate as the owner pause
  // and load-shed — never a durable mode flip. A COURTESY, so the health
  // component stays `ok` and only its detail changes (#528).
  const powerContext = new PowerContextMonitor({
    onDeferringChange: (state) => {
      health.reportOk(
        "power-posture",
        state.reason === null
          ? formatPowerPostureNormalDetail()
          : formatPowerPostureDeferringDetail(state.reason, state.kind)
      );
    },
  });
  health.reportOk("power-posture", formatPowerPostureNormalDetail());

  const accountRunTurn =
    (base: RunTurnFn): RunTurnFn =>
    async (input, config) => {
      const startedAt = Date.now();
      try {
        return await base(input, config);
      } finally {
        resourceAccounting.recordHarnessRun({
          durationMs: Date.now() - startedAt,
        });
      }
    };
  const accountedRunTurn = accountRunTurn(options.runTurn ?? runTurn);

  let provenanceDoorbell: (
    vaultId: string,
    entityTypes?: readonly string[]
  ) => void = () => {};
  const notificationsEvents = new NotificationsEventBus();
  const notificationsDecisionWake = createNotificationsDecisionWakeTracker();
  const notificationsDoorbellWindowMs =
    options.notificationsDoorbellWindowMs ?? 250;
  const notificationsDoorbellWindows = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; pending: boolean }
  >();
  const pendingNotificationsWakes = new Set<string>();
  let requestNotificationsWake: (vaultId: string) => void = (vaultId) => {
    pendingNotificationsWakes.add(vaultId);
  };
  let nudgeCommonsSweep = (): void => undefined;
  /**
   * Seeded so a replayed command mints exactly the ids the steward minted
   * (#750 invariant 7). Host-only: never reachable from member or app code,
   * never serialized. An unmounted vault cannot replay, which the caller
   * answers by re-projecting from the closure.
   */
  const commonsReplicaInvoke = (
    vaultId: string,
    command: string,
    input: Record<string, unknown>,
    invocationId: string
  ): InvokeOutcome => {
    const mounted = vaultRegistry.get(vaultId);
    if (!mounted?.gateway || !mounted.ownerCredential)
      throw new Error(`commons replica vault ${vaultId} is not mounted`);
    return mounted.gateway.invokeCommonsCanonical(
      mounted.ownerCredential,
      { command, input, invocationId },
      { idSeed: invocationId }
    );
  };
  const vaultRegistry: VaultRegistry = openVaultRegistry({
    rootDir: paths.vaultDir,
    synchronous: hardwareProfile.sqliteSynchronous,
    ...(hardwareProfile.storageFsyncMs === null
      ? {}
      : { storageFsyncMs: hardwareProfile.storageFsyncMs }),
    replicationConcurrency: hardwareProfile.replicationConcurrency,
    footprintBudget:
      hardwareProfile.class === "constrained"
        ? DEFAULT_VAULT_FOOTPRINT
        : {
            mmapBytes: DEFAULT_VAULT_FOOTPRINT.mmapBytes * 2,
            cacheBytes: DEFAULT_VAULT_FOOTPRINT.cacheBytes * 2,
          },
    sweepIntervalMs: hardwareProfile.vaultSweepIntervalMs,
    // Sweeps are a safe loop: defer under pressure, honor the owner's pause,
    // yield to power posture. Durability loops (WAL, outbox) call
    // `shouldDeferBackgroundWork` alone and are never paused (#528).
    shouldDeferBackgroundWork: () =>
      health.shouldDeferBackgroundWork() ||
      health.shouldPauseBackgroundWork() ||
      powerContext.isDeferringBackgroundWork(),
    // gateway.db owns the WAL lifecycle unconditionally; only the capture
    // clock sleeps with no backup destination, keeping the low-end
    // no-unconfigured-spool contract without reviving lease gating.
    walCaptureConfigured: () => walCaptureConfigured,
    cacheRootDir: paths.cacheDir ?? path.join(dataDir, "cache"),
    logger: health.loggerFor("vaults", logger),
    keyStore: gatewayKeys,
    skipOrphanDelete: () => gatewayDatabase.networkFileSystem,
    // Supersedes the `CENTRAID_S3_*` env lane for any vault whose
    // `blob_store.connectionId` is set; others keep the env default (#367).
    s3Credentials: makeStorageCredentialsResolver(storageConnections),
    onProvenanceCommitted: (vaultId, entityTypes) =>
      provenanceDoorbell(vaultId, entityTypes),
    onCommonsCommandSequenced: (vaultId, grantId) => {
      const steward = vaultRegistry.get(vaultId);
      if (!steward) return;
      recompileCommonsGrants({
        steward: steward.db,
        stewardVaultId: vaultId,
        stewardPartyId: steward.boot.ownerPartyId,
        grantId,
        vaultFor: (memberVaultId) => vaultRegistry.get(memberVaultId)?.db,
        invokeFor: commonsReplicaInvoke,
        now: new Date().toISOString(),
      });
    },
    onCommonsIntentQueued: () => nudgeCommonsSweep(),
    onNotificationsChanged: (vaultId, wake) => {
      notificationsEvents.publish(vaultId, wake);
      if (wake) requestNotificationsWake(vaultId);
    },
    previewCodec: options.previewCodec ?? createImagePreviewCodec(),
    onSweepPass: (info) => {
      resourceAccounting.recordSweepPass(info);
      resourceAccounting.recordBackgroundTimerFire();
    },
    onReplicationPass: (info) => resourceAccounting.recordReplicationPass(info),
    journalLimitBytes: () => storageLimits.current().journalLimitBytes,
  });
  /*
   * Auto-found (#603), synchronously, before any route can observe a
   * zero-vault gateway. BOTH guards are load-bearing: `isFresh()` counts a
   * vault dir that FAILED to mount, so corruption never re-founds over
   * existing data, and the owners guard covers erase-then-restore — a data
   * dir that ever enrolled an owner is inhabited, not fresh.
   */
  const neverInhabited = (): boolean => {
    const row = gatewayDatabase.db
      .prepare("SELECT COUNT(*) AS n FROM owners")
      .get() as {
      n: number;
    };
    return row.n === 0;
  };
  const autoFoundedVaults =
    vaultRegistry.isFresh() && neverInhabited()
      ? [vaultRegistry.create("Personal", { personal: true })]
      : [];
  // `rescan()` turns a failed mount from "gone until restart" into "retried
  // next health tick" (#351). "ok" is NOT "the plane is in memory": each tick
  // runs one statement per plane, so a file corrupted or removed under the
  // process flips the component red instead of staying silently ok.
  health.registerProbe("vaults", async () => {
    vaultRegistry.rescan();
    const planes = vaultRegistry.planesList();
    const failed = vaultRegistry.failedMounts();
    const unreadable: string[] = [];
    for (const plane of planes) {
      try {
        plane.db.vault.prepare("PRAGMA user_version").get();
      } catch (error) {
        unreadable.push(
          `${plane.boot.vaultId}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const quarantined = planes.filter((p) => p.quarantine !== null);

    if (failed.length > 0 || unreadable.length > 0) {
      const notes = [
        ...failed.map((f) => `${f.dir}: ${f.message} (since ${f.at})`),
        ...unreadable.map((u) => `${u} — vault.db unreadable`),
      ];
      return { status: "error", detail: notes.join("; ") };
    }
    if (quarantined.length > 0) {
      const detail = quarantined
        .map(
          (p) =>
            `${p.boot.vaultId} (source seq ${p.quarantine?.sourceSeq}) needs review`
        )
        .join("; ");
      return { status: "error", detail: `restored from backup — ${detail}` };
    }
    return planes.length > 0
      ? {
          status: "ok",
          detail: `${planes.length} vault${planes.length === 1 ? "" : "s"} mounted`,
        }
      : { status: "error", detail: "no vault is mounted" };
  });

  health.registerProbe(
    "disk",
    createDiskHealthProbe({
      rootDir: dataDir,
      vaults: () =>
        vaultRegistry
          .planesList()
          .map((p) => ({ vaultId: p.boot.vaultId, dir: p.dir })),
    })
  );

  const localUsage = new LocalUsageScanner({
    rootDir: dataDir,
    vaults: () =>
      vaultRegistry.planesList().map((p) => ({
        vaultId: p.boot.vaultId,
        dir: p.dir,
        ...(p.cacheDir && p.cacheDir !== p.dir ? { cacheDir: p.cacheDir } : {}),
      })),
    gatewayDirs: () => ({
      cache: paths.cacheDir,
      logs: paths.logsDir,
      templates: paths.templatesCacheDir,
    }),
  });

  // Warn-only by design: a soft budget must never refuse a write (#544).
  health.registerProbe("storage-limit", async () => {
    const limits = storageLimits.current();
    if (limits.totalLimitBytes === null) {
      return { status: "ok", detail: "no disk budget set" };
    }
    const report = await localUsage.report();
    const evaluation = evaluateStorageLimit(report.totalBytes, limits);
    const percent = ((evaluation.fractionUsed ?? 0) * 100).toFixed(1);
    const detail =
      `${formatBytes(evaluation.usedBytes)} of the ${formatBytes(limits.totalLimitBytes)} ` +
      `budget (${percent}%)`;
    if (evaluation.status === "error") {
      return {
        status: "error",
        detail: `${detail} — over budget; nothing is being blocked`,
      };
    }
    if (evaluation.status === "degraded") {
      return {
        status: "degraded",
        detail: `${detail} — past the ${limits.warnAtPercent}% warning`,
      };
    }
    return { status: "ok", detail };
  });

  health.registerProbe("connections", async () => {
    let total = 0;
    let needsAuth = 0;
    for (const plane of vaultRegistry.planesList()) {
      const rows = plane.db.vault
        .prepare(
          `SELECT status, COUNT(*) AS n FROM sync_connection GROUP BY status`
        )
        .all() as Array<{ status: string; n: number }>;
      for (const row of rows) {
        total += row.n;
        if (row.status === "needs-auth") needsAuth += row.n;
      }
    }
    if (needsAuth > 0) {
      return {
        status: "degraded",
        detail: `${needsAuth} of ${total} connection${total === 1 ? "" : "s"} need re-auth`,
      };
    }
    return {
      status: "ok",
      detail: `${total} connection${total === 1 ? "" : "s"} configured`,
    };
  });

  health.registerProbe(
    "broker",
    createBrokerHealthProbe({
      vaults: () =>
        vaultRegistry
          .planesList()
          .map((p) => ({ vaultId: p.boot.vaultId, db: p.db.vault })),
    })
  );

  const journalStoreFor = (vaultId: string): ConversationStore => {
    const plane = vaultRegistry.get(vaultId);
    if (!plane) throw new Error(`gateway: unknown vault "${vaultId}"`);
    return ledgerConversationStore(plane.workspace.ledgerDbFile);
  };

  const schedulerLedgers = new Map<string, automation.SchedulerLedgerStore>();
  const schedulerLedgerFor = (
    vaultId: string
  ): automation.SchedulerLedgerStore => {
    const existing = schedulerLedgers.get(vaultId);
    if (existing) return existing;
    const ledger = new automation.SchedulerLedgerStore(
      journalStoreFor(vaultId)
    );
    schedulerLedgers.set(vaultId, ledger);
    return ledger;
  };

  health.registerProbe(
    "scheduler",
    createSchedulerHealthProbe({
      vaults: () =>
        vaultRegistry.planesList().map((p) => ({
          vaultId: p.boot.vaultId,
          snapshot: () => schedulerLedgerFor(p.boot.vaultId).load(),
        })),
    })
  );

  health.registerProbe(
    "enrichment",
    createEnrichmentHealthProbe({
      vaults: () =>
        vaultRegistry.planesList().map((p) => ({
          vaultId: p.boot.vaultId,
          listAutomations: async () => {
            const { rows } = await automation.list(
              settledHostFor(p.boot.vaultId).codeAppsDir()
            );
            return rows.map((r) => ({
              id: r.id,
              enabled: r.enabled,
              ref: r.ref,
            }));
          },
          recentRuns: (automationRef, limit) =>
            journalStoreFor(p.boot.vaultId)
              .listAutomationTurns(automationRef, { limit })
              .map((t) => ({
                ok: t.ok,
                ...(t.endedAt === undefined ? {} : { endedAt: t.endedAt }),
              })),
        })),
    })
  );

  health.registerProbe(
    "blob-sweep",
    createBlobSweepHealthProbe({
      vaults: () =>
        vaultRegistry.planesList().map((p) => ({
          vaultId: p.boot.vaultId,
          s3Configured: () => readBlobStoreSettings(p.db.vault).kind === "s3",
          counts: () => custodyStateCounts(p.db.vault),
          sweepStatus: () => p.db.blobs.sweepStatus(),
        })),
    })
  );

  health.registerProbe(
    "vault-integrity",
    createVaultIntegrityHealthProbe({
      vaults: () =>
        vaultRegistry.planesList().map((p) => ({
          vaultId: p.boot.vaultId,
          vault: p.db.vault,
        })),
      startupGraceMs: 5 * 60_000,
    })
  );

  health.registerProbe(
    "storage-quota",
    createStorageQuotaHealthProbe({
      connections: async () =>
        (await storageConnections.list()).map((c) => ({
          connectionId: c.id,
          name: c.name,
          kind: c.kind,
        })),
      usageFor: (connectionId) => storageUsage.usageFor(connectionId),
    })
  );

  health.setMetricsSource(() => {
    let outboxPending = 0;
    for (const plane of vaultRegistry.planesList()) {
      try {
        const row = plane.db.vault
          .prepare(
            `SELECT COUNT(*) AS n FROM outbox_item WHERE status = 'approved'`
          )
          .get() as { n: number } | undefined;
        outboxPending += row?.n ?? 0;
      } catch {
        /* a vault whose outbox table isn't there yet contributes 0 */
      }
    }
    return {
      outboxPending,
      sseClients:
        logsEventsSubscriberCount() +
        turnEventsSubscriberCount() +
        changesSubscriberCount(),
      mountedVaults: vaultRegistry.planesList().length,
      hardwareProfileClass: hardwareProfile.class,
      resourceMode: hardwareProfile.resourceMode,
      resourceProfile: toStructuredResourceProfile(hardwareProfile),
      resourceUsage: resourceAccounting.snapshot(),
      powerContext: powerContext.snapshot(),
    };
  });

  const backupCacheDir = paths.cacheDir ?? path.join(dataDir, "cache");
  const sourceInstanceId = deriveBackupSourceInstanceId(
    gatewayKeys.loadOrCreate("endpoint-key.bin")
  );
  const backupService = new BackupService({
    ...(options.backup?.enabled ? { config: options.backup } : {}),
    cacheDir: backupCacheDir,
    gatewayDatabase,
    keyStore: gatewayKeys,
    sourceInstanceId,
    vaults: vaultRegistry,
    health,
    logger: health.loggerFor("backups", logger),
    recoveryKit,
    storageConnections,
    // A predicate, so BackupService never imports the monitor. The WAL drain
    // stays ungated — RPO durability (#528).
    shouldDeferPosture: () => powerContext.isDeferringBackgroundWork(),
    onDrainAccounted: (info) => {
      resourceAccounting.recordBackupDrain(info);
      resourceAccounting.recordBackgroundTimerFire();
    },
    // Skip + report a vault this machine's backup config is not authorized
    // for, rather than silently shipping someone else's data (#726).
    // `enrollmentStore`/`hostOwnerEndpointId` are declared below — safe,
    // because these closures only run once a backup fires.
    ownerOf: (vaultId) => enrollmentStore.owners.ownerOf(vaultId),
    authorizedOwnerId: () =>
      hostOwnerEndpointId
        ? enrollmentStore.ownerFor(hostOwnerEndpointId)?.ownerId
        : undefined,
  });

  const enrollmentStore =
    options.devicePairing?.enrollments ?? EnrollmentStore.open(gatewayDatabase);
  const vaultLinksStore: VaultLinksStore = new VaultLinksStore(
    gatewayDatabase,
    (link) =>
      reconcileLinkBindings(link, {
        vaultFor: (vaultId) => vaultRegistry.get(vaultId)?.db,
        publicKeyFor: (vaultId) =>
          vaultLinksStore.directoryEntry(vaultId)?.publicKey,
        labelFor: (vaultId) =>
          vaultLinksStore.directoryEntry(vaultId)?.label ?? undefined,
      })
  );
  const embeddedEndpointId = options.deviceAccess
    ? undefined
    : (options.hostDeviceEndpointId ??
      kitlessHostIdentity(gatewayKeys.loadOrCreate("endpoint-key.bin")));
  const embeddedAccess: DeviceAccess | undefined = embeddedEndpointId
    ? {
        // Deliberately `isLoopbackRequest`, NOT `isDirectHostRequest`: the
        // phone tunnel forwards a paired phone under the host bearer with no
        // device key, so tightening this severs phone-link. Host-ONLY
        // capabilities use the stricter `isHostCustody` gate. The peer lane
        // MUST be excluded: a forwarder also delivers to loopback, and a
        // linked gateway must never inherit the HOST's owner-tier reach.
        deviceKeyFor: (req) =>
          isLoopbackRequest(req) &&
          req.headers[PEER_ENDPOINT_HEADER] === undefined
            ? embeddedEndpointId
            : undefined,
        vaultsFor: (endpointId) => enrollmentStore.vaultsFor(endpointId),
      }
    : undefined;
  const effectiveDeviceAccess = options.deviceAccess ?? embeddedAccess;
  const hostOwnerEndpointId =
    options.hostDeviceEndpointId ?? embeddedEndpointId;
  if (autoFoundedVaults.length > 0 && hostOwnerEndpointId) {
    gatewayDatabase.transaction(() =>
      enrollmentStore.enrollWithinTransaction({
        endpointId: hostOwnerEndpointId,
        ownerLabel: "You",
        vaultIds: autoFoundedVaults.map((vault) => vault.vaultId),
        label: options.hostDeviceEndpointId ? "desktop host" : "gateway host",
        platform: "loopback",
      })
    );
  }

  for (const owner of enrollmentStore.owners.list()) {
    if (enrollmentStore.owners.vaultsOwnedBy(owner.ownerId).length > 0)
      continue;
    const minted = vaultRegistry.create(`${owner.label}'s vault`);
    enrollmentStore.owners.setOwner(minted.vaultId, owner.ownerId);
  }

  const currentWorkspace = (): VaultWorkspace =>
    vaultRegistry.currentWorkspace();

  const prefs = prefsEarly;
  const journalProvider = () => currentWorkspace().journal();
  const harnessHealthStore = new HarnessHealthStore(journalProvider);
  let failoverDegraded = false;
  const reportFailoverError = (detail: string): void => {
    failoverDegraded = true;
    health.reportError("harness-failover", detail);
    logger.warn(`Harness failover: ${detail}`);
  };
  const harnessHealth: HarnessHealthController = {
    canAttempt: (context, kind, now) =>
      harnessHealthStore.canAttempt(context, kind, now),
    reportFailure: (context, kind, failureClass, error, now) =>
      harnessHealthStore.reportFailure(context, kind, failureClass, error, now),
    reportOk: (context, kind, now) => {
      harnessHealthStore.reportOk(context, kind, now);
      // A completed turn beats a capability probe: the harness authenticated
      // and answered. Auth breakers are otherwise closed only by the harnesses
      // route's explicit refresh, so a working harness could stay condemned.
      harnessHealthStore.reportPreflightOk(context, kind, now);
      if (failoverDegraded) {
        failoverDegraded = false;
        health.reportOk(
          "harness-failover",
          `${kind} completed a turn in ${context}`
        );
      }
    },
    reportPreflightOk: (context, kind, now) =>
      harnessHealthStore.reportPreflightOk(context, kind, now),
    list: (context, now) => harnessHealthStore.list(context, now),
  };
  const providerEgressConsent = new ProviderEgressConsentStore(
    journalProvider,
    (harnessKind, subsystem) => {
      const snapshot = prefs.getAllPrefs();
      const primary = resolveGatewayHarnessPrefs(snapshot, subsystem).kind;
      return resolveSubsystemHarnessLadder(snapshot, subsystem, primary)
        .slice(1)
        .includes(harnessKind);
    }
  );
  const analyticsStore = new AnalyticsStore(journalProvider);
  const insightsStore = new InsightsStore(journalProvider);
  const conversationHistoryStore = new ConversationHistoryStore(
    currentWorkspace,
    {
      archiveBlobReader: (sha) => vaultRegistry.current().db.blobs.open(sha),
    }
  );

  const prefsLoader = async (
    subsystem?: ModelSubsystem,
    requestedHarness?: HarnessKind
  ): Promise<HarnessPrefs | undefined> => {
    return resolveGatewayHarnessPrefs(
      prefs.getAllPrefs(),
      subsystem,
      requestedHarness
    );
  };
  const harnessLadder = (
    subsystem: ModelSubsystem | undefined,
    primary: HarnessKind
  ): readonly HarnessKind[] =>
    subsystem
      ? resolveSubsystemHarnessLadder(prefs.getAllPrefs(), subsystem, primary)
      : [primary];
  const harnessHealthContext = (): string => currentWorkspace().vaultId;
  const onConversationRunnerFailover = (event: {
    conversationId: string;
    subsystem?: ModelSubsystem;
    from: HarnessKind;
    to: HarnessKind;
  }): void => {
    reportFailoverError(
      `${event.subsystem ?? "conversation"} ${event.conversationId}: ` +
        `${event.from} → ${event.to}`
    );
  };

  // The harness resolves FIRST, for THIS subsystem, and that kind scopes the
  // model key: reading per-harness model prefs against the GLOBAL kind hands
  // the turn a model its backend has never heard of.
  const resolveModel = async (
    subsystem: ModelSubsystem,
    explicit?: string,
    requestedHarness?: HarnessKind
  ): Promise<string | undefined> => {
    const harnessPrefs = await prefsLoader(subsystem, requestedHarness);
    if (!harnessPrefs) return explicit;
    return resolveSubsystemModel(
      prefs.getAllPrefs(),
      harnessPrefs.kind,
      subsystem,
      explicit
    );
  };

  const resolveAutomationHarness = async (
    requires: automation.ManifestRequires
  ): Promise<AutomationHarnessSelection> => {
    const fallbackHarness = (await prefsLoader("automations"))?.kind ?? "codex";
    return resolveAutomationHarnessSelection(
      requires,
      prefs.getAllPrefs(),
      fallbackHarness
    );
  };

  const resolveAutomationHarnessForRef = async (
    automationRef: string,
    codeAppsDir: string
  ): Promise<AutomationHarnessSelection> => {
    const parsed = automation.parseRef(automationRef);
    const row = parsed
      ? await automation.readAppOwned(
          codeAppsDir,
          parsed.appId,
          parsed.automationId
        )
      : undefined;
    return resolveAutomationHarness(row?.manifest.requires ?? {});
  };

  const catalogPath = paths.modelCatalogFile;
  const catalogLogger = health.loggerFor("catalog", logger);
  const warmer = catalogPath
    ? new CatalogWarmer({
        catalogPath,
        enumerateModels: async (kind) => {
          const harnessPrefs = await prefsLoader();
          const isActive = harnessPrefs?.kind === kind;
          return enumerateHarnessModels({
            kind,
            ...(isActive && harnessPrefs?.binPath
              ? { binPath: harnessPrefs.binPath }
              : {}),
            ...(isActive && harnessPrefs?.extraArgs
              ? { extraArgs: harnessPrefs.extraArgs }
              : {}),
          });
        },
      })
    : undefined;

  const resolveCatalogSurface = async <T>(
    surface: CatalogSurface,
    kind: HarnessKind,
    refresh: boolean,
    read: (cp: string, k: HarnessKind) => Promise<T[]>
  ): Promise<{ list: T[]; status: SurfaceStatus }> => {
    if (!catalogPath || !warmer) return { list: [], status: "empty" };
    const list = await read(catalogPath, kind);
    if (refresh || (list.length === 0 && !warmer.hasWarmed(kind, surface))) {
      void warmer.warm(kind, surface);
    }
    return {
      list,
      status: deriveStatus(list.length, warmer.isWarming(kind, surface)),
    };
  };

  const resolveCatalogModels = catalogPath
    ? (kind: HarnessKind, refresh: boolean) =>
        resolveCatalogSurface("models", kind, refresh, readHarnessModels)
    : undefined;
  const binPathForKind = (kind: HarnessKind): string | undefined => {
    const allPrefs = prefs.getAllPrefs();
    if (allPrefs["harness.kind"] !== kind) return undefined;
    const binPath = allPrefs["harness.binPath"];
    return typeof binPath === "string" && binPath.length > 0
      ? binPath
      : undefined;
  };
  const extraArgsForKind = (kind: HarnessKind): string[] | undefined => {
    const allPrefs = prefs.getAllPrefs();
    if (allPrefs["harness.kind"] !== kind) return undefined;
    const extraArgs = allPrefs["harness.extraArgs"];
    return Array.isArray(extraArgs) &&
      extraArgs.every((entry) => typeof entry === "string")
      ? extraArgs
      : undefined;
  };

  const askModelPrefs = {
    get: async (): Promise<AskModelInfo> => {
      const harnessPrefs = (await prefsLoader("ask")) ?? {
        kind: "codex" as const,
      };
      const allPrefs = prefs.getAllPrefs();
      const scoped = allPrefs[`model.${harnessPrefs.kind}.ask`];
      const current =
        typeof scoped === "string" && scoped.length > 0 ? scoped : null;
      const savedDefault = allPrefs[`model.${harnessPrefs.kind}.default`];
      const { list } = resolveCatalogModels
        ? await resolveCatalogModels(harnessPrefs.kind, false)
        : { list: [] };
      const defaultModel =
        typeof savedDefault === "string" && savedDefault.length > 0
          ? savedDefault
          : list.find((m) => m.default)?.id;
      return {
        harnessKind: harnessPrefs.kind,
        ...(defaultModel ? { defaultModel } : {}),
        current,
        catalog: list.map((m) => ({ id: m.id, label: m.name ?? m.id })),
      };
    },
    set: async (model: string | null): Promise<void> => {
      const harnessPrefs = (await prefsLoader("ask")) ?? {
        kind: "codex" as const,
      };
      prefs.setPrefs({
        [`model.${harnessPrefs.kind}.ask`]:
          model && model.length > 0 ? model : null,
      });
    },
  };

  // Cycle break: the chat runner needs the Runtime's dispatcher, but the
  // Runtime is constructed WITH the chat runner, so this resolves at call time.
  let runtimeRef: Runtime | undefined = undefined;
  const getDispatcher = (): Runtime["dispatcher"] => {
    const rt = runtimeRef;
    if (!rt)
      throw new Error("chat runner invoked before runtime was constructed");
    return rt.dispatcher;
  };
  let serverUrl = "";

  // ── Per-vault host bundles (#280, #289) ───────────────────────────────
  const hosts = new Map<string, Promise<VaultHost>>();
  const settledHosts = new Map<string, VaultHost>();
  const runEventBus = new RunEventBus();
  const automationConversationLocks = new Map<string, Promise<void>>();
  // Detached work started behind a 202. `stop()` drains this BEFORE the vault
  // registry closes its databases, so shutdown cannot land mid-`closeItem` or
  // orphan an ACP child (#541).
  const detachedAutomationTasks = new Set<Promise<void>>();
  const trackDetachedAutomationTask = (
    task: Promise<void>,
    label: string
  ): void => {
    const tracked = task
      .catch((error: unknown) => {
        logger.warn?.(
          `automation task "${label}" failed: ${error instanceof Error ? error.message : String(error)}`
        );
      })
      .finally(() => {
        detachedAutomationTasks.delete(tracked);
      });
    detachedAutomationTasks.add(tracked);
  };

  // Credential values are injected TRANSPORT-side, never handed to a handler
  // (#304).
  const connectionBroker = new ConnectionBroker(
    () => vaultRegistry.current(),
    undefined,
    options.assistOAuth,
    undefined,
    undefined,
    health.loggerFor("connections", logger)
  );

  // The ONLY writer on the broker's `allowWrites` lane, and it runs OUTSIDE
  // the fire loop.
  const outboxExecutor = new OutboxExecutor(
    connectionBroker,
    health.loggerFor("outbox", logger)
  );
  const drainOutbox = (plane: VaultPlane): void => {
    void outboxExecutor
      .drain(plane)
      .then(() => health.reportOk("outbox"))
      .catch((error) => {
        const message = `outbox drain failed: ${error instanceof Error ? error.message : String(error)}`;
        health.reportError("outbox", message);
        logger.warn(message);
      });
  };

  // AN APP DECLARES; IT IS NOT GRANTED (#928 A1). Installing records the
  // app's own build-time manifest — what a replica shape is composed from and
  // what the static entity tripwire holds it to. A malformed block declares
  // nothing, so the app reaches nothing.
  const grantScopesFromDir = async (
    plane: VaultPlane,
    appId: string,
    dir: string | undefined
  ) => {
    if (!dir) return;
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(dir, "app.json"), "utf8")
      ) as { vault?: { scopes?: unknown } };
      const block = manifestScopeBlock(raw.vault);
      if (block) plane.recordAppInstall(appId, block);
    } catch (error) {
      logger.warn(
        `install-time grant for app "${appId}" failed: ` +
          (error instanceof Error ? error.message : String(error))
      );
    }
  };
  const grantDeclaredAppScopes = async (
    plane: VaultPlane,
    store: WorktreeStore,
    appId: string
  ): Promise<void> => {
    await grantScopesFromDir(
      plane,
      appId,
      await store.resolveActiveAppDir(appId)
    );
  };
  // Bundled apps declare scopes in the SHIPPED blueprint's app.json, not in
  // the (empty) code store (#434).
  const grantDeclaredBundledScopes = (
    plane: VaultPlane,
    appId: string
  ): Promise<void> => grantScopesFromDir(plane, appId, bundledAppDir(appId));

  let outboxTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleOutboxSweep = (delayMs: number): void => {
    if (outboxTimer) clearTimeout(outboxTimer);
    outboxTimer = setTimeout(() => {
      void runOutboxSweep();
    }, jitterDelayMs(delayMs));
    unrefTimer(outboxTimer);
  };
  const runOutboxSweep = async (): Promise<void> => {
    resourceAccounting.recordBackgroundTimerFire();
    if (health.shouldDeferBackgroundWork()) {
      scheduleOutboxSweep(hardwareProfile.outboxIdleIntervalMs);
      return;
    }
    const outboxStartedAt = Date.now();
    const settled = await Promise.allSettled(
      vaultRegistry.planesList().map((plane) => outboxExecutor.drain(plane))
    );
    let active = false;
    let failed = false;
    for (const result of settled) {
      if (result.status === "fulfilled") {
        active ||= result.value.approved > 0 || result.value.deferred > 0;
      } else {
        failed = true;
        logger.warn(
          `outbox sweep failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        );
      }
    }
    resourceAccounting.recordSweepPass({
      durationMs: Date.now() - outboxStartedAt,
    });
    if (failed)
      health.reportError("outbox", "one or more adaptive outbox sweeps failed");
    else health.reportOk("outbox");
    const nextDelay = failed
      ? Math.min(hardwareProfile.outboxIdleIntervalMs * 2, 15 * 60 * 1000)
      : active
        ? 5_000
        : hardwareProfile.outboxIdleIntervalMs;
    scheduleOutboxSweep(nextDelay);
  };

  const fireAutomation: FireAutomation = async (automationRef, opts) => {
    const runId =
      opts.runId ??
      `${automationRef}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
    let noticeContext:
      | {
          name: string;
          policy: automation.Manifest["notify"];
          appId: string;
          automationId: string;
        }
      | undefined;
    const recordAutomationNotice = (
      outcome: "success" | "failure" | "skipped",
      error?: string
    ): void => {
      // Skips are SILENT (#647): the owner-chosen state behind them already
      // carries its own decision, and a notice per cron tick would reset read
      // state and wake devices forever.
      if (outcome === "skipped") return;
      const plane = vaultRegistry.current();
      const prior = plane.notices.getBySource("automation", automationRef);
      const previousOutcome =
        prior?.detail.outcome === "success" ||
        prior?.detail.outcome === "failure"
          ? prior.detail.outcome
          : undefined;
      if (
        !shouldWriteAutomationNotice(
          noticeContext?.policy,
          outcome,
          previousOutcome
        )
      )
        return;
      const name = noticeContext?.name ?? humanizeAutomationRef(automationRef);
      const gist = outcome === "failure" ? noticeGist(error) : undefined;
      plane.notices.put({
        kind: "automation",
        sourceRef: automationRef,
        headline:
          outcome === "failure"
            ? gist
              ? `${name} failed — ${gist}`
              : `${name} failed`
            : previousOutcome === "failure"
              ? `${name} recovered`
              : `${name} completed`,
        severity: outcome === "failure" ? "high" : "info",
        detail: {
          sourceType: "automation",
          outcome,
          automationRef,
          runId,
          ...(noticeContext
            ? {
                appId: noticeContext.appId,
                automationId: noticeContext.automationId,
              }
            : {}),
          ...(error ? { error } : {}),
          deepLink: `/automations/${encodeURIComponent(automationRef)}`,
        },
      });
    };
    // The ONE skip that is not silent: a tier refusal rests on a setting the
    // owner may not know exists. Written once per (domain, tier) — re-putting
    // it clears `read_at` every tick and becomes the nag #647 forbids.
    const recordEnrichRefusalNotice = (
      refusal: { domain: string; tier?: string } | undefined
    ): void => {
      if (!refusal) return;
      const plane = vaultRegistry.current();
      const prior = plane.notices.getBySource("enrichment", refusal.domain);
      if (!shouldWriteEnrichRefusalNotice(prior, refusal.tier)) return;
      plane.notices.put(enrichRefusalNotice(refusal));
    };
    try {
      const host = currentSettledHost();
      const ws = currentWorkspace();
      const parsedAutomation = automation.parseRef(automationRef);
      const automationRow = parsedAutomation
        ? await automation.readAppOwned(
            host.codeAppsDir(),
            parsedAutomation.appId,
            parsedAutomation.automationId
          )
        : undefined;
      if (automationRow && parsedAutomation) {
        noticeContext = {
          name: automationRow.name,
          policy: automationRow.manifest.notify,
          appId: parsedAutomation.appId,
          automationId: parsedAutomation.automationId,
        };
      }
      if (opts.idempotent && opts.runId) {
        // MEMOIZED deliberately: a data-triggered automation can fire every
        // few seconds, and a fresh provider per fire would leak an unclosed
        // `DatabaseSync` (64 MiB mapping + an fd) each time.
        const ledger = ledgerConversationStore(ws.ledgerDbFile);
        const prior = ledger.getTurn(opts.runId);
        if (prior?.endedAt !== undefined) return { turnId: runId };
        // An interrupted turn retries under the SAME run id: cascading removes
        // its partial items and deterministic invocation ids replay effects.
        if (prior) ledger.deleteTurn(opts.runId);
      }
      const harnessSelection = await resolveAutomationHarnessForRef(
        automationRef,
        host.codeAppsDir()
      );
      const automationLadder = resolveSubsystemHarnessLadder(
        prefs.getAllPrefs(),
        "automations",
        harnessSelection.harness
      );
      const result = await runAutomation({
        automationRef,
        runId,
        appsDir: ws.appsDir,
        ledgerDbFile: ws.ledgerDbFile,
        runTurn: accountedRunTurn,
        codeAppsDir: host.codeAppsDir(),
        vaultFor: async (appId: string, ref: string) => {
          const parsed = automation.parseRef(ref);
          const row = parsed
            ? await automation.readAppOwned(
                host.codeAppsDir(),
                parsed.appId,
                parsed.automationId
              )
            : undefined;
          if (!row)
            throw new Error(
              `automation ${ref}: cannot resolve execution scope`
            );
          return vaultRegistry.agentBridgeFor(
            appId,
            executionScopeBlock(row.manifest.vault)
          );
        },
        resolveConnection: connectionBroker.resolveForFire,
        // `plane.db.vault` deliberately, NOT `agentBridgeFor`: the guard must
        // not be answerable by the grants of the automation it guards. A throw
        // is a REFUSAL, not a default. A profile is gateway configuration and
        // never vault state, so its lookup is the gateway's registry (#807).
        resolveEnrichPolicy: (request) => {
          const snapshot = prefs.getAllPrefs();
          return {
            ...readEnrichPolicyResolutionInput(
              vaultRegistry.current().db.vault,
              request.domain,
              request.capability,
              request.scopeChain
            ),
            egressForProfile: (profileId: string) =>
              readEngineProfile(snapshot, profileId, request.capability, {
                laneFor: () => request.lane,
              })?.egress,
            // Read only AFTER the gate allowed the run, and turned into the
            // handler's `variant` — so binding a capability to a profile
            // selects the delegate step with no manifest edit (#807).
            engineForProfile: (profileId: string) =>
              readEngineProfile(snapshot, profileId, request.capability, {
                laneFor: () => request.lane,
              })?.engine,
            // Read only, and never from the automation's grants: the sole
            // writer of the egress answers is the journalled
            // `enrich.record_consent` command inside the vault (#807), which
            // has written them to the one authority plane since #883.
            egressConsent: (egress) =>
              readEnrichConsentForChain(vaultRegistry.current().db.vault, {
                capability: request.capability,
                egress,
                scopeChain: request.scopeChain,
              }),
          };
        },
        rearm: ({ automationRef: ref, completedRunId }) => {
          const vaultId = ws.vaultId;
          const task = new Promise<void>((resolve, reject) => {
            const immediate = setImmediate(() => {
              void runWithVaultContext({ vaultId }, () =>
                fireAutomation(ref, {
                  triggerKind: "scheduled",
                  triggerOrigin: "data",
                  note: `bounded backlog continues after ${completedRunId}`,
                }).then(() => undefined)
              ).then(resolve, reject);
            });
            unrefTimer(immediate);
          });
          trackDetachedAutomationTask(task, `re-arm ${ref}`);
        },
        resolveNestedRuntime: async (nestedRef) => {
          const nested = await resolveAutomationHarnessForRef(
            nestedRef,
            host.codeAppsDir()
          );
          return {
            harnessKind: nested.harness,
            ...(nested.model ? { model: nested.model } : {}),
            ...(nested.configPins ? { configPins: nested.configPins } : {}),
          };
        },
        harness: harnessSelection.harness,
        // Manifests are harness-writable, so a `requires.harness` pin that names
        // a provider the user never chose is NOT consent for egress (#567).
        harnessSelectionSource: harnessSelection.selectionSource,
        triggerKind: opts.triggerKind,
        triggerOrigin: opts.triggerOrigin,
        ...(opts.input === undefined ? {} : { input: opts.input }),
        ...(opts.note ? { note: opts.note } : {}),
        ...(harnessSelection.model ? { model: harnessSelection.model } : {}),
        ...(harnessSelection.configPins
          ? { configPins: harnessSelection.configPins }
          : {}),
        harnessLadder: automationLadder,
        harnessPrefsFor: (kind) => prefsLoader("automations", kind),
        harnessHealth,
        harnessHealthContext: ws.vaultId,
        providerEgressConsent,
        hydrationAttachmentPath: (hash) => {
          const parsed = automation.parseRef(automationRef);
          if (!parsed)
            throw new Error(`invalid automation ref "${automationRef}"`);
          return conversationHistoryStore.blobPathFor(parsed.appId, hash);
        },
        onFailover: (event) => {
          reportFailoverError(
            `automation ${event.automationRef}: ${event.from} → ${event.to} ` +
              `after ${event.failureClass} (${event.failedRunId})`
          );
        },
        onRunEvent: (ev) => runEventBus.publish(runId, ev),
      });
      recordAutomationNotice(
        result.outcome.skipped
          ? "skipped"
          : result.outcome.ok
            ? "success"
            : "failure",
        result.outcome.error
      );
      recordEnrichRefusalNotice(result.outcome.enrichRefusal);
      drainOutbox(vaultRegistry.current());
      health.reportOk("automation-runs");
      return { turnId: runId, outcome: result.outcome, record: result.record };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordAutomationNotice("failure", message);
      // Failed before the ledger opened: close off the bus or the viewer hangs.
      runEventBus.publish(runId, {
        type: "turn.end",
        turnId: runId,
        ok: false,
        error: message,
      });
      health.reportError(
        "automation-runs",
        `${opts.triggerKind} ${automationRef}: ${message}`
      );
      logger.warn(`${opts.triggerKind} ${automationRef} failed: ` + message);
      if (opts.propagateError) throw error;
      return { turnId: runId };
    }
  };

  const settledHostFor = (vaultId: string): VaultHost => {
    const host = settledHosts.get(vaultId);
    if (!host)
      throw new Error(`gateway: vault ${vaultId} workspace not mounted yet`);
    return host;
  };

  const currentSettledHost = (): VaultHost =>
    settledHostFor(vaultRegistry.current().boot.vaultId);

  const currentVaultHost = (): Promise<VaultHost> =>
    hostFor(vaultRegistry.current());

  const hostFor = (plane: VaultPlane): Promise<VaultHost> => {
    const vaultId = plane.boot.vaultId;
    const cached = hosts.get(vaultId);
    if (cached) return cached;
    const built = runWithVaultContext({ vaultId }, async () => {
      const host = await buildHost(plane);
      await requireRuntime().bootstrap();
      await host.ensureSystemRecognitionRecipes();
      await forEachSequentially(await host.store.listApps(), async (appId) => {
        await requireRuntime().registry.ensureUploaded(appId);
        vaultRegistry.enrollApp(appId);
        await grantDeclaredAppScopes(plane, host.store, appId);
      });
      // Every first-party app ships INSTALLED (#708). MOUNT, not creation, is
      // the seam — the one path every vault takes on every boot, so an old
      // vault and a mid-upgrade one converge without a migration. Consequence:
      // there is deliberately no Uninstall verb for a bundled app, since
      // removing one would bring it back on the next mount.
      await forEachSequentially(bundledAppIds, async (appId) => {
        const meta = await readBundledAppMeta(bundledAppDir(appId));
        plane.installApp(appId, meta.name);
      });
      // Over `bundledAppIds`, NOT over what the vault says is enrolled: every
      // enrolled app now reads as `origin = 'installed'` (#916, ruling ONT-07),
      // and a store app or a recognition recipe has no bundle directory to
      // read declared scopes from.
      await forEachSequentially(bundledAppIds, async (appId) => {
        await requireRuntime().registry.ensureUploaded(appId);
        await grantDeclaredBundledScopes(plane, appId);
      });
      settledHosts.set(vaultId, host);
      await reconcileScheduler(vaultId);
      return host;
    }).catch((error) => {
      // A failed mount must not poison the cache — drop it so the next request
      // retries after a transient failure.
      hosts.delete(vaultId);
      throw error;
    });
    hosts.set(vaultId, built);
    return built;
  };

  const syncApps = async (vaultId?: string): Promise<void> => {
    const plane = vaultId
      ? vaultRegistry.get(vaultId)
      : vaultRegistry.current();
    if (!plane) throw new Error(`gateway: unknown vault "${vaultId}"`);
    const id = plane.boot.vaultId;
    const host = await hostFor(plane);
    await runWithVaultContext({ vaultId: id }, async () => {
      await requireRuntime().bootstrap();
      await host.ensureSystemRecognitionRecipes();
      await forEachSequentially(await host.store.listApps(), async (appId) => {
        await requireRuntime().registry.ensureUploaded(appId);
        vaultRegistry.enrollApp(appId);
        await grantDeclaredAppScopes(plane, host.store, appId);
      });
      await forEachSequentially(bundledAppIds, async (appId) => {
        await requireRuntime().registry.ensureUploaded(appId);
        await grantDeclaredBundledScopes(plane, appId);
      });
    });
    await reconcileScheduler(id);
  };

  /**
   * Installs into an EXPLICIT vault id, so everything vault-sensitive runs
   * inside `runWithVaultContext`: `registry.ensureUploaded` resolves
   * `appsDir()` off the ambient scope, and an unscoped call would install into
   * whatever vault the caller was on (#599). Fail-soft — a refusal resolves
   * `false` and the listing degrades instead of 500ing.
   */
  const ensureBundledAppInstalled = async (
    vaultId: string,
    appId: string
  ): Promise<boolean> => {
    if (!bundledAppIds.has(appId)) return false;
    const plane = vaultRegistry.get(vaultId);
    if (!plane) return false;
    if (plane.installedAppIds().has(appId)) return true;
    try {
      await hostFor(plane);
      return await runWithVaultContext({ vaultId }, async () => {
        const meta = await readBundledAppMeta(bundledAppDir(appId));
        plane.installApp(appId, meta.name);
        await requireRuntime().registry.ensureUploaded(appId);
        await grantDeclaredBundledScopes(plane, appId);
        return true;
      });
    } catch (error) {
      logger.warn(
        `scopes: auto-install of "${appId}" into vault ${vaultId} failed: ` +
          (error instanceof Error ? error.message : String(error))
      );
      return false;
    }
  };

  const deregisterAndCleanup = async (appId: string): Promise<void> => {
    const removed = await requireRuntime().registry.deregister(appId);
    if (removed)
      await cleanupDeregisteredApp(currentWorkspace().appsDir, removed, logger);
    vaultRegistry.revokeApp(appId);
  };

  const requireRuntime = (): Runtime => {
    if (!runtimeRef) throw new Error("gateway: runtime not constructed yet");
    return runtimeRef;
  };

  async function buildHost(plane: VaultPlane): Promise<VaultHost> {
    const workspace = plane.workspace;
    const vaultId = workspace.vaultId;
    const store = new WorktreeStore({ root: plane.codeStoreRoot });
    await store.init();
    const codeAppsDir = (): string =>
      path.join(store.getActiveMainLink(), "apps");
    const ext: ExtBandOps = {
      applyAppExt: (appId, tables) => plane.applyAppExt(appId, tables),
      seedAppExtDraft: (appId, tables, seedOpts) =>
        plane.gateway.seedAppExtDraft(
          plane.ownerCredential,
          appId,
          tables,
          seedOpts
        ),
      dropAppExtDraft: (appId) => plane.dropAppExtDraft(appId),
    };
    const draftCodeDir = makeDraftCodeDirResolver(store, ext);

    const runner: ConversationRunner = makeUnifiedConversationRunner({
      store,
      prefsLoader,
      subsystem: "builder",
      getDispatcher,
      publicBaseUrl: () => serverUrl,
      ext,
      ...makeVaultToolRunners(vaultRegistry),
      ...(options.sessionIdFor ? { sessionIdFor: options.sessionIdFor } : {}),
      runTurn: accountedRunTurn,
      harnessLadder,
      harnessHealth,
      harnessHealthContext,
      providerEgressConsent,
      onFailover: onConversationRunnerFailover,
    });
    // Headless compilation has its own outer automations ladder, so this
    // driver stays automations-scoped and SINGLE-RUNG: breaker selection must
    // never jump providers inside one compile ledger turn.
    const automationCompileRunner: ConversationRunner =
      makeUnifiedConversationRunner({
        store,
        prefsLoader,
        subsystem: "automations",
        getDispatcher,
        publicBaseUrl: () => serverUrl,
        ext,
        ...makeVaultToolRunners(vaultRegistry),
        ...(options.sessionIdFor ? { sessionIdFor: options.sessionIdFor } : {}),
        runTurn: accountedRunTurn,
        harnessHealth,
        harnessHealthContext,
        providerEgressConsent,
        onFailover: onConversationRunnerFailover,
      });
    const automationConversationRunnerFor = (
      block: InstallScopeBlock
    ): ConversationRunner => {
      const automationDispatcher = new Dispatcher({
        registry: () => requireRuntime().registry,
        codeDirOverride: (appId) => store.resolveActiveAppDir(appId),
        vaultFor: (appId) => vaultRegistry.agentBridgeFor(appId, block),
      });
      return makeConversationRunnerCore({
        prefsLoader,
        subsystem: "automations",
        getDispatcher: () => automationDispatcher,
        resolveCwd: (input) => input.dataDir,
        runTurn: accountedRunTurn,
        harnessLadder,
        harnessHealth,
        harnessHealthContext,
        providerEgressConsent,
        onFailover: onConversationRunnerFailover,
      });
    };
    const runAutomationCompileTask = async (input: {
      automationRef: string;
      runId: string;
      enableOnSuccess: boolean;
    }): Promise<{ ok: boolean; error?: string }> => {
      const { automationRef, runId, enableOnSuccess } = input;
      const parsed = automation.parseRef(automationRef);
      if (!parsed)
        return {
          ok: false,
          error: `invalid automation ref "${automationRef}"`,
        };
      const row = await automation.readAppOwned(
        codeAppsDir(),
        parsed.appId,
        parsed.automationId
      );
      if (!row)
        return {
          ok: false,
          error: `automation "${automationRef}" does not exist`,
        };
      const harnessSelection = await resolveAutomationHarness(
        row.manifest.requires
      );
      const enabledBeforeCompile = row.enabled;
      const anchorResolution = (() => {
        try {
          const anchors = resolveAutomationAnchors(
            { gateway: plane.gateway, credential: plane.ownerCredential },
            row.manifest.prompt
          );
          return { anchors, scopes: scopesForAutomationAnchors(anchors) };
        } catch (error) {
          return {
            anchors: [],
            scopes: [],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      })();
      // Compiles are one-shot drafts: reusing the interactive worktree lets a
      // failed publish leave a rebase in progress that poisons a later retry.
      const compileLadder = resolveSubsystemHarnessLadder(
        prefs.getAllPrefs(),
        "automations",
        harnessSelection.harness
      );
      let finalFailure: string | undefined;
      let failoverNotice: string | undefined;
      const completed = await findSequentially(
        compileLadder.entries(),
        async ([index, kind]) => {
          const selection =
            index === 0
              ? harnessSelection
              : resolveAutomationHarnessSelection(
                  { ...row.manifest.requires, harness: kind },
                  prefs.getAllPrefs(),
                  kind,
                  { includeManifestProviderPins: false }
                );
          const attemptRunId =
            index === 0 ? runId : `${runId}:failover:${index}:${kind}`;
          const runSuffix =
            attemptRunId.split(":").at(-1) ?? crypto.randomUUID().slice(0, 8);
          const sessionId = `compile-${parsed.appId}-${runSuffix}-${index}`;
          let attemptFailure: string | undefined;
          let attemptFailureClass: string | undefined;

          await runHeadlessAutomationCompile({
            runner: automationCompileRunner,
            ledgerDbFile: workspace.ledgerDbFile,
            harnessSessionDir: workspace.harnessSessionDir,
            dataDir: workspace.appsDir,
            appId: parsed.appId,
            draftSessionId: sessionId,
            automationRef,
            automationName: row.name,
            instructions: row.manifest.prompt,
            harnessKind: selection.harness,
            ...(selection.model ? { model: selection.model } : {}),
            ...(selection.configPins
              ? { configPins: selection.configPins }
              : {}),
            providerEgressConsent,
            consentSource:
              index === 0 && selection.selectionSource !== "manifest"
                ? "direct"
                : "ladder",
            hydrationAttachmentPath: (hash) =>
              conversationHistoryStore.blobPathFor(parsed.appId, hash),
            ...(failoverNotice ? { failoverNotice } : {}),
            anchors: anchorResolution.anchors,
            ...(anchorResolution.error
              ? { preflightError: anchorResolution.error }
              : {}),
            runId: attemptRunId,
            onSuccess: async () => {
              const appDir = await store.snapshotSessionAppDir(
                sessionId,
                parsed.appId
              );
              const manifestFile = path.join(
                appDir,
                "automations",
                parsed.automationId,
                automation.MANIFEST_FILE
              );
              const manifest = automation.parseManifest(
                await fs.readFile(manifestFile, "utf8")
              );
              const compiled = finalizeCompiledManifest(manifest, {
                enabledBeforeCompile,
                enableOnSuccess,
                anchoredScopes: anchorResolution.scopes,
              });
              await fs.writeFile(
                manifestFile,
                `${JSON.stringify(compiled, null, 2)}\n`
              );
              await publishAndReconcile(lifecycleOpts, {
                appId: parsed.appId,
                sessionId,
                appDir,
                message: `compile ${parsed.automationId}`,
                ephemeralSession: true,
              });
              health.reportOk("automation-runs", `Plan ready for ${row.name}`);
            },
            onFailure: async (error, failureClass) => {
              attemptFailure = error;
              attemptFailureClass = failureClass;
              await store.closeSession(sessionId).catch(() => undefined);
            },
          }).catch((error: unknown) => {
            attemptFailure =
              error instanceof Error ? error.message : String(error);
          });

          if (!attemptFailure) return true;
          finalFailure = attemptFailure;
          const next = compileLadder[index + 1];
          if (!attemptFailureClass || !next) return false;
          failoverNotice =
            `${kind} failed at the compile boundary (${attemptFailureClass}). ` +
            `Continuing with ${next}; provider-specific model and effort pins were cleared.`;
          onConversationRunnerFailover({
            conversationId: automationRef,
            subsystem: "automations",
            from: kind,
            to: next,
          });
          return false;
        }
      );
      if (completed) return { ok: true };

      const failure = finalFailure ?? "Compile failed without a diagnostic.";
      health.reportError(
        "automation-runs",
        `Compile failed for ${row.name}: ${failure}. Retry from the automation thread.`
      );
      logger.warn?.(`Headless compile failed for ${automationRef}: ${failure}`);
      if (row.manifest.onFailure) {
        const target = automation.parseRef(
          row.manifest.onFailure,
          parsed.appId
        );
        if (target) {
          await fireAutomation(`${target.appId}/${target.automationId}`, {
            triggerKind: "on_failure",
            triggerOrigin: "manual",
            input: {
              automationRef,
              compileRunId: runId,
              error: failure,
              phase: "compile",
            },
          });
        }
      }
      return { ok: false, error: failure };
    };

    const lifecycleOpts: LifecycleRouteOptions = {
      store,
      codeAppsDir,
      ...(paths.templatesCacheDir
        ? { templatesCacheDir: paths.templatesCacheDir }
        : {}),
      ensureRegistered: async (appId) => {
        await requireRuntime().registry.ensureUploaded(appId);
        vaultRegistry.enrollApp(appId);
        await grantDeclaredAppScopes(plane, store, appId);
      },
      deregister: deregisterAndCleanup,
      reconcile: () => {
        // Fire-and-forget on purpose: the reconciler already reports failures.
        // Awaited publish/start paths call `reconcileScheduler` directly so a
        // failed data-cursor bootstrap cannot look ready.
        void reconcileScheduler(vaultId).catch(() => undefined);
      },
      isBundledAppId,
      isSystemManagedAutomation: isSystemRecognitionRef,
      isSystemManagedApp: (appId) => recognitionTemplateIds.has(appId),
      installBundledApp: async (templateId) => {
        if (!bundledAppIds.has(templateId)) return undefined;
        const meta = await readBundledAppMeta(bundledAppDir(templateId));
        const alreadyInstalled = plane.installedAppIds().has(templateId);
        plane.installApp(templateId, meta.name);
        await requireRuntime().registry.ensureUploaded(templateId);
        await grantDeclaredBundledScopes(plane, templateId);
        return {
          id: templateId,
          ...(meta.name === undefined ? {} : { name: meta.name }),
          ...(meta.description === undefined
            ? {}
            : { description: meta.description }),
          ...(meta.iconKey === undefined ? {} : { iconKey: meta.iconKey }),
          ...(meta.colorKey === undefined ? {} : { colorKey: meta.colorKey }),
          alreadyInstalled,
        };
      },
      // Bundled code is read-only, so the name lands on the enrollment record
      // (#434); false lets the meta route fall through to app.json.
      renameBundledApp: (appId, name) => {
        if (!bundledAppIds.has(appId) || !plane.installedAppIds().has(appId))
          return false;
        plane.setAppLabel(appId, name);
        return true;
      },
      ext,
      compileAutomation: (input) => {
        trackDetachedAutomationTask(
          runAutomationCompileTask(input).then(() => undefined),
          `compile ${input.automationRef}`
        );
      },
      reviseAutomation: ({ row, steering, revisionTurnId, compileTurnId }) => {
        const parsed = automation.parseRef(row.ref);
        if (!parsed) return;
        let revisionHarness: HarnessKind | undefined;
        const reportCompileTurn = (
          error: string,
          labels?: { note: string }
        ): void => {
          recordFailedAutomationCompile({
            ledgerDbFile: workspace.ledgerDbFile,
            automationRef: row.ref,
            appId: row.ownerApp,
            automationName: row.name,
            runId: labels
              ? `${row.ref}:revert:${crypto.randomUUID().slice(0, 8)}`
              : compileTurnId,
            error,
            ...(labels ? { note: labels.note, summary: labels.note } : {}),
            ...(revisionHarness ? { harnessKind: revisionHarness } : {}),
          });
        };
        const task = reviseAutomationInstructions({
          row,
          conversationLocks: automationConversationLocks,
          publishPrompt: async (prompt, message) => {
            const sessionId = `revise-${parsed.appId}-${crypto.randomUUID().slice(0, 8)}`;
            await prepareLifecycleSession(store, sessionId, true);
            const appDir = await store.snapshotSessionAppDir(
              sessionId,
              parsed.appId
            );
            const manifestPath = path.join(
              appDir,
              "automations",
              parsed.automationId,
              automation.MANIFEST_FILE
            );
            const existing = automation.parseManifest(
              await fs.readFile(manifestPath, "utf8")
            );
            const revised = automation.validateManifest({
              ...existing,
              prompt,
            });
            await stageAndMaybePublish(lifecycleOpts, {
              appId: parsed.appId,
              sessionId,
              files: [
                {
                  path: `automations/${parsed.automationId}/${automation.MANIFEST_FILE}`,
                  content: `${JSON.stringify(revised, null, 2)}\n`,
                },
              ],
              publish: true,
              message: `${message} ${parsed.automationId}`,
              ephemeralSession: true,
            });
          },
          rewrite: async (persistPrompt) => {
            const harnessSelection = await resolveAutomationHarness(
              row.manifest.requires
            );
            revisionHarness = harnessSelection.harness;
            const harnessPrefs = await prefsLoader(
              "automations",
              harnessSelection.harness
            );
            if (!harnessPrefs)
              throw new Error("No automation harness is configured.");
            const configuredRewrite =
              prefs.getAllPrefs()[`model.${harnessSelection.harness}.rewrite`];
            const catalog = resolveCatalogModels
              ? await resolveCatalogModels(harnessSelection.harness, false)
              : { list: [] };
            const fastModel = catalog.list.find(
              (model) => model.tier === "fast"
            )?.id;
            const rewriteModel = resolveAutomationRewriteModel(
              row.manifest.requires,
              harnessSelection,
              configuredRewrite,
              fastModel
            );
            await rewriteAutomationInstructions({
              row,
              steering,
              revisionTurnId,
              ledgerDbFile: workspace.ledgerDbFile,
              harnessSessionDir: workspace.harnessSessionDir,
              runTurn: accountedRunTurn,
              harnessPrefs,
              // Steering is an ATTENDED owner action. The conversation row is
              // ensured before TurnPlane asks for this proof, so the durable
              // direct grant is FK-safe and rechecked at the door.
              egressConsent: () => {
                providerEgressConsent.grant(
                  row.ref,
                  harnessPrefs.kind,
                  "direct"
                );
                return providerEgressConsent.has(row.ref, harnessPrefs.kind);
              },
              ...(rewriteModel ? { model: rewriteModel } : {}),
              persistPrompt,
            });
          },
          compile: () =>
            runAutomationCompileTask({
              automationRef: row.ref,
              runId: compileTurnId,
              enableOnSuccess: false,
            }),
          onRolledBack: (detail) => {
            reportCompileTurn(detail, { note: "Instructions rolled back" });
            health.reportError(
              "automation-runs",
              `Revision rolled back for ${row.name}: ${detail}`
            );
            logger.warn?.(
              `Instruction revision rolled back for ${row.ref}: ${detail}`
            );
          },
          onFailed: (message) => {
            reportCompileTurn(`Instruction revision failed: ${message}`);
            runEventBus.publish(compileTurnId, {
              type: "turn.start",
              turnId: compileTurnId,
            });
            runEventBus.publish(compileTurnId, {
              type: "turn.end",
              turnId: compileTurnId,
              ok: false,
              error: `Instruction revision failed: ${message}`,
            });
            health.reportError(
              "automation-runs",
              `Revision failed for ${row.name}: ${message}`
            );
            logger.warn?.(
              `Instruction revision failed for ${row.ref}: ${message}`
            );
          },
        });
        trackDetachedAutomationTask(task, `revise ${row.ref}`);
      },
    };

    // Mount-time materialization runs BEFORE this host reaches `settledHosts`,
    // so it must not call the runtime-registration callbacks that resolve code
    // back through that map; the mount loop registers every new recipe.
    const systemInstallLifecycleOpts: LifecycleRouteOptions = {
      store,
      codeAppsDir,
      ensureRegistered: async () => undefined,
      deregister: async () => undefined,
      reconcile: () => undefined,
      ext,
      isSystemManagedApp: (appId) => recognitionTemplateIds.has(appId),
    };
    const ensureSystemRecognitionRecipe = async (
      template: (typeof systemRecognitionTemplates)[number],
      existing: Set<string>
    ): Promise<void> => {
      const templateFiles = await readTemplateFiles(template);
      const manifestPath = `automations/${template.id}/${automation.MANIFEST_FILE}`;
      const manifestFile = templateFiles.find(
        (file) => file.path === manifestPath
      );
      if (!manifestFile)
        throw new Error(
          `bundled recognition recipe ${template.id} has no ${manifestPath}`
        );
      const desired = automation.parseManifest(manifestFile.content);
      const current = existing.has(template.id)
        ? await automation
            .readAppOwned(codeAppsDir(), template.id, template.id)
            .catch(() => undefined)
        : undefined;
      const preservedRequires = current
        ? Object.fromEntries(
            (["harness", "model", "thoughtLevel"] as const).flatMap((key) =>
              current.manifest.requires[key] === undefined
                ? []
                : [[key, current.manifest.requires[key]]]
            )
          )
        : {};
      const currentVariant = current?.manifest.enrich?.delegateStep?.selected;
      const merged = automation.validateManifest({
        ...desired,
        enabled: current?.enabled ?? desired.enabled,
        requires: { ...desired.requires, ...preservedRequires },
        ...(desired.enrich
          ? {
              enrich: {
                ...desired.enrich,
                ...(desired.enrich.delegateStep
                  ? {
                      delegateStep: {
                        ...desired.enrich.delegateStep,
                        selected:
                          currentVariant ??
                          desired.enrich.delegateStep.selected,
                      },
                    }
                  : {}),
              },
            }
          : {}),
      });
      const files = templateFiles.map((file) =>
        file.path === manifestPath
          ? {
              ...file,
              content: `${JSON.stringify(merged, null, 2)}\n`,
            }
          : file
      );
      const activeDir = existing.has(template.id)
        ? await store.resolveActiveAppDir(template.id)
        : undefined;
      const currentFiles = activeDir ? await readFileMap(activeDir) : [];
      const sameFiles =
        currentFiles.length === files.length &&
        files.every((file) =>
          currentFiles.some(
            (candidate) =>
              candidate.path === file.path && candidate.content === file.content
          )
        );
      if (sameFiles) return;
      const sessionId = `system-recognition-${template.id}`;
      await prepareLifecycleSession(store, sessionId, true);
      // Release-owned recipes are EXACT snapshots: clearing the app dir drops
      // stale helpers from an older version. Owner state was merged above.
      const sessionAppDir = await store.snapshotSessionAppDir(
        sessionId,
        template.id
      );
      await fs.rm(sessionAppDir, { recursive: true, force: true });
      await stageAndMaybePublish(systemInstallLifecycleOpts, {
        appId: template.id,
        sessionId,
        files,
        publish: true,
        message: `${existing.has(template.id) ? "upgrade" : "install"} bundled recognition recipe ${template.id}`,
        ephemeralSession: true,
      });
      existing.add(template.id);
    };
    const ensureSystemRecognitionRecipes = async (): Promise<void> => {
      const existing = new Set(await store.listApps());
      for (const template of systemRecognitionTemplates) {
        // oxlint-disable-next-line no-await-in-loop -- lifecycle publication shares one store and must preserve the bundled template order
        await ensureSystemRecognitionRecipe(template, existing);
      }
    };

    const handlers: RouteHandler[] = [
      makeAppsStoreRouteHandler(store, {
        isReadOnlyApp: (appId) => recognitionTemplateIds.has(appId),
        onAppLive: async (appId) => {
          await requireRuntime().registry.ensureUploaded(appId);
          vaultRegistry.enrollApp(appId);
          await grantDeclaredAppScopes(plane, store, appId);
          await reconcileScheduler(vaultId);
        },
        onAppDeleted: async (appId) => {
          await deregisterAndCleanup(appId);
          await reconcileScheduler(vaultId);
        },
        // BUNDLED ONLY. `access_app.origin` is a one-value vocabulary since
        // #916 (ruling ONT-07), so the enrollment row no longer says whether
        // an app came with Centraid or was written in the app store — the
        // bundle manifest does. Without this filter a store app's own
        // `app.json` identity is shadowed by a bundled row that has none.
        bundledApps: async () =>
          Promise.all(
            plane
              .installedApps()
              .filter(({ name }) => bundledAppIds.has(name))
              .map(async ({ name, label }) => {
                const meta = await readBundledAppMeta(bundledAppDir(name));
                return {
                  id: name,
                  name: label ?? meta.name ?? name,
                  ...(meta.description === undefined
                    ? {}
                    : { description: meta.description }),
                  kind: "app" as const,
                  ...(meta.iconKey === undefined
                    ? {}
                    : { iconKey: meta.iconKey }),
                  ...(meta.colorKey === undefined
                    ? {}
                    : { colorKey: meta.colorKey }),
                };
              })
          ),
        ext,
      }),
      makeLifecycleRouteHandler(lifecycleOpts),
      makeAutomationsRouteHandler({
        store,
        ledgerDbFile: workspace.ledgerDbFile,
        analytics: analyticsStore,
        insights: insightsStore,
        runAutomation: ({ automationRef, turnId }) => {
          void fireAutomation(automationRef, {
            runId: turnId,
            triggerKind: "manual",
            triggerOrigin: "manual",
          });
        },
        invokeAndAwait: ({ automationRef, turnId, payload }) =>
          fireAutomation(automationRef, {
            runId: turnId,
            triggerKind: "manual",
            triggerOrigin: "manual",
            input: payload,
            propagateError: true,
          }),
        subscribeTurnEvents: (turnId, listener) =>
          runEventBus.subscribe(turnId, listener),
        runInteractiveTurn: async ({
          row,
          turnId,
          message,
          providerConsent,
          harnessKind,
          model,
          thinking,
          attachmentRefs,
          abortSignal,
          onEvent,
        }) => {
          const selected = harnessKind
            ? resolveAutomationHarnessSelection(
                { harness: harnessKind },
                prefs.getAllPrefs(),
                harnessKind,
                { includeManifestProviderPins: false }
              )
            : await resolveAutomationHarness(row.manifest.requires);
          const validatedAttachmentRefs = validateTurnAttachmentRefs(
            conversationHistoryStore,
            row.ownerApp,
            attachmentRefs ?? []
          );
          const turnAttachments = validatedAttachmentRefs.map((attachment) => ({
            path: conversationHistoryStore.blobPathFor(
              row.ownerApp,
              attachment.hash
            ),
            mime: attachment.mime,
            ...(attachment.filename ? { filename: attachment.filename } : {}),
          }));
          const configPins = {
            ...selected.configPins,
            ...(thinking ? { thought_level: thinking } : {}),
          };
          await runInteractiveAutomationTurn({
            row,
            turnId,
            message,
            ledgerDbFile: workspace.ledgerDbFile,
            harnessSessionDir: workspace.harnessSessionDir,
            runner: automationConversationRunnerFor(
              executionScopeBlock(row.manifest.vault)
            ),
            harnessKind: selected.harness,
            ...((model ?? selected.model)
              ? { model: model ?? selected.model }
              : {}),
            ...(Object.keys(configPins).length > 0 ? { configPins } : {}),
            ...(providerConsent ? { providerConsent } : {}),
            ...(validatedAttachmentRefs.length
              ? {
                  attachmentRefs: validatedAttachmentRefs.map((attachment) => ({
                    hash: attachment.hash,
                    mime: attachment.mime,
                    sizeBytes: attachment.sizeBytes ?? 0,
                    ...(attachment.filename
                      ? { filename: attachment.filename }
                      : {}),
                  })),
                  turnAttachments,
                }
              : {}),
            hydrationAttachmentPath: (hash) =>
              conversationHistoryStore.blobPathFor(row.ownerApp, hash),
            artifactRoots: [
              workspace.appsDir,
              path.join(store.getActiveMainLink(), "apps", row.ownerApp),
            ],
            uploadInlineArtifact: (bytes) =>
              conversationHistoryStore.uploadBlob(row.ownerApp, bytes),
            abortSignal,
            conversationLocks: automationConversationLocks,
            onEvent,
            onTurnEvent: (event) => runEventBus.publish(turnId, event),
          });
        },
      }),
    ];

    return {
      vaultId,
      store,
      codeAppsDir,
      draftCodeDir,
      runner,
      ensureSystemRecognitionRecipes,
      handlers,
    };
  }

  // ── Schedulers (issue #149, #289) ─────────────────────────────────────
  // One persistent in-process scheduler PER VAULT; `reconcileScheduler` settles
  // that vault's registry off ITS `main`, coalesced so concurrent publishes
  // don't thrash it. Scheduled fires enter their vault's ambient scope.
  const schedulers = new Map<string, automation.LocalScheduler>();
  const triggerStores = new Map<string, AutomationTriggerStore>();
  const reconcileStates = new Map<
    string,
    { inFlight?: Promise<void>; dirty: boolean }
  >();
  let schedulersStarted = false;

  const triggerStoreFor = (vaultId: string): AutomationTriggerStore => {
    const existing = triggerStores.get(vaultId);
    if (existing) return existing;
    const plane = vaultRegistry.get(vaultId);
    if (!plane) throw new Error(`gateway: unknown vault "${vaultId}"`);
    const store = new AutomationTriggerStore(
      makeLedgerDbProvider(plane.workspace.ledgerDbFile)
    );
    triggerStores.set(vaultId, store);
    return store;
  };

  const parseEventCursor = (
    positionJson: string | undefined
  ): { provider?: unknown; ingressId: number } => {
    if (!positionJson) return { ingressId: 0 };
    try {
      const parsed = JSON.parse(positionJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { ingressId: 0 };
      }
      const row = parsed as Record<string, unknown>;
      const ingressId = Number(row.ingressId);
      return {
        ...(row.provider === undefined ? {} : { provider: row.provider }),
        ingressId:
          Number.isSafeInteger(ingressId) && ingressId >= 0 ? ingressId : 0,
      };
    } catch {
      return { ingressId: 0 };
    }
  };

  const gmailConnectBaseline = (
    vaultId: string,
    connectionId: string
  ): unknown => {
    const plane = vaultRegistry.get(vaultId);
    const row = plane?.db.vault
      .prepare(
        `SELECT value_json
           FROM sync_connection_cursor
          WHERE connection_id = ? AND key = 'gmail_history_id'`
      )
      .get(connectionId) as { value_json: string } | undefined;
    if (!row) return undefined;
    try {
      const value = JSON.parse(row.value_json) as { id?: unknown };
      return typeof value.id === "string"
        ? { provider: "gmail", historyId: value.id }
        : undefined;
    } catch {
      return undefined;
    }
  };

  /**
   * Extends the engine's `eventSourceKey` with the bound connection id and a
   * filter digest: two automations on the same connector kind must NOT share
   * one `trigger_ingress` lane, or a multi-account connector delivers account
   * A's events to account B's automation.
   */
  const eventIngressKey = (
    connectionId: string,
    trigger: Extract<automation.Trigger, { kind: "event" }>
  ): string => {
    const filterHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(trigger.filter ?? {}))
      .digest("hex")
      .slice(0, 16);
    return `${automation.eventSourceKey(trigger)}:${connectionId}:${filterHash}`;
  };

  const readTriggerCursor = async (
    vaultId: string,
    input: automation.TriggerCursorReadInput
  ): Promise<automation.CursorReadResult> => {
    const parsed = automation.parseRef(input.automationRef);
    if (!parsed)
      throw new Error(`invalid automation ref "${input.automationRef}"`);
    const row = await automation.readAppOwned(
      settledHostFor(vaultId).codeAppsDir(),
      parsed.appId,
      parsed.automationId
    );
    if (!row || !row.enabled) {
      return {
        elements: [],
        ...(input.cursor?.positionJson
          ? { positionJson: input.cursor.positionJson }
          : {}),
      };
    }
    const trigger = row.manifest.triggers[input.triggerIndex];
    if (!trigger || trigger.kind !== input.trigger.kind) {
      return { elements: [] };
    }
    if (trigger.kind === "webhook") {
      if (!("secretHash" in trigger)) return { elements: [] };
      return readIngressCursor(
        triggerStoreFor(vaultId),
        trigger.id,
        input.cursor?.positionJson,
        input.limit,
        input.now.getTime()
      );
    }
    if (trigger.kind === "event") {
      const connection = row.manifest.connections?.find(
        (binding) => binding.kind === trigger.connectorKind
      );
      if (!connection) {
        throw new Error(
          `event trigger ${input.automationRef}[${input.triggerIndex}] has no bound ${trigger.connectorKind} connection`
        );
      }
      const position = parseEventCursor(input.cursor?.positionJson);
      const initialProvider =
        position.provider ??
        (trigger.connectorKind === "pull.gmail"
          ? gmailConnectBaseline(vaultId, connection.connectionId)
          : undefined);
      const polled = await pollProviderEventSource({
        trigger,
        connection,
        ...(initialProvider === undefined ? {} : { cursor: initialProvider }),
        now: input.now,
        limit: input.limit + 1,
        pollJson: (binding, url, headers) =>
          connectionBroker.pollJson(binding, url, headers),
      });
      const store = triggerStoreFor(vaultId);
      const sourceKey = eventIngressKey(connection.connectionId, trigger);
      for (const event of polled.events) {
        store.appendIngress({
          source: "poll",
          sourceKey,
          deliveryId: event.id,
          receivedAt: event.occurredAt,
          payloadJson: JSON.stringify(event.payload),
          expiresAt: input.now.getTime() + 72 * 60 * 60 * 1000,
        });
      }
      const retention = ingressRetentionGap(
        store.pruneIngress(input.now.getTime()),
        sourceKey,
        position.ingressId
      );
      const records = store.listIngressAfter(
        sourceKey,
        position.ingressId,
        input.limit
      );
      // The ingress half of this position only ever advances to the last row
      // actually handed back; rows past the cap ride the next tick — surplus,
      // not a gap. `polled.skipped` still counts: a provider page limit or an
      // expired history IS unrecoverable, since the source no longer holds it.
      const deliveredId = records.at(-1)?.id ?? position.ingressId;
      const skipped = (polled.skipped ?? 0) + (retention?.skipped ?? 0);
      const gapReason = polled.gapReason ?? retention?.gapReason;
      return {
        elements: records.map(ingressElement),
        positionJson: JSON.stringify({
          provider: polled.cursor,
          ingressId: deliveredId,
        }),
        ...(skipped ? { skipped } : {}),
        ...(gapReason ? { gapReason } : {}),
      };
    }
    if (!row.manifest.vault) {
      return {
        elements: [],
        ...(input.cursor?.positionJson
          ? { positionJson: input.cursor.positionJson }
          : {}),
      };
    }
    const common = {
      automationRef: input.automationRef,
      vault: vaultRegistry.agentBridgeFor(
        parsed.appId,
        executionScopeBlock(row.manifest.vault)
      ),
      ...(input.cursor?.positionJson
        ? { positionJson: input.cursor.positionJson }
        : {}),
      limit: input.limit,
      now: input.now,
    };
    if (trigger.kind === "condition") {
      return automation.readConditionCursor({ ...common, trigger });
    }
    if (trigger.kind === "data") {
      return automation.readDataCursor({ ...common, trigger });
    }
    return { elements: [] };
  };

  const gapNote = (
    input: automation.TriggerCursorFireInput
  ): string | undefined => {
    if (input.skipped <= 0) return undefined;
    const window =
      input.windowFrom !== undefined && input.windowTo !== undefined
        ? ` in ${new Date(input.windowFrom).toISOString()}–${new Date(input.windowTo).toISOString()}`
        : "";
    return `Trigger cursor skipped ${input.skipped} source element${input.skipped === 1 ? "" : "s"}${window} (${input.gapReason ?? "catch-up cap"}).`;
  };

  const fireTriggerCursor = async (
    input: automation.TriggerCursorFireInput
  ): Promise<void> => {
    const trigger = input.trigger;
    let payload: unknown;
    if (trigger.kind === "condition") {
      payload = {
        trigger: {
          kind: "condition",
          index: input.triggerIndex,
          entity: trigger.entity,
        },
        rows: [input.element.payload],
      };
    } else if (trigger.kind === "data") {
      payload = {
        trigger: {
          kind: "data",
          index: input.triggerIndex,
          entities: trigger.entities,
        },
        changes: [input.element.payload],
      };
    } else if (trigger.kind === "webhook") {
      payload = input.element.payload;
    } else if (trigger.kind === "event") {
      payload = {
        trigger: {
          kind: "event",
          index: input.triggerIndex,
          connectorKind: trigger.connectorKind,
          event: trigger.event,
        },
        event: input.element.payload,
      };
    }
    const sourceTurnId = crypto
      .createHash("sha256")
      .update(
        `${input.automationRef}\u0000${input.triggerIndex}\u0000${input.sourceKind}\u0000${input.element.position}`
      )
      .digest("hex")
      .slice(0, 24);
    await fireAutomation(input.automationRef, {
      runId: `${input.automationRef}:trigger:${sourceTurnId}`,
      triggerKind: "scheduled",
      triggerOrigin: input.sourceKind,
      idempotent: true,
      propagateError: true,
      ...(payload === undefined ? {} : { input: payload }),
      ...(gapNote(input) ? { note: gapNote(input) } : {}),
    });
  };

  const schedulerFor = (vaultId: string): automation.LocalScheduler => {
    const existing = schedulers.get(vaultId);
    if (existing) return existing;
    const created: automation.LocalScheduler =
      // An injected scheduler belongs to the DEFAULT vault, in whatever order
      // it mounts. The id check alone bounds it to one vault; adding a
      // `schedulers.size === 0` co-condition would silently drop the injection.
      options.scheduler && vaultId === vaultRegistry.defaultVaultId()
        ? options.scheduler
        : new automation.InProcessScheduler({
            fire: (ref) =>
              runWithVaultContext({ vaultId }, () =>
                fireAutomation(ref, {
                  triggerKind: "scheduled",
                  triggerOrigin: "cron",
                }).then(() => undefined)
              ),
            store: triggerStoreFor(vaultId),
            readCursor: (input) =>
              runWithVaultContext({ vaultId }, () =>
                readTriggerCursor(vaultId, input)
              ),
            fireCursor: (input) =>
              runWithVaultContext({ vaultId }, () => fireTriggerCursor(input)),
            onError: (err, ref) => {
              const message =
                `scheduled ${ref} failed: ` +
                (err instanceof Error ? err.message : String(err));
              health.reportError("automation-runs", message);
              logger.warn(message);
            },
            // Liveness ONLY: source position and gap truth live solely in
            // `automation_trigger_cursor`.
            onTick: (at) => schedulerLedgerFor(vaultId).recordTick(at),
            onDormancyChange: (dormant, at) =>
              runWithVaultContext({ vaultId }, () => {
                schedulerLedgerFor(vaultId).setDormant(dormant, at);
              }),
            defaultCronTimeZone: () => {
              const raw =
                prefs.getAllPrefs()[automation.CRON_DEFAULT_TIMEZONE_PREF];
              return typeof raw === "string" && raw.trim()
                ? raw.trim()
                : undefined;
            },
          });
    schedulers.set(vaultId, created);
    if (schedulersStarted) created.start();
    return created;
  };

  // Coalesced per vault (#647): the LEADING edge fires immediately so a lone
  // write feels instant, and a burst collapses to one recomputation.
  const fireNotificationsDoorbell = (vaultId: string): void => {
    notificationsEvents.publish(vaultId);
    const decisions = vaultRegistry
      .get(vaultId)
      ?.notificationsSummary().decisions;
    if (
      decisions &&
      notificationsDecisionWake.observe(
        vaultId,
        notificationsDecisionKeys(decisions)
      )
    )
      requestNotificationsWake(vaultId);
  };
  const armNotificationsDoorbellWindow = (vaultId: string): void => {
    const timer = setTimeout(() => {
      const open = notificationsDoorbellWindows.get(vaultId);
      notificationsDoorbellWindows.delete(vaultId);
      if (!open?.pending) return;
      fireNotificationsDoorbell(vaultId);
      armNotificationsDoorbellWindow(vaultId);
    }, notificationsDoorbellWindowMs);
    unrefTimer(timer);
    notificationsDoorbellWindows.set(vaultId, { timer, pending: false });
  };
  const ringNotificationsDoorbell = (vaultId: string): void => {
    const open = notificationsDoorbellWindows.get(vaultId);
    if (open) {
      open.pending = true;
      return;
    }
    fireNotificationsDoorbell(vaultId);
    armNotificationsDoorbellWindow(vaultId);
  };

  const grantFulfillmentHost = {
    vaultFor: (vaultId: string) => vaultRegistry.get(vaultId)?.db,
    logger: health.loggerFor("share", logger),
  };
  // View grants sync forward (ruling G-view). The doorbell swallows its own
  // failures: an uncarried share is durable state on the fulfillment rows,
  // never a reason for the triggering write to look failed.
  const grantRefreshDoorbell = createGrantRefreshDoorbell({
    host: grantFulfillmentHost,
  });

  provenanceDoorbell = (vaultId, entityTypes) => {
    ringNotificationsDoorbell(vaultId);
    // The commit's entity types are the delivery loop's filter (ruling
    // V-delivery): a commit that cannot have moved a granted subject wakes
    // nothing. `undefined` would mean "walk everything", so the hint is passed
    // through even when it is empty.
    grantRefreshDoorbell.ring(vaultId, entityTypes ?? []);
    runWithVaultContext({ vaultId }, () =>
      schedulers.get(vaultId)?.nudge(entityTypes)
    );
  };

  const reconcileScheduler = (vaultId: string): Promise<void> => {
    const sched = schedulerFor(vaultId);
    let state = reconcileStates.get(vaultId);
    if (!state) {
      state = { dirty: false };
      reconcileStates.set(vaultId, state);
    }
    if (state.inFlight) {
      state.dirty = true;
      return state.inFlight;
    }
    const settled = state;
    const work = runWithVaultContext({ vaultId }, async () => {
      const reconcileUntilClean = async (): Promise<void> => {
        settled.dirty = false;
        const { rows } = await automation.list(
          settledHostFor(vaultId).codeAppsDir()
        );
        const plane = vaultRegistry.get(vaultId);
        const nameByOwnerApp = new Map(rows.map((r) => [r.ownerApp, r.name]));
        for (const appId of new Set(rows.map((r) => r.ownerApp))) {
          try {
            vaultRegistry.enrollAutomationAgent(
              appId,
              nameByOwnerApp.get(appId)
            );
          } catch (error) {
            logger.warn(
              `vault plane: agent enrollment for "${appId}" failed: ` +
                (error instanceof Error ? error.message : String(error))
            );
          }
        }
        for (const row of rows) {
          const block = manifestScopeBlock(row.manifest.vault);
          if (!block || !plane) continue;
          try {
            plane.ensureAgentInstallGrant(row.ownerApp, block);
          } catch (error) {
            logger.warn(
              `install-time grant for automation "${row.ownerApp}" failed: ` +
                (error instanceof Error ? error.message : String(error))
            );
          }
        }
        // A disabled recognition recipe stays a durable app row for its
        // toggle, but must NOT hold a scheduler registration or bootstrap a
        // data cursor. Ordinary disabled automations stay in `rows` so their
        // cursor retention semantics are unchanged.
        const schedulerRows = rows.filter((row) =>
          recognitionTemplateIds.has(row.ownerApp)
            ? row.enabled
            : // With the gate off, user automations never arm while
              // recognition recipes keep the photos pipeline flowing.
              experimental.automations
        );
        const diff = await sched.reconcile(schedulerRows);
        if (diff.added.length || diff.updated.length || diff.removed.length) {
          logger.info(
            `scheduler reconcile (vault ${vaultId}) — ` +
              `added=${diff.added.length} updated=${diff.updated.length} removed=${diff.removed.length}`
          );
        }
        if (settled.dirty) return reconcileUntilClean();
      };
      await reconcileUntilClean();
    });
    settled.inFlight = work
      .then(() =>
        health.reportOk(
          "automations",
          `scheduler${schedulers.size === 1 ? "" : "s"} running for ${schedulers.size} vault${schedulers.size === 1 ? "" : "s"}`
        )
      )
      .catch((error) => {
        const message =
          `scheduler reconcile failed: ` +
          (error instanceof Error ? error.message : String(error));
        health.reportError("automations", message);
        logger.warn(message);
        throw error;
      })
      .finally(() => {
        settled.inFlight = undefined;
      });
    return settled.inFlight;
  };

  // ── Webhook trigger route (issue #96) ─────────────────────────────────
  // `makeWebhookRouteHandler` closes over ONE `appsDir`, so one instance is
  // built per vault and a pre-scan delegates the WHOLE request to the owning
  // vault — auth, rate limit, body cap and response shape are never
  // reimplemented here.
  const webhookHandlers = new Map<string, RouteHandler>();

  const webhookIngress = async (
    vaultId: string,
    input: Parameters<automation.WebhookIngressFn>[0]
  ): Promise<automation.WebhookIngressResult> => {
    const plane = vaultRegistry.get(vaultId);
    if (!plane) return { accepted: false, error: `unknown vault "${vaultId}"` };
    try {
      const bodyJson = JSON.stringify(input.body ?? null);
      const result = triggerStoreFor(vaultId).appendIngress({
        source: "webhook",
        sourceKey: input.webhookId,
        deliveryId: input.deliveryId,
        receivedAt: input.receivedAt,
        payloadJson: bodyJson,
        expiresAt: input.receivedAt + 72 * 60 * 60 * 1000,
      });
      triggerStoreFor(vaultId).pruneIngress(Date.now());
      const scheduler = schedulerFor(vaultId);
      scheduler.nudgeIngress?.(input.webhookId);
      return {
        accepted: true,
        ...(result.inserted ? {} : { duplicate: true }),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      health.reportError(
        "automation-runs",
        `webhook ingress ${input.automationRef}: ${message}`
      );
      return { accepted: false, error: message };
    }
  };

  const webhookHandlerForVault = (vaultId: string): RouteHandler => {
    const existing = webhookHandlers.get(vaultId);
    if (existing) return existing;
    const handler = automation.makeWebhookRouteHandler({
      appsDir: settledHostFor(vaultId).codeAppsDir(),
      ingress: (input) => webhookIngress(vaultId, input),
    });
    webhookHandlers.set(vaultId, handler);
    return handler;
  };

  const webhookHandler: RouteHandler = async (req, res) => {
    if (!req.url || !req.url.startsWith(automation.WEBHOOK_ROUTE_PREFIX))
      return false;
    // Gate off: fall through to not-found rather than accepting a dead
    // trigger.
    if (!experimental.automations) return false;
    const url = new URL(req.url, "http://x");
    const slug = url.pathname
      .slice(automation.WEBHOOK_ROUTE_PREFIX.length)
      .replace(/^\/+/u, "")
      .replace(/\/+$/u, "");
    const isPost = (req.method ?? "GET").toUpperCase() === "POST";
    const looksLikeSlug = /^[A-Za-z0-9_-]+$/u.test(slug);
    let targetVaultId = vaultRegistry.defaultVaultId();
    if (isPost && looksLikeSlug) {
      const matchingPlane = await findSequentially(
        vaultRegistry.planesList(),
        async (plane) => {
          const host = settledHosts.get(plane.boot.vaultId);
          if (!host) return false; // not yet mounted — nothing to match there
          const { rows } = await automation.list(host.codeAppsDir());
          return rows.some(
            (row) => automation.webhookTriggerOf(row.triggers)?.id === slug
          );
        }
      );
      if (matchingPlane) targetVaultId = matchingPlane.boot.vaultId;
    }
    return webhookHandlerForVault(targetVaultId)(req, res);
  };

  const turnLimiters = new Map<string, TurnLimiter>();
  const turnLimiterForCurrentVault = (): TurnLimiter => {
    const id = vaultRegistry.current().boot.vaultId;
    let limiter = turnLimiters.get(id);
    if (!limiter) {
      limiter = new TurnLimiter();
      turnLimiters.set(id, limiter);
    }
    return limiter;
  };

  // ── The runtime ───────────────────────────────────────────────────────
  const runtime = new Runtime({
    appsDir: () => currentWorkspace().appsDir,
    timeModuleUrl: TIME_ENGINE_MODULE_URL,
    userStore: prefs,
    conversationHistoryStore,
    conversationRunner: {
      runKind: "build",
      run: async (input) => {
        // An explicit `input.model` always wins. Neither runner PICKS a
        // harness at construction — each carries a subsystem tag and calls
        // `prefsLoader(subsystem)` per turn, so the model key and the backend
        // that receives it cannot disagree, and a re-pin needs no restart.
        const subsystem: ModelSubsystem =
          input.register === "ask" ? "ask" : "builder";
        const model = await resolveModel(
          subsystem,
          input.model,
          input.harnessKind
        );
        const resolvedInput =
          model === input.model ? input : { ...input, model };
        if (input.register === "ask") return askRunner.run(resolvedInput);
        return (await currentVaultHost()).runner.run(resolvedInput);
      },
    },
    conversationHarnessSessionDir: () => currentWorkspace().harnessSessionDir,
    harnessStatus: async (statusOpts) => {
      const harnessPrefs = await prefsLoader();
      if (!harnessPrefs) {
        return {
          kind: "none" as const,
          ok: false,
          reason: "No harness configured.",
          hint: "Open Settings → Agents and pick Codex or Claude Code.",
        };
      }
      const status = await runPreflight(
        harnessPrefs,
        catalogPath ? { catalogPath } : {}
      );
      if (catalogPath && warmer && status.ok) {
        const count = status.models?.length ?? 0;
        if ((statusOpts?.refresh ?? false) || count === 0)
          void warmer.warm(harnessPrefs.kind, "models");
        status.modelsStatus = deriveStatus(
          count,
          warmer.isWarming(harnessPrefs.kind, "models")
        );
      }
      return status;
    },
    logger,
    codeDirOverride: async (appId: string) => {
      if (
        bundledAppIds.has(appId) &&
        vaultRegistry.current().installedAppIds().has(appId)
      ) {
        return bundledAppDir(appId);
      }
      return (await currentVaultHost()).store.resolveActiveAppDir(appId);
    },
    draftCodeDir: async (appId: string, sessionId: string) =>
      (await currentVaultHost()).draftCodeDir(appId, sessionId),
    // Not a listing despite the name: `turn-routes` calls it per turn and RUNS
    // in the root it picks. Opening the editing session here is load-bearing —
    // deferring it makes the first builder turn run in the published `app` dir
    // instead of the user's worktree.
    conversationWorkspaceRoots: async (appId: string) => {
      const plane = vaultRegistry.current();
      const host = await currentVaultHost();
      const app =
        bundledAppIds.has(appId) && plane.installedAppIds().has(appId)
          ? bundledAppDir(appId)
          : await host.store.resolveActiveAppDir(appId);
      const sessionId = options.sessionIdFor?.(appId) ?? `chat-${appId}`;
      await ensureSession(host.store, sessionId);
      const draft = await host.draftCodeDir(appId, sessionId);
      return {
        "vault-data": plane.dir,
        ...(app ? { app } : {}),
        ...(draft ? { draft } : {}),
      };
    },
    vaultFor: (appId: string) => vaultRegistry.bridgeFor(appId),
    askModel: askModelPrefs,
    turnLimiter: turnLimiterForCurrentVault,
  });

  runtimeRef = runtime;

  const assistantRunner = makeAssistantConversationRunner({
    prefsLoader,
    subsystem: "assistant",
    getDispatcher,
    vaults: vaultRegistry,
    runTurn: accountedRunTurn,
    harnessLadder,
    harnessHealth,
    harnessHealthContext,
    providerEgressConsent,
    onFailover: onConversationRunnerFailover,
  });

  // Fire-and-forget: a title miss never touches the turn (#420). Runs at the
  // `fast` capability TIER, never a hardcoded model id (governance
  // no-hardcoded-model-ids), overridable via `model.<harnessKind>.title`.
  const generateAssistantTitle = (args: {
    conversationId: string;
    userMessage: string;
    assistantText: string;
  }): void => {
    void (async () => {
      try {
        if (turnLimiterForCurrentVault().atCapacity()) return;
        const harnessPrefs = await prefsLoader();
        if (!harnessPrefs) return;
        if (
          !providerEgressConsent.has(
            args.conversationId,
            harnessPrefs.kind,
            "assistant"
          )
        )
          return;
        const slot = prefs.getAllPrefs()[`model.${harnessPrefs.kind}.title`];
        const configured =
          typeof slot === "string" && slot.length > 0 ? slot : undefined;
        if (!configured && harnessPrefs.kind !== "claude-code") return;
        const title = await generateConversationTitle({
          runTurn: accountedRunTurn,
          harnessPrefs,
          cwd: assistantCwd(vaultRegistry),
          model: configured ?? "fast",
          userMessage: args.userMessage,
          assistantText: args.assistantText,
          egressConsent: () =>
            providerEgressConsent.has(
              args.conversationId,
              harnessPrefs.kind,
              "assistant"
            ),
          timeoutMs: 20_000,
        });
        if (!title) return;
        const meta = conversationHistoryStore.getSessionMeta(
          ASSISTANT_APP_ID,
          args.conversationId
        );
        if (!meta || meta.title !== deriveTitle(args.userMessage)) return;
        conversationHistoryStore.renameSession(
          ASSISTANT_APP_ID,
          args.conversationId,
          title
        );
      } catch {
        /* fire-and-forget — a title miss never affects the turn */
      }
    })();
  };

  const classifyCapture = async (
    text: string
  ): Promise<Awaited<ReturnType<typeof classifyCaptureWithHarness>>> => {
    if (turnLimiterForCurrentVault().atCapacity()) return undefined;
    const harnessPrefs = await prefsLoader("assistant");
    if (!harnessPrefs) return undefined;
    // Capture has no user-visible conversation, but provider consent is
    // conversation-scoped and FK-backed — hence one hidden build conversation
    // per vault, so a durable receipt exists before any text egresses.
    const captureConversationId = "centraid:capture-classifier";
    const captureLedger = ledgerConversationStore(
      currentWorkspace().ledgerDbFile
    );
    if (!captureLedger.getConversation(captureConversationId)) {
      captureLedger.createConversation({
        id: captureConversationId,
        kind: "build",
        userId: "",
        title: "Capture classification",
        harnessKind: harnessPrefs.kind,
      });
    }
    providerEgressConsent.grant(
      captureConversationId,
      harnessPrefs.kind,
      "direct"
    );
    const model = await resolveModel("assistant", undefined, harnessPrefs.kind);
    return classifyCaptureWithHarness({
      runTurn: accountedRunTurn,
      harnessPrefs,
      cwd: assistantCwd(vaultRegistry),
      text,
      egressConsent: () =>
        providerEgressConsent.has(captureConversationId, harnessPrefs.kind),
      ...(model ? { model } : {}),
      timeoutMs: 20_000,
    });
  };

  const askAppMeta = async (
    appId: string
  ): Promise<{ name?: string; description?: string }> => {
    try {
      const host = await currentVaultHost();
      const dir = await host.store.resolveActiveAppDir(appId);
      if (!dir) return {};
      const raw = JSON.parse(
        await fs.readFile(path.join(dir, "app.json"), "utf8")
      ) as {
        name?: unknown;
        description?: unknown;
      };
      return {
        ...(typeof raw.name === "string" ? { name: raw.name } : {}),
        ...(typeof raw.description === "string"
          ? { description: raw.description }
          : {}),
      };
    } catch {
      return {};
    }
  };

  const askRunner = makeAssistantConversationRunner({
    prefsLoader,
    subsystem: "ask",
    getDispatcher,
    vaults: vaultRegistry,
    runTurn: accountedRunTurn,
    harnessLadder,
    harnessHealth,
    harnessHealthContext,
    providerEgressConsent,
    onFailover: onConversationRunnerFailover,
    buildPrompt: async (input) => {
      const plane = vaultRegistry.current();
      const meta = await askAppMeta(input.appId);
      return buildAssistantPrompt(plane.name, plane.assistantContext(), {
        appId: input.appId,
        ...(meta.name ? { appName: meta.name } : {}),
        ...(meta.description ? { appDescription: meta.description } : {}),
      });
    },
  });

  // `support-bundle.ts` is allowlist-by-construction: a field nobody added on
  // purpose is absent rather than copied (#846). Level `standard`, not the
  // builder's `strict` default, because this route answers the owner behind
  // the host bearer gate; the redaction policy is the same either way.
  const buildDiagnostics = async (): Promise<string> => {
    const input = await collectSupportBundleInput({
      health,
      logs: logStore,
      anomalies: {
        snapshot: () => (paths.logsDir ? readAnomalyLedger(paths.logsDir) : []),
      },
      planes: vaultRegistry.planesList(),
      gateway: {
        version: GATEWAY_VERSION,
        protocolVersion: GATEWAY_PROTOCOL_VERSION,
        minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
      },
      runtime: {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
      },
      generatedAtMs: Date.now(),
      salt: crypto.randomUUID(),
      level: "standard",
      config: {
        paths,
        backup: options.backup,
        deviceAccessEnabled: Boolean(options.deviceAccess),
        ...commonsObservabilitySection({
          vaults: vaultRegistry
            .planesList()
            .map((plane) => ({ vaultId: plane.boot.vaultId, db: plane.db })),
        }),
      },
    });
    return renderSupportBundle(input).text;
  };

  // ── Route chain ───────────────────────────────────────────────────────
  const routeEntries: RoutePrefixRegistration[] = [
    forRoutePrefixes(
      ["/centraid/_web", "/centraid/_apps"],
      webControlSessions.handler
    ),
    forRoutePrefixes(
      "/centraid/_gateway/info",
      makeGatewayInfoRouteHandler({
        instanceId,
        ...(options.devicePairing?.endpointId
          ? { endpointId: options.devicePairing.endpointId }
          : {}),
        ...(options.devicePairing?.endpointTicket
          ? { endpointTicket: options.devicePairing.endpointTicket }
          : {}),
        capabilities: {
          webSessions: true,
          devicePairing: Boolean(options.devicePairing),
          tunnel: Boolean(options.dataPlaneControl),
          backupWal: options.backup?.enabled === true,
          assistOAuth: Boolean(options.assistOAuth),
          automationTurns: experimental.automations,
          multiVaultReplica: true,
          crossVaultPlacements: true,
          automations: experimental.automations,
          connectors: experimental.connectors,
        },
      })
    ),
    ...(options.dataPlaneControl
      ? [
          forRoutePrefixes(
            "/centraid/_gateway/tunnel",
            makeDataPlaneControlHandler(options.dataPlaneControl)
          ),
        ]
      : []),
    ...(options.devicePairing
      ? [
          forRoutePrefixes(
            "/centraid/_gateway/devices",
            makeDevicesRouteHandler({
              enrollments: options.devicePairing.enrollments,
              tickets: options.devicePairing.tickets,
              endpointTicket: options.devicePairing.endpointTicket,
              ...(options.isHostCustody
                ? { canMintPairingTicket: options.isHostCustody }
                : {}),
              // `OrUndefined` deliberately: this seam must not throw when
              // every vault has been deleted.
              defaultVaultId: () => vaultRegistry.defaultVaultIdOrUndefined(),
              vaultIds: () =>
                vaultRegistry.list().map((vault) => vault.vaultId),
              onEndpointRevoked: options.devicePairing.onEndpointRevoked,
              vaultName: (id) => vaultRegistry.get(id)?.name,
              mintVaultForPerson: (name) => vaultRegistry.create(name),
              unmintVaultForPerson: (vaultId) => vaultRegistry.delete(vaultId),
              onRevoked: (rows) => {
                for (const row of rows) {
                  const plane = vaultRegistry.get(row.vaultId);
                  plane?.forgetReplicaDevice(row.endpointId);
                  plane?.db.blobTransfers.revokePairedDevice(row.endpointId);
                }
              },
            })
          ),
          forRoutePrefixes(
            "/centraid/_gateway/owners",
            makeOwnersRouteHandler({
              enrollments: options.devicePairing.enrollments,
              vaultName: (id) => vaultRegistry.get(id)?.name,
              ...(options.isHostCustody
                ? { isHostCustody: options.isHostCustody }
                : {}),
              onEndpointRevoked: options.devicePairing.onEndpointRevoked,
              onRevoked: (rows) => {
                for (const row of rows) {
                  const plane = vaultRegistry.get(row.vaultId);
                  plane?.forgetReplicaDevice(row.endpointId);
                  plane?.db.blobTransfers.revokePairedDevice(row.endpointId);
                }
              },
            })
          ),
          forRoutePrefixes(
            "/centraid/_gateway/device-work",
            makeDeviceWorkRouteHandler({
              vaults: vaultRegistry,
              enrollments: options.devicePairing.enrollments,
            })
          ),
          // Cross-owner edges only (#726). `peer` gates on the SAME
          // `peerPlane.dial` as every other outbound capability: absent,
          // `ticket`/`redeem` answer a typed refusal.
          forRoutePrefixes(
            "/centraid/_gateway/links",
            makeVaultLinksRouteHandler({
              enrollments: options.devicePairing.enrollments,
              store: vaultLinksStore,
              gatewayDatabase,
              vaultPublicKey: (vaultId) =>
                vaultRegistry.vaultIdentity(vaultId)?.publicKey,
              vaultName: (vaultId) => vaultRegistry.get(vaultId)?.name,
              ownerPartyFor: (vaultId) =>
                vaultRegistry.get(vaultId)?.boot.ownerPartyId,
              ...(options.peerPlane?.dial
                ? {
                    peer: {
                      localRoute: options.peerPlane.localRoute,
                      dial: options.peerPlane.dial,
                    },
                  }
                : {}),
            })
          ),
        ]
      : []),
    forRoutePrefixes(
      "/centraid/_gateway/health",
      makeHealthRouteHandler(health)
    ),
    forRoutePrefixes(
      "/centraid/_gateway/resource",
      makeResourceRouteHandler(health, powerContext)
    ),
    forRoutePrefixes(
      "/centraid/_gateway/capture",
      makeCaptureRouteHandler({
        classify: classifyCapture,
        recognizeOcr: makeCaptureOcrRecognizer((automationRef, input) =>
          fireAutomation(automationRef, {
            triggerKind: "manual",
            triggerOrigin: "manual",
            input,
            propagateError: true,
          })
        ),
      })
    ),
    forRoutePrefixes(
      "/centraid/_gateway/diagnostics",
      makeDiagnosticsRouteHandler(buildDiagnostics)
    ),
    forRoutePrefixes(
      "/centraid/_gateway/backup",
      makeBackupRouteHandler({
        vaults: vaultRegistry,
        enrollments: enrollmentStore,
        recoveryKitStore: recoveryKit,
        backupService,
        ...(options.isHostCustody
          ? { isHostCustody: options.isHostCustody }
          : {}),
      })
    ),
    forRoutePrefixes(
      "/centraid/_gateway/storage",
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: vaultRegistry,
        storageUsage,
        localUsage,
        storageLimits,
        onConnectionsChanged: async () => {
          walCaptureConfigured =
            options.backup?.enabled === true ||
            (await storageConnections.list()).length > 0;
          for (const plane of vaultRegistry.planesList())
            plane.rescheduleWalCapture();
          await backupService.refreshWalSchedule();
        },
      })
    ),
    forRoutePrefixes(
      ["/centraid/_reminders", "/centraid/_brief"],
      makeRemindersRouteHandler(vaultRegistry, options.devicePairing)
    ),
    forRoutePrefixes("/centraid/_logs", makeLogsRouteHandler(logStore)),
    forRoutePrefixes(
      "/centraid/_vault/assistant",
      makeAssistantRouteHandler({
        vaults: vaultRegistry,
        conversationStore: conversationHistoryStore,
        runner: assistantRunner,
        conversationLocks: new Map(),
        resolveModel,
        generateTitle: generateAssistantTitle,
        limiter: turnLimiterForCurrentVault,
      })
    ),
    forRoutePrefixes(
      "/centraid/_vault/demo",
      makeDemoRouteHandler(vaultRegistry, {
        codeAppsDir: () => currentSettledHost().codeAppsDir(),
        bundledAppDirs: () => {
          const installed = vaultRegistry.current().installedAppIds();
          return new Map(
            [...bundledAppIds]
              .filter((appId) => installed.has(appId))
              .map((appId) => [appId, bundledAppDir(appId)])
          );
        },
      })
    ),
    forRoutePrefixes(
      "/centraid/_vault/imports",
      makeImportRouteHandler(vaultRegistry)
    ),
    forRoutePrefixes(
      SEMANTIC_SEARCH_PATH,
      makeEnrichSearchRouteHandler(vaultRegistry, {
        embedQuery: (query) =>
          fireAutomation("embed-text/embed-text", {
            triggerKind: "manual",
            triggerOrigin: "manual",
            input: { query },
            propagateError: true,
          }),
      })
    ),
    forRoutePrefixes(
      GRANTS_PATH,
      makeGrantRouteHandler({
        enrollments: enrollmentStore,
        currentVault: () => {
          // `current()` throws when this host has no vault for the request's
          // scope; that is a STATE (409), not a fault.
          let plane;
          try {
            plane = vaultRegistry.current();
          } catch {
            return undefined;
          }
          return {
            vaultId: plane.boot.vaultId,
            db: plane.db,
            ownerPartyId: plane.boot.ownerPartyId,
            // The one door (ruling V-writer). The member's own credential: a
            // share is the member's sentence, and the pack parks anyone else.
            invoke: (command, input) =>
              plane.invoke(plane.ownerCredential, {
                command,
                input,
              }),
          };
        },
      })
    ),
    forRoutePrefixes(
      "/centraid/_vault/blobs",
      makeBlobRouteHandler(vaultRegistry, options.dataPlaneHttp)
    ),
    ...(experimental.connectors
      ? [
          forRoutePrefixes(
            [ROUTES.vaultConnections, ROUTES.vaultOAuthCallback],
            makeConnectionsRouteHandler(
              vaultRegistry,
              connectionBroker,
              options.assistOAuth
            )
          ),
        ]
      : []),
    forRoutePrefixes(
      ["/centraid/_vault/replica", "/centraid/_vault/changes"],
      makeReplicaRouteHandler(vaultRegistry, {
        // The embedded desktop host is enrolled in the canonical store despite
        // having no remote-pairing plane, so replica access MUST consult that
        // same store or it proves an unresolvable EndpointId.
        enrollments: enrollmentStore,
        dispatchIntent: async (input) =>
          replicaDispatchOutcome(
            await getDispatcher().write({
              app: input.appId,
              action: input.action,
              input: input.input,
              intentId: input.intentId,
            })
          ),
      })
    ),
    // The generic owner consent surface: it answers 404 for any `_vault`
    // sub-route it does not know, so every specific handler above must stay
    // ahead of it. Vault create/delete are ADMIN acts, never HTTP (#289).
    forRoutePrefixes(
      "/centraid/_vault",
      makeVaultRouteHandler(vaultRegistry, {
        ...(effectiveDeviceAccess
          ? { deviceAccess: effectiveDeviceAccess }
          : {}),
        onOutboxDecided: drainOutbox,
        storageConnections,
        recoveryKit,
        enrollments: enrollmentStore,
        gatewayDatabase,
        keys: gatewayKeys,
        ...(options.isHostCustody
          ? { isHostCustody: options.isHostCustody }
          : {}),
        notificationsEvents,
        fenceVaultForErase: (vaultId) =>
          backupService.fenceVaultForErase(vaultId),
        resolveAutomationName: async (appId) => {
          const { rows } = await automation.list(
            currentSettledHost().codeAppsDir()
          );
          return rows.find((r) => r.ownerApp === appId)?.name;
        },
      })
    ),
    forRoutePrefixes(
      "/centraid/_templates",
      makeTemplatesRouteHandler({
        ...(paths.templatesCacheDir
          ? { cacheDir: paths.templatesCacheDir }
          : {}),
        installedAppIds: () => {
          try {
            return vaultRegistry.current().installedAppIds();
          } catch {
            return new Set<string>();
          }
        },
      })
    ),
    forRoutePrefixes(
      ENRICH_PROFILES_PREFIX,
      makeEnrichProfilesRouteHandler({ readPrefs: () => prefs.getAllPrefs() })
    ),
    forRoutePrefixes(
      "/centraid/_harnesses",
      makeHarnessesRouteHandler({
        ...(resolveCatalogModels
          ? { resolveModels: resolveCatalogModels }
          : {}),
        resolveCapabilities: async (kind, refresh) => {
          const extraArgs = extraArgsForKind(kind);
          const caps = await resolveAcpCapabilities(kind, {
            binPath: binPathForKind(kind),
            ...(extraArgs ? { extraArgs } : {}),
            cacheDir: path.join(
              paths.cacheDir ?? path.join(dataDir, "cache"),
              "harness-capabilities"
            ),
            // Spawn only on explicit refresh; otherwise serve cache.
            // `probeIfMissing` is what probes once on a cold first read —
            // without it a fresh gateway answers `undefined` and an installed,
            // authed harness shows no models until a manual Refresh (#665).
            refresh,
            probeIfMissing: true,
          });
          if (!caps) return undefined;
          if (refresh && caps.reachable && !caps.authRequired) {
            for (const entry of harnessHealth
              .list()
              .filter((row) => row.harnessKind === kind)) {
              harnessHealth.reportPreflightOk(entry.workspaceContext, kind);
            }
          }
          const out: HarnessAcpCapabilities = {
            reachable: caps.reachable,
            loadSession: caps.loadSession,
            resume: caps.resume,
            close: caps.close,
            additionalDirectories: caps.additionalDirectories,
            mcpHttp: caps.mcpHttp,
            mcpSse: caps.mcpSse,
            modelConfigurable: caps.modelConfigurable,
            configOptions: caps.configOptions,
            usageUpdateObserved: caps.usageUpdateObserved,
            configOptionUpdateObserved: caps.configOptionUpdateObserved,
            locationsObserved: caps.locationsObserved,
            authRequired: caps.authRequired,
            promptImage: caps.promptImage,
            promptAudio: caps.promptAudio,
            promptEmbeddedContext: caps.promptEmbeddedContext,
            probedAt: caps.probedAt,
            ...(caps.reason ? { reason: caps.reason } : {}),
          };
          return out;
        },
        resolveHealth: (kind) =>
          harnessHealth.list().filter((row) => row.harnessKind === kind),
        binPathFor: binPathForKind,
      })
    ),
    forRoutePrefixes(
      experimental.automations
        ? ["/centraid/_apps", "/centraid/_automations", "/centraid/_insights"]
        : ["/centraid/_apps"],
      async (req, res) => {
        const host = await currentVaultHost();
        return (
          (await findSequentially(host.handlers, (handler) =>
            handler(req, res)
          )) !== undefined
        );
      }
    ),
  ];

  // `composedHandler` owns the whole request: resolve the addressed vault
  // (#289), then run chat-history → prefs → extra handlers → `runtime.handle`
  // inside that vault's ambient scope. Auth and CORS are the host's job.
  const conversationHandler = makeConversationRouteHandler(
    () => conversationHistoryStore
  );
  const harnessSubsystems: readonly ModelSubsystem[] = [
    "assistant",
    "ask",
    "builder",
    "automations",
  ];
  const patchedPrefs = (
    before: Record<string, unknown>,
    patch: Record<string, unknown>
  ): Record<string, unknown> => {
    const next = { ...before };
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === undefined) delete next[key];
      else next[key] = value;
    }
    return next;
  };
  const userStoreHandler = makeUserStoreRouteHandler(
    () => prefs,
    () => currentWorkspace().ownerPartyId,
    {
      validatePatch: async (patch, before) => {
        // Profiles FIRST: the check is pure, so a malformed profile is refused
        // without spawning a harness preflight (#807).
        const profileRejection = validateEngineProfilePatch(patch);
        if (profileRejection) return profileRejection;
        const next = patchedPrefs(before, patch);
        const switches: Array<ModelSubsystem | undefined> = [];
        if (Object.hasOwn(patch, "harness.kind")) switches.push(undefined);
        for (const subsystem of harnessSubsystems) {
          if (Object.hasOwn(patch, `harness.${subsystem}`))
            switches.push(subsystem);
        }
        let failure: string | undefined;
        await findSequentially(switches, async (subsystem) => {
          const candidate = resolveStrictGatewayHarnessPrefs(next, subsystem);
          if (!candidate) {
            failure = `Cannot switch ${subsystem ?? "the default lane"}: no valid harness is configured.`;
            return true;
          }
          const status = await runPreflight(candidate, {
            ...(catalogPath ? { catalogPath } : {}),
            requireSessionReady: true,
          });
          if (status.ok) return false;
          failure = `Cannot switch ${subsystem ?? "the default lane"} to ${candidate.kind}: ${status.reason ?? "preflight failed"}`;
          return true;
        });
        return failure;
      },
      afterPatch: (_patch, before, after) => {
        for (const { kind, subsystem } of removedHarnessLadderMembers(
          before,
          after
        )) {
          for (const plane of vaultRegistry.planesList()) {
            new ProviderEgressConsentStore(() =>
              plane.workspace.journal()
            ).revokeLadderProvider(kind, subsystem);
          }
        }
      },
    }
  );
  const compiledRouteEntries = [
    forRoutePrefixes(CONVERSATIONS_PREFIX, conversationHandler),
    forRoutePrefixes(USER_STORE_PREFIX, userStoreHandler),
    ...routeEntries,
  ];
  assertRouteSecurityCoverage(compiledRouteEntries);
  const prefixDispatch = createRoutePrefixDispatch(compiledRouteEntries);
  const extraHandlers: RouteHandler[] = [prefixDispatch];
  const dispatchChain: RouteHandler = async (req, res) => {
    if (await prefixDispatch(req, res)) return true;
    await runtime.handle(req, res);
    return true;
  };

  // Deliberately NOT in `routeEntries`: this listing spans every vault the
  // caller owns, so it dispatches outside the per-vault scope.
  const scopesHandler = makeScopesRouteHandler({
    enrollments: enrollmentStore,
    listVaults: () => vaultRegistry.list(),
    installedApps: (vaultId) => vaultRegistry.get(vaultId)?.installedAppIds(),
    ensureAppInstalled: ensureBundledAppInstalled,
    ...(options.isHostCustody ? { isHostCustody: options.isHostCustody } : {}),
  });
  const multiplexReplicaHandler = makeMultiplexReplicaRouteHandler(
    vaultRegistry,
    enrollmentStore
  );
  const edgesHandler = makeEdgesRouteHandler({
    gatewayDatabase,
    enrollments: enrollmentStore,
    links: vaultLinksStore,
    vaultFor: (vaultId) => vaultRegistry.get(vaultId)?.db,
    partyIdFor: (vaultId) => vaultRegistry.get(vaultId)?.boot.ownerPartyId,
  });
  const commonsHandler = makeCommonsRouteHandler({
    enrollments: enrollmentStore,
    vaultFor: (vaultId) => vaultRegistry.get(vaultId)?.db,
    gatewayFor: (vaultId) => vaultRegistry.get(vaultId)?.gateway,
    credentialFor: (vaultId) => {
      const plane = vaultRegistry.get(vaultId);
      return plane
        ? {
            kind: "device" as const,
            deviceId: plane.boot.deviceId,
            deviceKey: plane.boot.deviceKey,
          }
        : undefined;
    },
    ownerPartyFor: (vaultId) => vaultRegistry.get(vaultId)?.boot.ownerPartyId,
    vaultPublicKeyFor: (vaultId) =>
      vaultRegistry.vaultIdentity(vaultId)?.publicKey,
    linkedVaultPublicKey: (localVaultId, peerVaultId) => {
      const link = vaultLinksStore.findPair(localVaultId, peerVaultId);
      if (
        !link ||
        link.revoked ||
        link.approvedByA === null ||
        link.approvedByB === null
      )
        return undefined;
      // #750 invariant 1: identity lives in the vault directory, not the link.
      return vaultLinksStore.directoryEntry(peerVaultId)?.publicKey;
    },
    invitePeer: async (invitation) => {
      const { stewardVaultId, memberVaultId } = invitation;
      const link = vaultLinksStore.peerForVault(memberVaultId, stewardVaultId);
      const dial = options.peerPlane?.dial;
      if (!link || !dial) return false;
      return invitePeerToCommons({
        dial,
        route: link.route,
        invitation,
      });
    },
    acceptPeer: async ({
      stewardVaultId,
      memberVaultId,
      grantId,
      expectedSizeBytes,
    }) => {
      const member = vaultRegistry.get(memberVaultId);
      const link = vaultLinksStore.peerForVault(stewardVaultId, memberVaultId);
      const dial = options.peerPlane?.dial;
      if (!member || !link || !dial) return false;
      const result = await pullPeerCommons({
        dial,
        route: link.route,
        stewardVaultId,
        memberVaultId,
        grantId,
        seat: member.db,
        acceptInvitation: true,
        expectedSizeBytes,
        ...(member.gateway && member.ownerCredential
          ? { gateway: member.gateway, credential: member.ownerCredential }
          : {}),
      });
      return result.state === "current";
    },
    claimPeer: async ({ stewardVaultId, memberVaultId, claimToken }) => {
      const member = vaultRegistry.get(memberVaultId);
      const link = vaultLinksStore.peerForVault(stewardVaultId, memberVaultId);
      const dial = options.peerPlane?.dial;
      if (!member || !link || !dial) return false;
      return claimPeerCommonsInvitation({
        dial,
        route: link.route,
        stewardVaultId,
        memberVaultId,
        claimToken,
        seat: member.db,
      });
    },
    refusePeer: async ({ stewardVaultId, memberVaultId, grantId }) => {
      const link = vaultLinksStore.peerForVault(stewardVaultId, memberVaultId);
      const dial = options.peerPlane?.dial;
      if (!link || !dial) return false;
      return refusePeerCommonsInvitation({
        dial,
        route: link.route,
        stewardVaultId,
        memberVaultId,
        grantId,
      });
    },
  });
  const commonsRecoveryHandler = makeCommonsRecoveryRouteHandler({
    enrollments: enrollmentStore,
    vaultFor: (vaultId) => vaultRegistry.get(vaultId)?.db,
    invitePeer: async (invitation) => {
      const link = vaultLinksStore.peerForVault(
        invitation.memberVaultId,
        invitation.stewardVaultId
      );
      const dial = options.peerPlane?.dial;
      if (!link || !dial) return false;
      return invitePeerToCommons({ dial, route: link.route, invitation });
    },
  });
  // Mounted OUTSIDE the prefix registry on purpose: every route there resolves
  // a proved DEVICE first, and a peer is not a device (#726).
  const peerPlaneHandler = options.peerPlane
    ? makePeerPlaneHandler({
        links: vaultLinksStore,
        peerProof: options.peerPlane.proof,
        vaultPublicKey: (vaultId) =>
          vaultRegistry.vaultIdentity(vaultId)?.publicKey,
        ownerPartyFor: (vaultId) =>
          vaultRegistry.get(vaultId)?.boot.ownerPartyId,
        localRoute: options.peerPlane.localRoute,
        localLabel: () => os.hostname().replace(/\.local$/u, ""),
        budget: createTokenBucket(PEER_PLANE_BUDGET),
        commonsVaultFor: (vaultId) => vaultRegistry.get(vaultId)?.db,
        commonsGatewayFor: (vaultId) => vaultRegistry.get(vaultId)?.gateway,
        commonsCredentialFor: (vaultId) => {
          const plane = vaultRegistry.get(vaultId);
          return plane
            ? {
                kind: "device" as const,
                deviceId: plane.boot.deviceId,
                deviceKey: plane.boot.deviceKey,
              }
            : undefined;
        },
      })
    : undefined;
  // Drains the ONE share outbox on the gateway's clock: bounded rows per tick,
  // backs off on failure, never throws out of the timer. `dial` is read LIVE,
  // so a build that wires it later (or never) still behaves — the sweep idles.
  const peerPlaneSweep = createPeerPlaneSweep({
    db: gatewayDatabase,
    links: vaultLinksStore,
    vaultFor: (vaultId) => vaultRegistry.get(vaultId)?.db,
    partyIdFor: (vaultId) => vaultRegistry.get(vaultId)?.boot.ownerPartyId,
    commonsVaults: () =>
      vaultRegistry.planesList().map((plane) => ({
        vaultId: plane.boot.vaultId,
        db: plane.db,
        gateway: plane.gateway,
        credential: plane.ownerCredential,
      })),
    dial: () => options.peerPlane?.dial,
    // The RETRY path for route re-assertion (#750 invariant 3): a no-op until
    // the endpoint changes, and armed while any linked peer has not heard it,
    // because the `gateway_meta` pin is written only on full delivery.
    announceRoutes: async () => {
      const dial = options.peerPlane?.dial;
      const localRoute = options.peerPlane?.localRoute;
      if (!dial || !localRoute) return;
      await announceLocalRoutes({
        links: vaultLinksStore,
        dial,
        signAsVault: (vaultId, bytes) =>
          vaultRegistry.signAsVault(vaultId, bytes),
        localVaultIds: () =>
          vaultRegistry.planesList().map((plane) => plane.boot.vaultId),
        route: localRoute,
        log: {
          info: (message) => logger.info(message),
          warn: (message) => logger.warn(message),
        },
      });
    },
    ...(options.peerPlane?.blobPullIntervalMs === undefined
      ? {}
      : { idleIntervalMs: options.peerPlane.blobPullIntervalMs }),
    shouldDefer: () => health.shouldDeferBackgroundWork(),
    logger,
  });
  nudgeCommonsSweep = () => peerPlaneSweep.nudge();
  const pushRegistrationHandler =
    makePushRegistrationRouteHandler(gatewayDatabase);
  const pushWakeRelay = new PushWakeRelay(
    vaultRegistry,
    enrollmentStore,
    gatewayDatabase
  );
  requestNotificationsWake = (vaultId) => pushWakeRelay.requestWake(vaultId);
  for (const vaultId of pendingNotificationsWakes)
    pushWakeRelay.requestWake(vaultId);
  pendingNotificationsWakes.clear();

  /** Every name a peer forwarder may stamp — the backstop refuses on ANY of them (#865 F9). */
  const PEER_IDENTITY_HEADERS = [
    PEER_ENDPOINT_HEADER,
    PEER_PROOF_HEADER,
    PEER_VAULT_HEADER,
  ];

  /*
   * Gateway-wide operator surfaces (#865 F2). The `active` admin rows work
   * inside one vault and already refuse per-request through
   * `vaultOwnerRefusal`, so they must NOT be blanket-refused here. The rest
   * have no vault context and are exactly what a proved DEVICE identity never
   * reaches: judged here against the plane `startRuntimeHttpServer` stamped,
   * so a paired device gets 403 while the loopback bearer passes.
   */
  const ADMIN_GATEWAY_WIDE_PREFIXES = ROUTE_SECURITY_REGISTRY.filter(
    (row) => row.auth === "admin" && row.vaultScope !== "active"
  ).map((row) => row.prefix);
  const isAdminGatewayWidePath = (pathname: string): boolean =>
    ADMIN_GATEWAY_WIDE_PREFIXES.some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    );

  const composedHandler: RouteHandler = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    // Recorded on 'close', not on return, so a streamed body is measured to
    // the byte and not just to the handler's first await (#659).
    const startedAt = performance.now();
    res.once("close", () =>
      routeLatency.record(url.pathname, performance.now() - startedAt)
    );
    /*
     * TWO steps, and not the same guard (#726). The handler matches the RAW
     * `req.url`, so a traversal reaches it and its own confinement check
     * refuses it. The second closes the owner-tier hole: a peer-marked request
     * that is not a peer-plane request must NEVER reach a bearer-authenticated
     * route, where the forwarder's upstream bearer would satisfy the gate —
     * hence `not_found`, not a 403 that would confirm the route exists.
     */
    if (peerPlaneHandler && (await peerPlaneHandler(req, res))) return true;
    // The backstop must judge EVERY peer identity name, not one of them
    // (#865 F9): the Rust relay's forwarder-owned set carries a peer-vault
    // header too, so a future forwarder stamping only that name would
    // otherwise slip past this refusal into bearer-authenticated dispatch.
    if (
      PEER_IDENTITY_HEADERS.some((header) => req.headers[header] !== undefined)
    )
      return sendJson(res, 404, { state: "not_found" });
    // Admin tier (#865 F2): a proved DEVICE plane never reaches gateway-wide
    // operator surfaces. Check the plane header BEFORE `deviceKeyFor` stamps
    // AUTHED_DEVICE_HEADER — every surviving caller has some device key.
    if (
      req.headers[AUTHED_PLANE_HEADER] === "device" &&
      isAdminGatewayWidePath(url.pathname)
    )
      return sendJson(res, 403, {
        error: "admin_plane_forbidden",
        message:
          "gateway-wide operator surfaces are not reachable with a proved device identity",
      });
    // The Rust-owned iroh relay calls this metadata-only control surface
    // before it can inject the remote EndpointId. The route's per-boot control
    // secret authenticates it, so dispatch at gateway scope in every vault state.
    if (
      (url.pathname === "/centraid/_gateway/info" ||
        url.pathname.startsWith("/centraid/_gateway/tunnel/")) &&
      (await prefixDispatch(req, res))
    ) {
      return true;
    }
    // `centraid-gateway pair` carries no device identity, so demanding a
    // proved device HERE would leave a headless daemon unable to enroll its
    // FIRST device. The skip grants nothing: the bearer was enforced upstream
    // and the route still applies host-custody-or-vault-owner.
    if (
      url.pathname === "/centraid/_gateway/devices/ticket" &&
      isDirectHostRequest(req) &&
      (await prefixDispatch(req, res))
    ) {
      return true;
    }
    // A native merged grid cannot attach `x-centraid-vault` to an image URL,
    // so the scope rides the path and is rewritten into the ordinary blob lane
    // before vault resolution. Authorization below is unchanged.
    const scopedBlob =
      /^\/centraid\/_gateway\/blobs\/(?<vaultId>[^/]+)\/(?<contentId>[^/]+)$/u.exec(
        url.pathname
      );
    if (scopedBlob) {
      const encodedVaultId = scopedBlob.groups?.vaultId ?? "";
      const encodedContentId = scopedBlob.groups?.contentId ?? "";
      req.headers[VAULT_HEADER] = decodeURIComponent(encodedVaultId);
      req.url = `/centraid/_vault/blobs/${encodedContentId}${url.search}`;
    }
    // A proved device enrollment scopes what may be addressed; the header
    // picks within it, and no identity is a HARD refusal (#289). Loopback
    // embeds use the persisted host enrollment, not wildcard reach.
    delete req.headers[COMPANION_GRANTS_HEADER];
    const rawHeader = req.headers[VAULT_HEADER];
    const requested = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const deviceKey = effectiveDeviceAccess?.deviceKeyFor(req);
    if (deviceKey === undefined) {
      return sendJson(res, 403, {
        error: "device_identity_required",
        message: "this request has no proved enrolled device identity",
      });
    }
    req.headers[AUTHED_DEVICE_HEADER] = deviceKey;
    const enrolled =
      effectiveDeviceAccess?.vaultsFor(deviceKey) ??
      enrollmentStore.vaultsFor(deviceKey);
    if (enrolled.length === 0) {
      return sendJson(res, 403, {
        error: "device_not_enrolled",
        message: "this device is not enrolled in any vault on this gateway",
      });
    }
    // Cross-vault listings dispatch HERE: after the device identity is proved,
    // BEFORE the single-vault scope below. The vault header is irrelevant.
    if (url.pathname === SCOPES_PATH && (await scopesHandler(req, res)))
      return true;
    if (
      url.pathname === MULTIPLEX_REPLICA_CHANGES_PATH &&
      (await multiplexReplicaHandler(req, res))
    )
      return true;
    if (url.pathname === EDGES_PATH && (await edgesHandler(req, res)))
      return true;
    if (
      (url.pathname === COMMONS_PATH ||
        url.pathname.startsWith(`${COMMONS_PATH}/`)) &&
      (await commonsHandler(req, res))
    )
      return true;
    if (
      url.pathname === COMMONS_RECOVERY_PATH &&
      (await commonsRecoveryHandler(req, res))
    )
      return true;
    if (
      url.pathname === PUSH_REGISTRATIONS_PATH &&
      (await pushRegistrationHandler(req, res))
    )
      return true;
    if (requested !== undefined && !enrolled.includes(requested)) {
      return sendJson(res, 403, {
        error: "vault_not_enrolled",
        message: "this device is not enrolled in the requested vault",
      });
    }
    // No header → the DEFAULT vault when this device is enrolled in it.
    // `enrolled[0]` would rank by enrollment row order and disagree with
    // `defaultVaultId()` and every other unscoped seam.
    const preferredVaultId = vaultRegistry.defaultVaultIdOrUndefined();
    const vaultId =
      requested ??
      (preferredVaultId !== undefined && enrolled.includes(preferredVaultId)
        ? preferredVaultId
        : enrolled[0]!);
    if (!vaultRegistry.get(vaultId)) {
      return sendJson(res, 404, {
        error: "vault_not_found",
        message: `unknown vault "${vaultId}"`,
      });
    }
    const enrollment = enrollmentStore.get(deviceKey, vaultId);
    if (enrollment?.grantProfile !== undefined) {
      if (
        !companionRequestAllowed(
          req,
          enrollment.grantProfile,
          enrollment.enrollmentId
        )
      ) {
        return sendJson(res, 403, {
          error: "companion_profile",
          message:
            "this Companion device is not granted access to that gateway surface",
        });
      }
      req.headers[COMPANION_GRANTS_HEADER] = enrollment.grantProfile.join(",");
    }
    return runWithVaultContext(
      {
        vaultId,
        deviceKey,
        // Resolve the ACTING OWNER once, so downstream reads it off the
        // request scope, never from hardware (#599). `ownsVault` is the ONE
        // write predicate: the view yields only owned vaults (#726).
        ...(enrollment
          ? { ownerId: enrollment.ownerId, ownsVault: !enrollment.revoked }
          : {}),
        ...(enrollment?.grantProfile === undefined
          ? {}
          : { grantProfile: enrollment.grantProfile }),
      },
      () => dispatchChain(req, res)
    );
  };

  let unsubscribeLateMount = (): void => undefined;
  const lateMountTasks = new Set<Promise<void>>();

  const recompileMountedCommons = (): void => {
    const now = new Date().toISOString();
    for (const steward of vaultRegistry.planesList())
      recompileCommonsGrants({
        steward: steward.db,
        stewardVaultId: steward.boot.vaultId,
        stewardPartyId: steward.boot.ownerPartyId,
        vaultFor: (memberVaultId) => vaultRegistry.get(memberVaultId)?.db,
        invokeFor: commonsReplicaInvoke,
        now,
      });
  };

  const start = async (publicBaseUrl: string): Promise<void> => {
    serverUrl = publicBaseUrl;

    // A vault arriving after boot can introduce an earlier WAL RPO than the
    // armed timer, and also needs its host/scheduler activated.
    unsubscribeLateMount();
    unsubscribeLateMount = vaultRegistry.onMount((plane) => {
      pushWakeRelay.attach(plane);
      const task = Promise.all([
        hostFor(plane).catch((error) =>
          logger.warn(
            `late vault host mount failed (${plane.boot.vaultId}): ` +
              (error instanceof Error ? error.message : String(error))
          )
        ),
        backupService
          .refreshWalSchedule()
          .catch((error) =>
            logger.warn(
              `late vault WAL schedule refresh failed: ` +
                (error instanceof Error ? error.message : String(error))
            )
          ),
      ]).then(() => recompileMountedCommons());
      lateMountTasks.add(task);
      void task.finally(() => lateMountTasks.delete(task));
    });
    pushWakeRelay.start();
    webControlSessions.startSweeping();
    peerPlaneSweep.start();

    // Schedulers run REGARDLESS of the automations gate: recognition recipes
    // ride the same cursor engine, so photos keep indexing while it is off.
    // The gate lives in reconcile's row set instead.
    schedulersStarted = true;
    for (const [, sched] of schedulers) sched.start();

    await forEachSequentially(vaultRegistry.planesList(), (plane) =>
      hostFor(plane).then(() => undefined)
    );
    recompileMountedCommons();

    vaultRegistry.start();

    scheduleOutboxSweep(hardwareProfile.outboxIdleIntervalMs);

    if (warmer) {
      const activeWarmer = warmer;
      void (async () => {
        const surface: CatalogSurface = "models";
        const checks = await Promise.all(
          HARNESS_KINDS.map(async (kind) => ({
            kind,
            present: (await probeCliAvailability(kind, binPathForKind(kind)))
              .available,
          }))
        );
        await Promise.all(
          checks
            .filter((c) => c.present)
            .map((c) =>
              activeWarmer
                .warm(c.kind, surface)
                .catch((error) =>
                  catalogLogger.warn(
                    `catalog warm (${c.kind}/${surface}) failed: ` +
                      (error instanceof Error ? error.message : String(error))
                  )
                )
            )
        );
      })();
    }

    backupService.start();
  };

  const stop = async (): Promise<void> => {
    unsubscribeLateMount();
    pushWakeRelay.stop();
    webControlSessions.stopSweeping();
    peerPlaneSweep.stop();
    // A mount notification may already be building its code host; let that
    // settle first or shutdown races git/SQLite initialization.
    await Promise.all(lateMountTasks);
    await Promise.all([...schedulers.values()].map((sched) => sched.stop()));
    if (outboxTimer) clearTimeout(outboxTimer);
    for (const open of notificationsDoorbellWindows.values())
      clearTimeout(open.timer);
    notificationsDoorbellWindows.clear();
    grantRefreshDoorbell.stop();
    await backupService.stop();
    // Drain detached lifecycle work before the vault databases close, or
    // shutdown lands mid-`closeItem` or orphans an ACP child (#541).
    // Snapshotted before awaiting: each task's `finally` removes itself, and a
    // queued lock tail can still append behind us.
    const detached = Array.from(detachedAutomationTasks);
    const lockTails = Array.from(automationConversationLocks.values());
    await Promise.all(detached);
    await Promise.all(lockTails);
    const journalFiles = vaultRegistry
      .planesList()
      .map((plane) => plane.workspace.ledgerDbFile);
    vaultRegistry.stop();
    closeLedgerConversationStores(journalFiles);
    performanceMonitor.close();
    gatewayDatabase.close();
  };

  return {
    runtime,
    health,
    backup: backupService,
    prefs,
    analyticsStore,
    conversationHistoryStore,
    vaults: vaultRegistry,
    appsStore: async () => (await currentVaultHost()).store,
    codeAppsDir: () => currentSettledHost().codeAppsDir(),
    syncApps,
    webControlSessions,
    extraHandlers,
    composedHandler,
    webhookHandler,
    logs: logStore,
    start,
    stop,
  } satisfies BuiltGateway;
}

async function readBundledAppMeta(dir: string): Promise<{
  name?: string;
  description?: string;
  iconKey?: string;
  colorKey?: string;
}> {
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(dir, "app.json"), "utf8")
    ) as Record<string, unknown>;
  } catch {
    manifest = {};
  }
  return {
    ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
    ...(typeof manifest.description === "string"
      ? { description: manifest.description }
      : {}),
    ...(typeof manifest.iconKey === "string"
      ? { iconKey: manifest.iconKey }
      : {}),
    ...(typeof manifest.colorKey === "string"
      ? { colorKey: manifest.colorKey }
      : {}),
  };
}

function manifestScopeBlock(raw: unknown): InstallScopeBlock | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const block = raw as { scopes?: unknown };
  if (!Array.isArray(block.scopes)) return undefined;
  const verbs = new Set(["read", "read+act", "act", "reveal"]);
  const filterOps = new Set([
    "eq",
    "ne",
    "lt",
    "lte",
    "gt",
    "gte",
    "in",
    "is-null",
    "not-null",
    "within-days",
    "within-next-days",
  ]);
  const scopes = block.scopes.flatMap((s: unknown) => {
    if (s === null || typeof s !== "object") return [];
    const scope = s as {
      schema?: unknown;
      table?: unknown;
      verbs?: unknown;
      rowFilter?: unknown;
      fieldMask?: unknown;
    };
    if (typeof scope.schema !== "string" || scope.schema === "") return [];
    if (typeof scope.verbs !== "string" || !verbs.has(scope.verbs)) return [];
    if (
      scope.table !== undefined &&
      (typeof scope.table !== "string" || scope.table === "")
    ) {
      return [];
    }
    if (
      (scope.rowFilter !== undefined || scope.fieldMask !== undefined) &&
      typeof scope.table !== "string"
    ) {
      return [];
    }
    let rowFilter: FilterClause[] | undefined;
    if (scope.rowFilter !== undefined) {
      if (!Array.isArray(scope.rowFilter) || scope.rowFilter.length === 0)
        return [];
      rowFilter = [];
      for (const rawClause of scope.rowFilter) {
        if (
          rawClause === null ||
          typeof rawClause !== "object" ||
          Array.isArray(rawClause)
        ) {
          return [];
        }
        const clause = rawClause as Record<string, unknown>;
        if (
          typeof clause.column !== "string" ||
          clause.column === "" ||
          typeof clause.op !== "string" ||
          !filterOps.has(clause.op)
        ) {
          return [];
        }
        rowFilter.push({
          column: clause.column,
          op: clause.op as FilterClause["op"],
          ...(Object.hasOwn(clause, "value") ? { value: clause.value } : {}),
        });
      }
    }
    let fieldMask: string[] | undefined;
    if (scope.fieldMask !== undefined) {
      if (
        !Array.isArray(scope.fieldMask) ||
        scope.fieldMask.length === 0 ||
        !scope.fieldMask.every(
          (field) => typeof field === "string" && field !== ""
        )
      ) {
        return [];
      }
      fieldMask = [...scope.fieldMask] as string[];
    }
    return [
      {
        schema: scope.schema,
        ...(typeof scope.table === "string" && scope.table !== ""
          ? { table: scope.table }
          : {}),
        verbs: scope.verbs as "read" | "read+act" | "act" | "reveal",
        ...(rowFilter ? { rowFilter } : {}),
        ...(fieldMask ? { fieldMask } : {}),
      },
    ];
  });
  if (scopes.length === 0) return undefined;
  return { scopes };
}

/** Every automation execution is attenuated, including manifests declaring no vault access. */
function executionScopeBlock(raw: unknown): InstallScopeBlock {
  return manifestScopeBlock(raw) ?? { scopes: [] };
}
