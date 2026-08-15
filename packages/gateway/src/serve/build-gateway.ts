// governance: allow-repo-hygiene file-size-limit orchestration hub already at the cap; pending split of the route-handler wiring into a sibling module
/*
 * `buildGateway()` — construct the host-agnostic centraid gateway core.
 *
 * Issue #280 made the vault the unit; issue #289 made (gateway, vault) the
 * address. The gateway core is one stable object graph (runtime, dispatcher,
 * prefs, route chain) whose PERSONAL surfaces all resolve through the vault
 * the CURRENT REQUEST is addressed to: `composedHandler` resolves the
 * request's vault (explicit `x-centraid-vault` header, else the default
 * vault) and runs the whole chain inside that ambient scope (see
 * `vault-context.ts`), so the conversation ledger, per-app data dirs, code
 * store, and `ctx.vault` bridges all land on the request's vault. There is
 * no server-global active vault: switching is a client-side view change the
 * server never observes, and N clients ride N vaults concurrently.
 *
 * Two hosts mount the same core:
 *
 *   - Electron embed: `buildGateway()` (or `serve()`) in the main
 *     process, paths derived from `gateway-paths.ts`.
 *   - `centraid-gateway` daemon: `serve()`, paths derived from a
 *     `--data-dir` config.
 *
 * Construction (stores → prefs loader → chat runner → `Runtime` → route
 * handlers) runs in `buildGateway()`; the per-vault host bundle (code
 * store, draft resolver, unified chat runner, store-backed route handlers,
 * cron scheduler) is built lazily per vault and cached by vault id. The
 * returned `start(publicBaseUrl)` mounts every vault's workspace and
 * starts + reconciles each vault's scheduler (issue #149), so automations
 * in every vault fire regardless of which vault any client looks at.
 */

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";

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
} from "@centraid/agent-runtime";
import type {
  CatalogSurface,
  HarnessKind,
  HarnessPrefs,
  SurfaceStatus,
} from "@centraid/agent-runtime";
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
} from "@centraid/app-engine";
import {
  AnalyticsStore,
  ASSISTANT_APP_ID,
  AUTHED_DEVICE_HEADER,
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
  makeJournalDbProvider,
  makeUserStoreRouteHandler,
  resolveSubsystemModel,
  resolveSubsystemHarnessLadder,
  validateTurnAttachmentRefs,
  TurnLimiter,
  prewarmAppAssets,
  workerAdmissionStats,
} from "@centraid/app-engine";
import * as automation from "@centraid/automation";
import {
  bundledAppDir,
  listBundledAppTemplates,
  listTemplates,
  readTemplateFiles,
} from "@centraid/blueprints";
import { KIT_DIR } from "@centraid/design/kit";
import { ROUTES } from "@centraid/protocol";
import {
  createTokenBucket,
  PEER_ENDPOINT_HEADER,
  PEER_PLANE_BUDGET,
} from "@centraid/tunnel";
import {
  KeyStore,
  recompileCommonsGrants,
  readBlobStoreSettings,
  readEnrichPolicyTier,
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
import {
  isSystemRecognitionRef,
  SYSTEM_RECOGNITION_TEMPLATE_IDS,
} from "../enrich/system-recognition.js";
import {
  closeJournalConversationStores,
  journalConversationStore,
} from "../journal-stores.js";
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
import { makeEdgeAnswerRouteHandler } from "../routes/edge-answer-routes.js";
import { EDGES_PATH, makeEdgesRouteHandler } from "../routes/edges-routes.js";
import {
  SEMANTIC_SEARCH_PATH,
  makeEnrichSearchRouteHandler,
} from "../routes/enrich-search-routes.js";
import { makeGatewayInfoRouteHandler } from "../routes/gateway-info-routes.js";
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
import { assertRouteSecurityCoverage } from "../routes/route-security.js";
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
import { WorktreeStore } from "../worktree-store/index.js";
import { isExpectedPrewarmSkip } from "./app-prewarm-errors.js";
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
import { buildDiagnosticsBundle } from "./gateway-diagnostics.js";
import { GatewayLogStore } from "./gateway-log-store.js";
import { GatewayPerformanceMonitor } from "./gateway-performance.js";
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
import type { PeerDial } from "./peer-edge-give-client.js";
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

const TIME_ENGINE_MODULE_URL = import.meta.resolve("@centraid/time-engine");

export interface BuildGatewayOptions {
  /** On-disk slots the runtime reads/writes. Caller-derived. */
  paths: GatewayPaths;
  /** Shared gateway.db handle when the host opened the process lock before constructing transports. */
  gatewayDatabase?: GatewayDatabase;
  /**
   * Optional shared-client OAuth courier coordinates. Hosts inject only
   * public values; confidential Google/HMAC secrets remain Worker-only.
   */
  assistOAuth?: AssistOAuthConfig;
  /**
   * Owner Resource mode (#521). When set (daemon config / tests), feeds
   * hardware-profile resolution. Durable prefs (`gateway.resourceMode`) win
   * over omission; `CENTRAID_RESOURCE_MODE` env still wins over both.
   */
  resourceMode?: ResourceMode;
  /**
   * Experimental feature gate (v0 early feedback). When a feature is off the
   * gateway does not advertise its capability, mount its routes, or start
   * its background work — durable data stays intact. Resolution per feature
   * is env (`CENTRAID_EXPERIMENTAL`) > durable prefs
   * (`gateway.experimental.*`) > this option > off; hosts and tests opt in
   * here, mirroring `resourceMode`.
   */
  experimental?: Partial<ExperimentalFeatureSet>;
  /**
   * The cron scheduler (issue #149) is gateway-owned and in-process: one
   * scheduler PER VAULT (issue #289 — every vault's automations fire, not
   * just the vault a client happens to look at), each a minute-boundary
   * timer firing enabled cron automations through the same `runAutomation`
   * path as "run now". There is no OS scheduler; missed minutes during
   * downtime are skipped (n8n semantics — no backfill). When this override
   * is injected (tests), it becomes the DEFAULT vault's scheduler; other
   * vaults get fresh `automation.InProcessScheduler`s.
   */
  scheduler?: automation.LocalScheduler;
  /** Logger forwarded to `Runtime`. Defaults to a `console.*` wrapper. */
  logger?: RuntimeLogger;
  /**
   * Tag prepended to log lines emitted by the gateway's own bootstrap
   * paths (currently just the scheduler-reconcile log). Hosts use this
   * to disambiguate multiple gateways in one process.
   */
  logTag?: string;
  /**
   * Maps an app id to the draft-session id the unified chat runner edits.
   * Defaults to a host-neutral `chat-<appId>`; the desktop injects
   * `desktop-<appId>` so its renderer Code tab + local builder + gateway
   * chat share ONE worktree.
   */
  sessionIdFor?: (appId: string) => string;
  /**
   * Device-plane access control (issue #289 phase 2). The composed handler
   * always resolves a real enrollment. A loopback embed that omits this seam
   * receives a persisted host enrollment keyed by the gateway endpoint id.
   */
  deviceAccess?: DeviceAccess;
  /** Host-selected custody backend for every gateway-level named secret. */
  keyStore?: KeyStore;
  /**
   * A host device EndpointId whose loopback requests are resolved by the
   * supplied deviceAccess seam. It is enrolled as the owner of the vaults a
   * fresh data dir auto-creates at construction (issue #603).
   */
  hostDeviceEndpointId?: string;
  /**
   * Direct host-custody check — an authenticated caller on this box that is
   * NOT an iroh-forwarded request (whose upstream socket is loopback too).
   * Gates the host-only lanes: pairing-ticket mint, owner administration,
   * and the cross-vault scopes listing.
   */
  isHostCustody?: (req: IncomingMessage) => boolean;
  /** Optional Rust byte-plane X-Sendfile handoff (issue #456 N3). */
  dataPlaneHttp?: DataPlaneHttpOptions;
  /** Auth callback used only by the native iroh relay on loopback. */
  dataPlaneControl?: DataPlaneControlOptions;
  /** Host-selected preview engine; daemon defaults to native sharp/libvips. */
  previewCodec?: PreviewCodec;
  /**
   * Enrollment/ticket plane used by proved iroh callers. HTTP ticket
   * redemption and per-device bearers were removed by issue #555.
   */
  devicePairing?: {
    enrollments: EnrollmentStore;
    tickets: PairingTicketStore;
    /**
     * The gateway's iroh EndpointTicket for a HTTP-minted pairing ticket's
     * `gw` field (`POST /centraid/_gateway/devices/ticket`), read lazily at
     * mint time. Undefined before the daemon has an endpoint.
     */
    endpointTicket?: () => string | undefined;
    /** Stable gateway identity derived from the endpoint secret. */
    endpointId?: () => string | undefined;
    /** Close Rust-owned iroh transports after a device loses its final enrollment. */
    onEndpointRevoked?: (endpointId: string) => void | Promise<void>;
  };
  /**
   * The gateway↔gateway peer lane (#726 P3 decision 6). Supplied by the host
   * that owns the peer forwarder; absent means this build serves no peer
   * plane at all, and every peer-marked request is `not_found`.
   *
   * `proof` is the per-boot secret ONLY the forwarder and the peer route
   * layer know. Nothing else in this file may read it.
   */
  peerPlane?: {
    proof: string;
    localRoute: () => { endpointId?: string; relayHints: string[] };
    /**
     * Outbound peer-plane dialing (#726 P3 decision 7): what lets THIS
     * gateway push a remote give, pull a closure back after a D9 'ask', and
     * background-pull original bytes. Absent means this build can receive
     * peer requests but never initiate one — a remote edge or a D9 accept
     * parks rather than reaching for a dial capability that isn't wired.
     * Production wiring of a real transport is a `packages/tunnel` concern,
     * mirroring how `redeemLinkTicket`/`pushRouteAssertion` are unwired here
     * too; tests inject the same in-process transport the link ceremony does.
     */
    dial?: PeerDial;
    /**
     * Peer-plane background sweep cadence override (tests only; production
     * uses the sweep's own default). Mirrors `notificationsDoorbellWindowMs`
     * below — tests shorten it, hosts leave it alone.
     */
    blobPullIntervalMs?: number;
  };
  /**
   * Durable PWA control sessions (issue #376). When `controlsFile` is set,
   * `WebControlSessions` persists CONTROL cookies there so a web pairing
   * survives a gateway restart / the sliding 30-day idle window instead of
   * forcing a fresh pairing ticket every 12h. `isDeviceValid` propagates
   * `devices revoke` to live control/app cookies (a revoked device's cookie
   * stops authorizing at once). Absent (desktop embed, tests) → in-memory
   * control sessions with no revocation hook, exactly the prior behavior.
   */
  webSessions?: {
    controlStore?: WebControlSessionStore;
    controlsFile?: string;
    isDeviceValid?: (deviceKey: string) => boolean;
  };
  /**
   * Turn driver for the unified builder/chat runner. Defaults to real
   * `runTurn` (ACP harnesses). Tests inject a stub so HTTP lifecycle paths
   * (e.g. headless automation compile) finish without spawning a coding
   * harness — issue #504 check:pr green on harnessless CI/local hosts.
   */
  runTurn?: RunTurnFn;
  /**
   * Offsite backup engine (PROTOCOL.md/FORMAT.md), off by default. When
   * `enabled`, `buildGateway` constructs a `BackupService` (component
   * `'backups'` on `health`), starts its hourly scheduler from `start()`,
   * and stops it from `stop()`. Disposable work lives under `paths.cacheDir`
   * (defaults to a `backup` sibling of `paths.vaultDir`).
   */
  backup?: BackupConfig;
  /**
   * Coalescing window for the Notifications doorbell (#647). Every journalled write
   * commit could otherwise recompute the whole Notifications projection and ring SSE
   * to every subscriber; a bulk connector sync would pay that per batch. The
   * first commit after idle fires promptly, the rest of the burst collapses
   * into one trailing recomputation. Tests shorten it; hosts leave it alone.
   */
  notificationsDoorbellWindowMs?: number;
}

/** Fires one automation. Shared by the cron scheduler + the turn-now route. */
export type FireAutomation = (
  automationRef: string,
  opts: {
    runId?: string;
    triggerKind: AutomationTriggerKind;
    triggerOrigin: AutomationTriggerOrigin;
    /** Trigger payload surfaced to the handler as `ctx.input` (condition/data fires). */
    input?: unknown;
    /** Human-readable trigger-gap/cursor note stored on the turn. */
    note?: string;
    /** Reuse a source-stable run id and replay an interrupted ledger turn. */
    idempotent?: boolean;
    /** Let the cursor engine retain its pending receipt on infrastructure failure. */
    propagateError?: boolean;
  }
) => Promise<{
  turnId: string;
  outcome?: automation.HandlerOutcome;
  record?: automation.RunRecord;
}>;

/** A route handler in the gateway chain: `true` when it owned the response. */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => Promise<boolean>;

export interface RoutePrefixRegistration {
  readonly prefixes: readonly string[];
  readonly handler: RouteHandler;
}

/** Register a handler in the immutable prefix table built at gateway boot (#456 R1). */
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

/**
 * Compile route families into a segment trie. Dispatch reads and strips the
 * request query exactly once, performs O(path-depth) map lookups, then invokes
 * only matching handlers from most-specific prefix to least-specific prefix.
 */
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
          // HANDLER_ERROR includes a vault bridge failure after the canonical
          // command committed but before journal finalization/transport
          // completed. GATEWAY_BUSY and any future infrastructure error are
          // likewise safe to retry. The route keeps the admitted intent in
          // `sending`; deterministic intent-bound invocation ids dedupe it.
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

// Prefixes the chat-history + prefs routes answer to, mirrored from
// app-engine's http-server.ts so `composedHandler` matches the same URLs
// `startRuntimeHttpServer` does.
const CONVERSATIONS_PREFIX = "/_centraid-conversations";
const USER_STORE_PREFIX = "/_centraid-user";

/** The per-vault host bundle — one per vault, built lazily, cached by id. */
interface VaultHost {
  vaultId: string;
  store: WorktreeStore;
  codeAppsDir: () => string;
  draftCodeDir: (
    appId: string,
    sessionId: string
  ) => Promise<string | undefined>;
  runner: ConversationRunner;
  /** Materialize the shipped recognition recipes into this vault's code store. */
  ensureSystemRecognitionRecipes: () => Promise<void>;
  /** Store-backed route handlers (apps-store / lifecycle / automations). */
  handlers: RouteHandler[];
}

export interface BuiltGateway {
  /** The constructed runtime (handles, dispatcher, change bus). */
  runtime: Runtime;
  /**
   * Component-level health, served at `GET /centraid/_gateway/health`.
   * Hosts report components the gateway can't see from inside (the
   * desktop's iroh tunnel, a daemon's disk watermark) via
   * `health.reportOk/reportDegraded/reportError`, and wrap host-side
   * loggers with `health.loggerFor(component, logger)` so their errors
   * join the same structured tail.
   */
  health: HealthRegistry;
  /**
   * The offsite backup service (PROTOCOL.md/FORMAT.md) — present only when
   * `BuildGatewayOptions.backup?.enabled`. `cli/backup-admin.ts` builds its
   * own instance from the same resolved config for one-shot CLI gestures;
   * this is the live, scheduled one `start()`/`stop()` drive.
   */
  backup?: BackupService;
  /** Gateway-wide device preferences stored in `gateway.db`. */
  prefs: PrefsStore;
  /** Run-summary rollup over the current request's journal.db. */
  analyticsStore: AnalyticsStore;
  conversationHistoryStore: ConversationHistoryStore;
  /**
   * The vault registry (duaility §12, #289): a warm map of mounted vault
   * planes keyed by vaultId. Hosts drive owner acts (grants, confirmations)
   * through this; vault create/delete are ADMIN acts (CLI); apps only ever
   * reach the request's vault via `ctx.vault`.
   */
  vaults: VaultRegistry;
  /**
   * The current request's vault's git-store backend (default vault outside
   * a request scope). Callers (the publish endpoint, export/import, the
   * desktop's file IPC) drive sessions + publishes through this. Async —
   * the store materializes lazily per vault.
   */
  appsStore: () => Promise<WorktreeStore>;
  /**
   * Resolves the current request's vault's live `main` worktree apps dir,
   * rotating atomically per publish/rollback. Hosts that register their own
   * automation surface resolve automation CODE through this. Throws before
   * `start()` has mounted the vault's workspace.
   */
  codeAppsDir: () => string;
  /**
   * Re-sync one vault's app registry off its live `main` (ensureUploaded +
   * enrollment + scheduler reconcile). `start()` runs this for every
   * mounted vault; callers that seed the store OUT OF BAND (tests, import
   * paths) call it to settle the registry without a restart.
   */
  syncApps: (vaultId?: string) => Promise<void>;
  /** Scoped cookie sessions used only by generated apps embedded in the browser PWA. */
  webControlSessions: WebControlSessions;
  /**
   * Route handlers run after auth, before `runtime.handle` (vault routes,
   * templates, agents, then the request vault's store-backed handlers).
   * NOTE: these resolve the request's vault from the ambient context —
   * mount them through `composedHandler` (which establishes it) unless the
   * host establishes the scope itself.
   */
  extraHandlers: RouteHandler[];
  /**
   * One handler owning the full chain: resolve the request's vault
   * (`x-centraid-vault` header → enrollment check → default), then replay
   * `conversation → prefs → extraHandlers[] → runtime.handle` inside that
   * vault's ambient scope — MINUS the bearer check (cf. `app-engine`
   * http-server.ts). Hosts that own auth themselves mount this on a single
   * prefix route. Always resolves the response, so it returns `true`.
   */
  composedHandler: RouteHandler;
  /**
   * The `/_centraid-hook/<id>` webhook-trigger route (issue #96), mounted
   * ahead of the bearer check (issue #304's `publicPathPrefixes`) — the
   * shared secret in the request IS the auth. Resolves the slug to its
   * OWNING vault across every mounted vault (webhook ids are globally
   * unique), durably accepts authenticated ingress, and nudges that vault's
   * cursor engine before answering 202. Returns `false` for any non-matching
   * URL so the host can fall through to `composedHandler`.
   */
  webhookHandler: RouteHandler;
  /**
   * The gateway's log ring buffer + live fan-out (realtime Logs surface).
   * Every `logger.*` line lands here before the console. Hosts may
   * `append()` their own lines (e.g. embed lifecycle) so they show up in
   * the same client-visible stream.
   */
  logs: GatewayLogStore;
  /**
   * Post-listener lifecycle. Call once the host has bound a socket,
   * passing the live origin so post-turn webhook minting can build
   * absolute `_centraid-hook` URLs. Mounts EVERY vault's workspace, then
   * starts + reconciles each vault's cron scheduler.
   */
  start: (publicBaseUrl: string) => Promise<void>;
  /** Stop every vault's cron scheduler. Idempotent. */
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
  // Every log line tees through the gateway log store (realtime Logs
  // surface) before reaching the console/host logger — see logs-routes.ts.
  // Persistence (issue #351) is opt-in via `paths.logsDir` — omitted, this
  // is exactly the prior in-memory-only store (tests, disposable embeds).
  const logStore = new GatewayLogStore(
    undefined,
    paths.logsDir ? { dir: paths.logsDir } : {}
  );
  const logger = logStore.wrap(options.logger ?? defaultLogger(options.logTag));

  // Component-level health (observability for self-hosters): subsystems
  // report ok/error at their own success/failure points, warns/errors land
  // in a structured ring buffer, and `GET /centraid/_gateway/health`
  // aggregates it all. Hosts push externally-owned components (e.g. the
  // desktop's iroh tunnel) through `BuiltGateway.health`.
  const health = new HealthRegistry();
  // Push-only components must exist before their first error; otherwise a
  // never-exercised registration is invisible to the R3 expected-list drill.
  health.registerExpectedPushComponents();
  const performanceMonitor = new GatewayPerformanceMonitor();
  // Per-route duration histograms (issue #659 R5) — recorded in
  // `composedHandler` below, read only when a health snapshot is taken.
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
  // Resource mode (#521): durable prefs + optional daemon config feed the
  // same profile resolver as CENTRAID_HARDWARE_PROFILE. Prefs open early so
  // boot class matches what the owner last chose; a mode change after boot
  // is durable and applies on the next serve (worker env is process-scoped).
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
  // Durable per-knob UI overrides (#528 Phase F). The resolver keeps env > prefs
  // > preset per knob; a knob change is durable and applies on the next serve,
  // identical to mode. Running-vs-desired legibility is the client comparing
  // health's structured profile with saved prefs — nothing extra here.
  const resourceKnobPrefs = parseResourceKnobPrefs(earlyPrefs);
  // Experimental feature gate (v0 early feedback): automations + connectors
  // ship in the binary but default OFF. Off hides surface — routes,
  // capability advertisement, cron/event scheduling — never data. The engine
  // seams stay wired regardless: capture OCR and semantic search fire
  // system recognition recipes through `fireAutomation`, and the vault
  // plane's consent outbox drains through the connection broker.
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
  // Ground-truth sizing (#528 Phase E): probe cgroup CPU/memory quotas and one
  // cumulative CPU-steal sample so the resolver sizes the granted share of the
  // host, not the raw machine. All reads are failure-tolerant → nulls on a
  // plain host, which resolve to today's unchanged numbers.
  const hostLimits = probeHostLimits();
  const hardwareProfile = resolveGatewayHardwareProfile({
    ...(storageFsyncMs === undefined ? {} : { storageFsyncMs }),
    cgroupCpuLimit: hostLimits.cgroupCpuLimit,
    cgroupMemoryLimitBytes: hostLimits.cgroupMemoryLimitBytes,
    stealPercent: hostLimits.stealPercent,
    resourceMode,
    prefsOverrides: resourceKnobPrefs,
  });
  // App-engine's worker/compression seams initialize lazily, after this boot
  // probe. Publish the resolved class so slow storage and explicit overrides
  // select the same actual limits that this health line reports.
  process.env.CENTRAID_RESOLVED_HARDWARE_PROFILE = hardwareProfile.class;
  // Publish the exact resolved values, including validated operator
  // overrides. Lazy consumers read these values instead of independently
  // reclassifying the host and drifting from this health record.
  process.env.CENTRAID_WORKER_MAX_CONCURRENT = String(
    hardwareProfile.workerMaxConcurrent
  );
  process.env.CENTRAID_WORKER_MAX_OLD_GENERATION_MB = String(
    hardwareProfile.workerMaxOldGenerationMb
  );
  process.env.CENTRAID_WORKER_POOL_SIZE = String(
    hardwareProfile.workerPoolSize
  );
  process.env.CENTRAID_REPLICATION_CONCURRENCY = String(
    hardwareProfile.replicationConcurrency
  );
  process.env.CENTRAID_STATIC_BROTLI_QUALITY = String(
    hardwareProfile.staticBrotliQuality
  );
  process.env.CENTRAID_STATIC_GZIP_QUALITY = String(
    hardwareProfile.staticGzipQuality
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

  // Bundled blueprint apps (issue #434): the main client compiles their UI
  // directly, while the gateway reads their shipped directories for metadata,
  // declared scopes, and generic opaque-app compatibility. Their ids are
  // RESERVED — a code-store app must never shadow one. The set is fixed for
  // the process lifetime (it's the release's catalog), so resolve it once for
  // the id-reservation guard and install/listing paths below.
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
  // Lifecycle creation/clone must not let member code shadow the stable ids
  // capture and capability settings address. UI blueprints and recognition
  // recipes differ in how they are installed, but both are shipped ids.
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

  // Gateway-level storage state is in gateway.db; its credential-encryption
  // key is a KeyStore envelope under keys/.
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
  // Provider usage cache (issue #367 §D1) — cache-with-TTL + stale-while-
  // refresh in front of a provider connection's optional `usage` capability
  // (PROTOCOL.md § Usage). Never polls on its own timer; see storage-usage.ts.
  const storageUsage = new StorageUsagePoller({ storageConnections });
  // The owner's two local-disk limits (issue #544), stored beside the
  // connections for the same reason. Loaded ONCE here so every later reader
  // — the routes, the `storage-limit` probe, and each vault plane's sweep —
  // shares one instance and sees a change without a restart.
  const storageLimits = new StorageLimitsStore(gatewayDatabase);
  await storageLimits.load();

  // Model price catalog (issue #445) — seed the app-engine pricing seam from a
  // fresh-enough disk cache and kick a background LiteLLM refresh. Costing works
  // from the bundled snapshot regardless; this only overlays fresher rates. The
  // cache file sits beside `model-catalog.json` when the host pins one.
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

  // Vault registry (duaility §12, #289): the gateway is a landlord hosting
  // N sovereign vaults — one plane per vault under the root, every request
  // addressed to exactly one of them. Required: post-#280 the whole app
  // surface (code, data, transcripts) is vault-scoped, so there is no
  // vault-less mode.
  // Planes are mounted before schedulers are constructed, so the injected
  // commit-time doorbell closes over this late-bound host callback. A write
  // during bootstrap simply drops the hint; the standing poll remains the
  // crash/startup correctness backstop.
  // Per-subsystem resource ACTUALS (#528 Phase C): a boot-time accounting
  // instance every background subsystem reports completions to. Honest measured
  // proxies only — counts, bytes, wall-clock, OS-reported CPU/RSS. Harness-run
  // usage is MEASURED and labeled here, never throttled. Published on the health
  // metrics source below; the worker-pool counters are read live from the
  // app-engine admission gate (which must not depend on the gateway).
  const resourceAccounting = new ResourceAccounting({
    workerPoolStats: workerAdmissionStats,
  });

  // Host power-context posture (#528 Phase D): a third, independent "not now"
  // signal composed into the SAME safe-loop gate as the owner pause and the
  // load-shed — never a durable mode flip, never touching the owner's pause.
  // The boot probe reads the host battery; the Electron desktop pushes live
  // state. Posture is a COURTESY, so the health component stays `ok` and only
  // its detail changes as deferral toggles.
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

  // Wrap a turn driver so every harness turn's wall-clock (spawn→exit) is
  // MEASURED and labeled (#528 Phase C) — recorded on success and failure
  // alike, since the host consumed the time either way. This ONLY accounts;
  // it never gates, defers, or throttles a run.
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
    { timer: NodeJS.Timeout; pending: boolean }
  >();
  // Restore quarantine can create a fresh decision while the registry mounts,
  // before the relay exists. Hold those content-free wakes until the relay is
  // constructed instead of dropping the boot-time doorbell.
  const pendingNotificationsWakes = new Set<string>();
  let requestNotificationsWake: (vaultId: string) => void = (vaultId) => {
    pendingNotificationsWakes.add(vaultId);
  };
  let nudgeCommonsSweep = (): void => undefined;
  /**
   * The replica executor a co-hosted Commons seat catches up through (#750
   * invariant 7): the SEAT's own gateway on the canonical rail, seeded so a
   * replayed command mints exactly the ids the steward minted. Host-only —
   * assembled from locally mounted material, never reachable from member or
   * app code, and never serialized. A vault that is not mounted cannot
   * replay, which the caller answers by re-projecting from the closure.
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
      { command, input, purpose: "dpv:ServiceProvision", invocationId },
      { idSeed: invocationId }
    );
  };
  const vaultRegistry: VaultRegistry = openVaultRegistry({
    rootDir: paths.vaultDir,
    synchronous: hardwareProfile.sqliteSynchronous,
    replicationConcurrency: hardwareProfile.replicationConcurrency,
    // One memory ceiling for ALL mounted planes, divided among them (#659 L8).
    // Previously mmap window and page cache were per-FILE constants, so a
    // household with five vaults paid five times the memory of one — linear in
    // vault count on exactly the small always-on box that cannot afford it.
    // A single mounted vault still gets the default budget in full, so the
    // common case is byte-identical; what changes is that the second vault no
    // longer doubles the bill. A standard host gets twice the ceiling of a
    // constrained one, because the constrained class IS the target hardware
    // and the ceiling should not be set by the machine that can spare it.
    footprintBudget:
      hardwareProfile.class === "constrained"
        ? DEFAULT_VAULT_FOOTPRINT
        : {
            mmapBytes: DEFAULT_VAULT_FOOTPRINT.mmapBytes * 2,
            cacheBytes: DEFAULT_VAULT_FOOTPRINT.cacheBytes * 2,
          },
    sweepIntervalMs: hardwareProfile.vaultSweepIntervalMs,
    // Vault sweeps are a safe loop: defer under event-loop pressure, honor
    // the owner's explicit background-pause, AND yield to host power-context
    // posture — on battery / low battery / thermal (#528 Phase B + D).
    // Durability loops (WAL, outbox) call `shouldDeferBackgroundWork` alone
    // and are never paused or posture-gated.
    shouldDeferBackgroundWork: () =>
      health.shouldDeferBackgroundWork() ||
      health.shouldPauseBackgroundWork() ||
      powerContext.isDeferringBackgroundWork(),
    // gateway.db owns the WAL lifecycle unconditionally. Only the capture
    // clock sleeps when no backup destination exists, preserving the
    // low-end no-unconfigured-spool contract without reviving lease gating.
    walCaptureConfigured: () => walCaptureConfigured,
    // Disposable harness cache lives outside the vault tree (defaults to a
    // `-cache` sibling of `vaultDir` when the host doesn't pin one).
    cacheRootDir: paths.cacheDir ?? path.join(dataDir, "cache"),
    logger: health.loggerFor("vaults", logger),
    keyStore: gatewayKeys,
    // Network mounts may not honor the local SQLite lock cross-host. Serving
    // remains available, but destructive orphan GC fails safe.
    skipOrphanDelete: () => gatewayDatabase.networkFileSystem,
    // Storage-connection-backed credential resolution (issue #367 §C3):
    // supersedes the legacy `CENTRAID_S3_*` env-var lane for any vault whose
    // `blob_store.connectionId` is set; vaults without one keep working off
    // the env-var default (`vault-plane.ts`'s `defaultEnvS3Credentials`).
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
    // Preview backstop codec (issue #405 §2): the gateway holds plaintext on
    // ingest inside the owner's trust boundary, so generating tiny/medium
    // derivatives here leaks nothing to the provider. One shared stateless
    // codec instance fans out to every mounted plane's blob sweep, closing the
    // "no raster codec in the runtime" gap for imported / weak-client /
    // server-ingested images (capable clients still generate at capture).
    previewCodec: options.previewCodec ?? createImagePreviewCodec(),
    // Resource actuals (#528 Phase C): a vault lifecycle sweep is both a sweep
    // pass and a background timer fire; detached blob replication reports its
    // own bytes/busyMs. Accounting only — never gates the sweep.
    onSweepPass: (info) => {
      resourceAccounting.recordSweepPass(info);
      resourceAccounting.recordBackgroundTimerFire();
    },
    onReplicationPass: (info) => resourceAccounting.recordReplicationPass(info),
    // Size-triggered ledger archive (issue #544). Read through the shared
    // store's in-memory copy so a limit change applies on the next sweep of
    // every mounted plane without a remount, and without the sweep awaiting
    // a file read inside its synchronous block.
    journalLimitBytes: () => storageLimits.current().journalLimitBytes,
  });
  /*
   * Auto-found (issue #603). A gateway whose data dir carries no vault is
   * not a state a human should have to resolve: there is no ceremony, no
   * ticket, and no first-run wall. Constructing over a fresh dir creates the
   * founder's one personal vault synchronously, before any route can observe a
   * zero-vault gateway. Shared vaults are created later as an explicit owner
   * action; founding no longer creates a household-sharing destination.
   *
   * The vault is marked at founding with the durable `personal` flag in its
   * own `core_vault.settings_json`. Unscoped requests and a pair ticket
   * minted without an explicit target land there. The marker survives the
   * fresh path renaming "Personal" to the owner's display name.
   *
   * `isFresh()` reads the filesystem registry, which counts a vault dir that
   * FAILED to mount — so corruption never re-founds over existing data. A
   * non-fresh data dir is left exactly as it was found.
   *
   * The owners guard covers the other resurrection path: erasing every
   * vault leaves the filesystem fresh but keeps `owners`/`devices` rows in
   * gateway.db (only that vault's `vault_owners` row goes). A data dir that
   * has EVER enrolled an owner is an inhabited gateway awaiting restore, not
   * a fresh install — auto-founding over it would silently bury
   * restore-after-erase under a brand-new personal vault.
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
  // The founded vault belongs to the founding owner (`vault_owners`, written
  // by the enrollment below). There is no default share destination any more
  // (#726) — a destination is a vault you own and create explicitly.

  // Vault mounts are pull-checked at snapshot time — nothing pushes when a
  // plane silently fails to open, so the probe asks the registry directly.
  // `rescan()` here is what turns a failed mount from "gone until process
  // restart" into "retried on the next health tick" (issue #351) — the
  // backoff that keeps that cheap lives in `VaultRegistry` itself.
  // A mounted plane whose directory carried a restore-quarantine marker
  // (FORMAT.md restore rule 4) stays flagged here until an operator
  // resolves it — outbox is auto-parked (vault-quarantine.ts), automations
  // are NOT, deliberately (see that module's header).
  //
  // "ok" here used to mean only "the plane object is in memory" — it never
  // proved the SQLite file behind it was still readable (issue #351). Each
  // tick now runs one trivial statement against every mounted plane's
  // `vault.db` handle; a plane whose file was corrupted or closed out from
  // under the process (disk failure, external `rm`) fails this and flips
  // the component red by vault id instead of staying silently "ok".
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
    // Zero mounted planes is not a legal steady state since #603 — a fresh
    // data dir auto-founds, so an empty registry means every vault dir on
    // disk was deleted out from under the process.
    return planes.length > 0
      ? {
          status: "ok",
          detail: `${planes.length} vault${planes.length === 1 ? "" : "s"} mounted`,
        }
      : { status: "error", detail: "no vault is mounted" };
  });

  // Disk watermark (issue #351): free space on the vault volume, plus a
  // cheap per-vault DB size so "which vault is eating the disk" doesn't
  // need a shell. Thresholds live in disk-health.ts.
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

  // Local footprint by component (issue #544) — the other half of the disk
  // story: `disk` above says how much room is LEFT, this says where Centraid's
  // own bytes went. One scanner instance shared by `GET storage/local` and the
  // `storage-limit` probe below, so the page and the health badge can never
  // report different totals. The walk is TTL-cached; nothing puts it on a timer.
  const localUsage = new LocalUsageScanner({
    rootDir: dataDir,
    vaults: () =>
      vaultRegistry.planesList().map((p) => ({
        vaultId: p.boot.vaultId,
        dir: p.dir,
        // The harness scratch lives OUTSIDE the vault tree; bill it to the
        // vault it belongs to rather than to a nameless gateway bucket.
        ...(p.cacheDir && p.cacheDir !== p.dir ? { cacheDir: p.cacheDir } : {}),
      })),
    gatewayDirs: () => ({
      cache: paths.cacheDir,
      logs: paths.logsDir,
      templates: paths.templatesCacheDir,
    }),
  });

  // The owner's disk budget (issue #544). Warn-only by design — see
  // storage-limits.ts for why a soft budget must never refuse a write. With
  // no limit set this is a permanent `ok`, so an owner who never opted in
  // gains no new noise in their component list.
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

  // Connection health lives in each vault's DB (`needs-auth` flips there,
  // not in broker memory) — surface "N connections need re-auth" so a dead
  // OAuth token shows up here instead of as silent connector failures.
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

  // Broker credential health (issue #351 tier 2): narrower than `connections`
  // above — specifically the ConnectionBroker's own custody of
  // broker-carried (oauth2/api_key) credentials, naming which ones are dead
  // or sitting on an overdue token nobody has refreshed yet. See
  // `broker-health.ts` for why this is a separate signal from `connections`.
  health.registerProbe(
    "broker",
    createBrokerHealthProbe({
      vaults: () =>
        vaultRegistry
          .planesList()
          .map((p) => ({ vaultId: p.boot.vaultId, db: p.db.vault })),
    })
  );

  // The one journal handle per vault (`journal-stores.ts`) — the same
  // `makeJournalDbProvider` binding `fire.ts` and the analytics stores use,
  // so the conversation-ledger band (`automation_state` included) exists
  // before anything reads/writes it, regardless of tick timing.
  const journalStoreFor = (vaultId: string): ConversationStore => {
    const plane = vaultRegistry.get(vaultId);
    if (!plane) throw new Error(`gateway: unknown vault "${vaultId}"`);
    return journalConversationStore(plane.workspace.journalDbFile);
  };

  // Scheduler ledger (issue #351 tier 2): written from each vault's scheduler
  // `onTick` hook below; read by the `scheduler` liveness probe and by
  // `automations`'s reconcile push. Memoized so a health poll or a scheduler
  // tick never reconstructs it.
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

  // Per-vault scheduler liveness + missed-run visibility (issue #351 tiers
  // 2/3) — see scheduler-health.ts. Reads the SAME ledger `onTick` writes.
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

  // Enricher run health (issue #351 wave 4) — see enrichment-health.ts for
  // why this is narrower than `automations`/`automation-runs`. Run history
  // reads the shared per-vault journal store; it never reaches into
  // scheduler-ledger.ts's private state.
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

  // Blob custody-sweep health (issue #351 wave 4, #367 prep) — see
  // blob-sweep-health.ts. `s3Configured`/`counts` are cheap synchronous
  // reads (settings JSON + a GROUP BY over the custody mirror); `sweepStatus`
  // reads `BlobCustody`'s own in-memory record of its last `reconcile()`.
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

  // On-disk integrity (issue #374 tier 5b) — see vault-integrity-health.ts.
  // Self-throttled per vault at a SIZE-SCALED cadence, one vault per tick
  // (#659 L6); distinct from the `vaults` probe above, which only proves the
  // file still opens. The startup grace keeps a full-file read out of boot —
  // the first minutes after start are when the owner is actually waiting on the
  // gateway, and corruption that has been there since the last shutdown will
  // still be there five minutes later (#659 G10).
  health.registerProbe(
    "vault-integrity",
    createVaultIntegrityHealthProbe({
      vaults: () =>
        vaultRegistry.planesList().map((p) => ({
          vaultId: p.boot.vaultId,
          vault: p.db.vault,
          journal: p.db.journal,
        })),
      startupGraceMs: 5 * 60_000,
    })
  );

  // Storage quota watermark (issue #367 §D2) — degraded/error off a
  // provider-reported quota only (see storage-quota-health.ts); reads the
  // SAME cache `GET storage/usage` serves, so this never issues its own
  // network call beyond what that poller's TTL already allows.
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

  // Numeric signals (issue #351 tier 3): outbox backlog, summed across
  // mounted vaults — cheap COUNT(*) at snapshot time, same style as the
  // `connections` probe above. `rssBytes`/`uptimeMs` need no wiring (see
  // `HealthRegistry.snapshot`). `sseClients` sums three production SSE
  // surfaces' live subscriber counts — `logsEventsSubscriberCount` /
  // `turnEventsSubscriberCount` (issue #351's SSE subscriber-cap change,
  // `sse-cap.ts`), each backed by the SAME `SseSubscriberCap` instance
  // `makeLogsRouteHandler`/`makeAutomationsRouteHandler` admit through below,
  // plus `@centraid/app-engine`'s `changesSubscriberCount()` — the per-appId
  // `_changes` cap `Runtime.handle` admits every subscriber through — so
  // this is the real live count across every SSE surface this process
  // serves, not a separate tally.
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
      // The denominator for rssBytes (#659 L8): plane memory RESERVATIONS are
      // now flat in vault count, but residency is not, so this is what makes
      // "five vaults cost more than one" visible rather than inferred.
      mountedVaults: vaultRegistry.planesList().length,
      hardwareProfileClass: hardwareProfile.class,
      resourceMode: hardwareProfile.resourceMode,
      resourceProfile: toStructuredResourceProfile(hardwareProfile),
      // Measured per-subsystem actuals (#528 Phase C) — CPU/RSS read lazily
      // here at the health-poll cadence, subsystem counters accumulated at
      // their completion hooks.
      resourceUsage: resourceAccounting.snapshot(),
      // Host power-context posture (#528 Phase D) — battery/mains/server and
      // whether background work is being courteously deferred right now.
      powerContext: powerContext.snapshot(),
    };
  });

  // Offsite backup engine (PROTOCOL.md/FORMAT.md). A static daemon config
  // still takes precedence; otherwise the service resolves the provider
  // storage connection marked for backup on every operation. This makes a
  // connection created in the desktop immediately effective without a
  // process restart or a second, hidden configuration source.
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
    // Retention/reconciliation is a safe loop — yield to host power-context
    // posture too (#528 Phase D). Threaded as a predicate so BackupService
    // never imports the monitor. The WAL drain stays ungated (RPO durability).
    shouldDeferPosture: () => powerContext.isDeferringBackgroundWork(),
    // Resource actuals (#528 Phase C): each WAL drain is a backup pass and a
    // backup-scheduler timer fire. Accounting only.
    onDrainAccounted: (info) => {
      resourceAccounting.recordBackupDrain(info);
      resourceAccounting.recordBackgroundTimerFire();
    },
    // Owner-held backup (#726 P1): skip + report a vault this machine's
    // backup configuration is not authorized for, instead of silently
    // shipping someone else's data. `enrollmentStore`/`hostOwnerEndpointId`
    // are declared below — safe, since these closures only run once a
    // backup actually fires, well after boot completes.
    ownerOf: (vaultId) => enrollmentStore.owners.ownerOf(vaultId),
    authorizedOwnerId: () =>
      hostOwnerEndpointId
        ? enrollmentStore.ownerFor(hostOwnerEndpointId)?.ownerId
        : undefined,
  });

  const enrollmentStore =
    options.devicePairing?.enrollments ?? EnrollmentStore.open(gatewayDatabase);
  // The same-machine link ceremony a cross-owner edge needs (#726 P2 §3).
  const vaultLinksStore = new VaultLinksStore(gatewayDatabase);
  /*
   * The host's own device identity. A gateway the owner runs on their own
   * box is reachable over loopback with no iroh pairing, so it needs a
   * device key of its own to be enrolled under. The daemon injects one
   * (`hostDeviceEndpointId`); a loopback-only embed derives one from the
   * KeyStore-custodied endpoint key. Only a caller that supplies its own
   * `deviceAccess` resolver opts out — it answers "who is this" itself.
   */
  const embeddedEndpointId = options.deviceAccess
    ? undefined
    : (options.hostDeviceEndpointId ??
      kitlessHostIdentity(gatewayKeys.loadOrCreate("endpoint-key.bin")));
  const embeddedAccess: DeviceAccess | undefined = embeddedEndpointId
    ? {
        // Deliberately `isLoopbackRequest`, not `isDirectHostRequest`: the
        // desktop phone tunnel forwards a paired phone under the host bearer
        // and has no device key of its own, so tightening this would sever
        // phone-link entirely. Host-ONLY capabilities use the stricter gate
        // (`isHostCustody` below); ordinary vault access does not.
        //
        // The peer lane is the one exception that must be excluded here: a
        // peer forwarder also delivers to loopback, so without this check a
        // linked gateway would resolve to the HOST's device key and inherit
        // owner-tier reach. A link's reach is the peer plane or nothing —
        // the same refusal the daemon's `deviceKeyFor` makes (#726 P3).
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
    // One founding owner, owner of the auto-founded personal vault, in ONE
    // transaction (issue #603): the host that just founded it is its owner,
    // and a fresh install has exactly one owner with zero unassigned bindings.
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

  /*
   * Every owner owns at least one vault (#726 P1). The host-custody
   * `POST /owners` lane creates the person but not a vault, so boot mints
   * "<label>'s vault" on THIS machine for anyone still ownerless. Naturally
   * idempotent — an owner who already owns a vault (including one just
   * minted above, or one this loop minted on a prior boot) is skipped.
   * Devices stay enrolled to their owner; content stays where it is.
   */
  for (const owner of enrollmentStore.owners.list()) {
    if (enrollmentStore.owners.vaultsOwnedBy(owner.ownerId).length > 0)
      continue;
    const minted = vaultRegistry.create(`${owner.label}'s vault`);
    enrollmentStore.owners.setOwner(minted.vaultId, owner.ownerId);
  }

  const currentWorkspace = (): VaultWorkspace =>
    vaultRegistry.currentWorkspace();

  // Device prefs (`gateway.db`) + the request vault's ledger stores. The
  // analytics/insights providers resolve the request's vault per call, so
  // every client sees its own vault's ledger (#289). Reuse the early prefs
  // handle opened for Resource mode so we don't re-read the same file.
  const prefs = prefsEarly;
  const journalProvider = () => currentWorkspace().journal();
  const harnessHealthStore = new HarnessHealthStore(journalProvider);
  // `harness-failover` is reported degraded when a rung hands off. Nothing used
  // to report it healthy again, so a single failover left `/health` degraded
  // forever. A later harness turn that actually succeeded is the honest signal
  // that the component recovered, so it is cleared here — and only when it was
  // degraded, so a healthy gateway never registers the component at all.
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
      // A completed turn is stronger evidence than a capability probe: the
      // harness authenticated and answered. Auth breakers are otherwise
      // indefinite and only ever closed by the harnesses route's explicit
      // refresh, so a working harness could stay condemned indefinitely.
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
  // Lazy archive rehydration (issue #438 wave 3): opening a conversation whose
  // cold ranges were custody-gated-pruned reads the sealed segment blobs back
  // through the ACTIVE vault's CAS door (`db.blobs.open` — local hit or remote
  // fetch → unseal → verify → promote). Resolved per call via `current()` — the
  // SAME active-vault resolution `currentWorkspace` uses — so a vault switch
  // reads the right file. The store degrades to `archiveUnavailable` if a fetch
  // fails; the standalone http-server host wires no reader at all.
  const conversationHistoryStore = new ConversationHistoryStore(
    currentWorkspace,
    {
      archiveBlobReader: (sha) => vaultRegistry.current().db.blobs.open(sha),
    }
  );

  // Per-turn prefs loader. Re-reads `gateway.db` every conversation turn so a
  // settings change lands without a restart.
  //
  // Harness selection is PER SUBSYSTEM: `harness.<subsystem>` pins one
  // register (assistant/ask/builder/automations) to a harness; unpinned
  // registers inherit `harness.kind`, which is now "the default harness"
  // rather than "the one active harness". Callers that don't name a
  // subsystem get the default harness — byte-identical to the old behavior,
  // which is what keeps a prefs file with no `harness.*` keys working
  // exactly as it did.
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

  // Per-subsystem model resolution (shared prefs contract): explicit
  // (request/manifest) → `model.<harnessKind>.<subsystem>` → `model.<harnessKind>.default`
  // → nothing (the backend's own built-in default).
  //
  // The harness is resolved FIRST, for THIS subsystem, and that kind is what
  // scopes the model key. Model prefs are per harness (`model.<kind>.<sub>`),
  // so reading them against the global kind while the subsystem actually runs
  // on a different one hands the turn a model its backend has never heard of.
  // Both halves come off the same per-turn `prefsLoader` every register reads,
  // so a re-pin lands mid-session without a restart.
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

  // One warmer owns host-capability enumeration — the model list, for every
  // harness — shared by the boot probe and the status routes so concurrent
  // warms dedupe (a client Refresh mid-boot joins the boot warm). The
  // enumerator honors the active harness's binPath/extraArgs; inactive harnesss
  // enumerate with defaults. (The tool surface this warmer once also tracked
  // went away with the `ctx.tool` rail — issue #484.)
  const catalogPath = paths.modelCatalogFile;
  // Catalog warms are best-effort; failures record as tagged warn events
  // (visible in `_gateway/health`) without flipping any component red.
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

  // Read + refresh contract for a catalog surface: a Refresh (or a cold cache
  // nobody has warmed yet) kicks the warmer fire-and-forget; the response
  // carries whatever's cached now plus the tri-state so the client knows
  // whether to poll. `ready` wins over `loading`, so a Refresh over an
  // existing list keeps showing it.
  //
  // The `hasWarmed` guard is load-bearing: a harness that self-reports no
  // models (opencode, grok) leaves the cache empty forever, and re-kicking a
  // warm on every poll kept `isWarming` true at read time — `loading` that
  // never resolved. Once the question has been asked, an empty cache reports
  // `empty` and an explicit Refresh is the way to ask again.
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
  // The binary the agents route should probe for a kind. Only the kind the
  // owner actually configured carries an override (`harness.binPath` is
  // one global slot, not a per-kind map) — the same "is this the active
  // harness" rule the catalog warmer applies. This is what makes the custom
  // `acp` kind reportable: it ships no default binary, so it stays
  // unavailable until its path is configured and selected.
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

  // Ask-model picker (kit Ask panel, subsystem `ask`) — GET/PUT
  // `/centraid/<appId>/_turn/model`. Reads/writes the SAME
  // `model.<harnessKind>.ask` prefs key `resolveModel` resolves at turn
  // time — where `<harnessKind>` is ASK's resolved harness, not the default
  // harness, so the picker never reads one key and writes another once the
  // owner pins `harness.ask`. Off the SAME catalog surface the desktop's Settings → Agents
  // picker reads (`resolveCatalogModels`) — one source of truth, no second
  // store. A cold/empty catalog just means an empty `catalog` list; the
  // picker still shows "Use default".
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

  // Cycle break: the chat runner needs the Runtime's dispatcher, but
  // the Runtime is constructed *with* the chat runner. The runtimeRef
  // holder resolves at call time, after the assignment below.
  let runtimeRef: Runtime | undefined = undefined;
  const getDispatcher = (): Runtime["dispatcher"] => {
    const rt = runtimeRef;
    if (!rt)
      throw new Error("chat runner invoked before runtime was constructed");
    return rt.dispatcher;
  };
  // The harness builds webhook URLs against the live server origin, known
  // only after `startRuntimeHttpServer` resolves below — a turn only ever
  // runs post-start, so this holder is populated by then.
  let serverUrl = "";

  // ── Per-vault host bundles (#280, #289) ───────────────────────────────
  // Each vault owns its app world: a git code store under the vault dir,
  // a draft resolver seeded from the vault's own live data, a unified chat
  // runner over that store, and the store-backed route handlers. Built
  // lazily per vault, cached by id; the request's one resolves per call.
  const hosts = new Map<string, Promise<VaultHost>>();
  // Synchronous handles to MOUNTED hosts — the schedulers + the webhook
  // route resolve code paths through these between requests (all only run
  // post-start, when every boot-time vault is mounted).
  const settledHosts = new Map<string, VaultHost>();
  // In-process bus for live run streaming (issue #158): a fire publishes via
  // `onRunEvent`; the `run/events` SSE endpoint subscribes by runId.
  const runEventBus = new RunEventBus();
  const automationConversationLocks = new Map<string, Promise<void>>();
  // Detached automation lifecycle work started behind a 202 (compile,
  // revision). `stop()` drains this before the vault registry closes its
  // databases, so shutdown cannot land mid-`closeItem` or orphan an ACP
  // child (issue #541 review).
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

  // The connection broker (issue #304): resolves a connector's broker-carried
  // credential (oauth2/api_key sealed on the connection row) per fire —
  // refresh under a per-connection single-flight, values injected transport-
  // side, never handed to handler code. Resolves the CURRENT vault's plane at
  // call time, exactly like `vaultFor` below.
  const connectionBroker = new ConnectionBroker(
    () => vaultRegistry.current(),
    undefined,
    options.assistOAuth,
    undefined,
    undefined,
    health.loggerFor("connections", logger)
  );

  // The outbox executor (issue #306): the only writer on the broker's
  // `allowWrites` lane, draining owner-approved / grant-matched items. It
  // runs OUTSIDE the fire loop — kicked after owner approvals, after each
  // fire (grant-matched items a connector just staged), and on a slow clock.
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

  // Install-time scopes (issue #306 decision 2): enrolling an app grants the
  // vault block its manifest declares — installing IS the consent. Read off
  // the app's live `main` app.json; malformed or absent blocks grant nothing.
  const grantScopesFromDir = async (
    plane: VaultPlane,
    appId: string,
    dir: string | undefined
  ) => {
    if (!dir) return;
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(dir, "app.json"), "utf8")
      ) as {
        vault?: { purpose?: unknown; scopes?: unknown };
      };
      const block = manifestScopeBlock(raw.vault);
      if (block) plane.ensureAppInstallGrant(appId, block);
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
    // Code-store apps (scaffolds, clones, compiled automations): read the
    // live `main` app.json.
    await grantScopesFromDir(
      plane,
      appId,
      await store.resolveActiveAppDir(appId)
    );
  };
  // Installed bundled apps (issue #434) declare their scopes in the shipped
  // blueprint's app.json — read it there, not from the (empty) code store.
  const grantDeclaredBundledScopes = (
    plane: VaultPlane,
    appId: string
  ): Promise<void> => grantScopesFromDir(plane, appId, bundledAppDir(appId));

  const prewarmApp = async (appId: string, dir: string): Promise<void> => {
    try {
      const result = await prewarmAppAssets(dir, KIT_DIR);
      if (result.bundles > 0) {
        logger.info(
          `app assets: prewarmed ${appId} (${result.bundles} bundle(s), ${result.variants} compressed variant(s))`
        );
      }
    } catch (error) {
      // Test vaults and mid-install apps often lack index.html; that is an
      // expected skip, not a prewarm regression. Keep real failures loud.
      if (isExpectedPrewarmSkip(error)) return;
      logger.warn(
        `app assets: prewarm failed for ${appId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  let outboxTimer: NodeJS.Timeout | undefined;
  const scheduleOutboxSweep = (delayMs: number): void => {
    if (outboxTimer) clearTimeout(outboxTimer);
    outboxTimer = setTimeout(() => {
      void runOutboxSweep();
    }, jitterDelayMs(delayMs));
    outboxTimer.unref();
  };
  const runOutboxSweep = async (): Promise<void> => {
    // Resource actuals (#528 Phase C): the outbox scheduler fired.
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

  // The one fire path, shared by "run now" (manual) and the cron schedulers
  // (scheduled). Runs on THIS host with the gateway's own harness pref,
  // against the CURRENT vault's live `main` code + its data tree, streaming
  // each run over the event bus. Scheduled fires enter their vault's scope
  // via `runWithVaultContext` (see schedulerFor); manual fires inherit the
  // request's scope.
  const fireAutomation: FireAutomation = async (automationRef, opts) => {
    // Mint the runId here so every fire (cron included) has a bus channel.
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
      // Skips are silent (#647 D6 quiet-by-default). A paused or needs-auth
      // connection is owner-chosen state, already carried by its own Notifications
      // decision; minting a high-severity notice per cron tick would reset
      // read state and wake devices forever. A skip also never becomes the
      // stored "failure" a later success would announce a recovery from.
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
      // The manifest is the source of the display name; without it, humanize
      // the ref rather than putting `<app>/<automation>` in front of the owner.
      const name = noticeContext?.name ?? humanizeAutomationRef(automationRef);
      // D4: the headline says WHICH failure, not just that one happened.
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
    /**
     * The one skip that is NOT silent (decision S9). Every other skip rests on
     * state the owner already sees — a paused connection carries its own
     * decision row. A tier refusal rests on a setting the owner may not know
     * exists, so it gets a card that names the domain and points at the
     * control, written ONCE per (domain, tier): re-putting an unchanged
     * refusal would clear `read_at` on every enrichment tick and turn the
     * explanation into the nag #647 D6 was written to prevent.
     */
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
      // Cursor bootstrap runs while `hostFor()` is still awaiting scheduler
      // reconciliation. The host is already mounted in `settledHosts` at that
      // point; awaiting the outer host promise here would wait on ourselves
      // and deadlock restart catch-up.
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
        // The MEMOIZED per-journal store: a webhook/event/data-triggered
        // automation can fire every few seconds, and a fresh
        // `makeJournalDbProvider` per fire would leak an unclosed
        // `DatabaseSync` (plus its 64 MiB mapping and an fd) each time —
        // `ConversationStore.close()` cannot release a handle it does not own.
        const ledger = journalConversationStore(ws.journalDbFile);
        const prior = ledger.getTurn(opts.runId);
        // A terminal turn is the durable acknowledgement. If the gateway
        // died after it finished but before the source cursor committed,
        // replaying this source element is a no-op.
        if (prior?.endedAt !== undefined) return { turnId: runId };
        // An interrupted turn can be retried under the exact same run id.
        // Cascading removes its partial items; deterministic vault
        // invocation ids then replay already-applied effects.
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
        journalDbFile: ws.journalDbFile,
        runTurn: accountedRunTurn,
        codeAppsDir: host.codeAppsDir(),
        // Each fire's ctx.vault rides the automation's enrolled
        // consent.agent credential, resolved per app id (duaility §12).
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
        // The enrichment tier gate's owner-plane read (privacy enforcement).
        // `plane.db.vault` deliberately, NOT `agentBridgeFor` — the guard
        // must not be answerable by the grants of the automation it guards.
        // A throw here is a refusal, not a default: the fire spine catches it
        // and skips the run with the reason stated.
        resolveEnrichPolicy: (domain) =>
          readEnrichPolicyTier(vaultRegistry.current().db.vault, domain),
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
            immediate.unref();
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
        // a provider the user never chose is NOT consent for egress (#567 D13).
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
      // Grant-matched outbox items the fire just staged drain now, not
      // on the next clock tick (issue #306 phase 3).
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

  /** The current request's vault's mounted host (sync — post-mount paths only). */
  const currentSettledHost = (): VaultHost =>
    settledHostFor(vaultRegistry.current().boot.vaultId);

  /** The current request's vault's host bundle, mounting it on first touch. */
  const currentVaultHost = (): Promise<VaultHost> =>
    hostFor(vaultRegistry.current());

  /**
   * Mount one vault's host bundle: build it, load its app registry into the
   * runtime (identity enrollment included), then settle its scheduler. The
   * whole mount runs inside the vault's ambient scope; cached by vault id,
   * so a vault created by a stopped-daemon maintenance command mounts on first
   * request.
   */
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
        const appDir = await host.store.resolveActiveAppDir(appId);
        if (appDir) await prewarmApp(appId, appDir);
      });
      // Every first-party app ships INSTALLED (issue #708). The catalogue that
      // used to hand them out one at a time is retired, so a vault does not
      // ACQUIRE its first-party apps — it has them, the way a phone has its
      // camera. Mount is the right seam rather than vault creation: it is the
      // one path every vault takes on every boot, so an older vault and a vault
      // created while a release was mid-upgrade converge on the same catalog
      // without a migration. `installApp` is idempotent (a `consent.app` row
      // that already exists is returned, not rewritten), so the steady state is
      // eight no-ops.
      //
      // Consequence, stated here because it is the reason the Uninstall verb
      // left the app gear popover: a bundled app removed from a mounted vault
      // would come back on the next mount, and a verb that undoes itself is a
      // worse answer than no verb. Access is still reviewable and revocable —
      // per-grant, in the Privacy ledger — which is the surface that question
      // actually belongs on.
      await forEachSequentially(bundledAppIds, async (appId) => {
        const meta = await readBundledAppMeta(bundledAppDir(appId));
        plane.installApp(appId, meta.name);
      });
      // Bundled apps aren't in the git store, so the first loop misses them —
      // register each from the enrollment record so its data plane and generic
      // compatibility route recover after a gateway restart.
      await forEachSequentially(plane.installedAppIds(), async (appId) => {
        await requireRuntime().registry.ensureUploaded(appId);
        await grantDeclaredBundledScopes(plane, appId);
        await prewarmApp(appId, bundledAppDir(appId));
      });
      settledHosts.set(vaultId, host);
      await reconcileScheduler(vaultId);
      return host;
    }).catch((error) => {
      // A failed mount must not poison the cache — drop it so the next
      // request retries (e.g. after a transient git failure).
      hosts.delete(vaultId);
      throw error;
    });
    hosts.set(vaultId, built);
    return built;
  };

  /** Re-sync one vault's registry off its live `main` (see BuiltGateway.syncApps). */
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
      await forEachSequentially(plane.installedAppIds(), async (appId) => {
        await requireRuntime().registry.ensureUploaded(appId);
        await grantDeclaredBundledScopes(plane, appId);
      });
    });
    await reconcileScheduler(id);
  };

  /**
   * Install a BUNDLED app into an EXPLICIT vault (issue #599 Phase 4) — the
   * auto-mount seam behind `/centraid/_vault/scopes`: an app an owner already
   * uses follows them into an audience vault they were added to.
   *
   * Same machinery as the `installBundledApp` lifecycle seam, with one
   * critical difference: that seam closes over the AMBIENT request vault,
   * while this one is handed a vault id. Everything vault-sensitive therefore
   * runs inside `runWithVaultContext(vaultId, …)` — `registry.ensureUploaded`
   * resolves `appsDir()` off the ambient scope, so calling it unscoped would
   * install into whatever vault the caller happened to be on. Idempotent, and
   * fail-soft: a refusal or failure resolves `false` rather than throwing, so
   * the listing degrades to `installed: false` instead of a 500.
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
      // Mount the target vault's host first: the registry's providers read the
      // ambient workspace, and the mount is cached per vault.
      await hostFor(plane);
      return await runWithVaultContext({ vaultId }, async () => {
        const meta = await readBundledAppMeta(bundledAppDir(appId));
        plane.installApp(appId, meta.name);
        await requireRuntime().registry.ensureUploaded(appId);
        await grantDeclaredBundledScopes(plane, appId);
        await prewarmApp(appId, bundledAppDir(appId));
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

  // Drop an app from the registry AND delete its wrapper dir under the
  // request's vault (`<apps>/<id>/` — logs, settings, blobs), then run the
  // vault-side uninstall cascade (§11: revoke + retire enrollment — the
  // ext band is RETAINED there; the owner purges it separately, #286).
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
    // The ext band (issue #286 phase 2): publish applies an app's declared
    // extension tables to THIS vault; drafts branch a scratch band there.
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
    // Draft preview (#141, reshaped by #286): resolve an app's code dir to
    // its OPEN session worktree and keep the vault's draft band in step
    // with the draft manifest there.
    const draftCodeDir = makeDraftCodeDirResolver(store, ext);

    // Unified chat (issue #141, Phase 3): every chat turn runs in the app's
    // draft worktree with the union of native file tools + the vault
    // register (`vault_sql`/`vault_invoke`, #286 phase 2) — one surface
    // that both tweaks the app's code and looks at the real data it
    // projects.
    const runner: ConversationRunner = makeUnifiedConversationRunner({
      store,
      prefsLoader,
      subsystem: "builder",
      getDispatcher,
      publicBaseUrl: () => serverUrl,
      ext,
      ...makeVaultToolRunners(vaultRegistry),
      ...(options.sessionIdFor ? { sessionIdFor: options.sessionIdFor } : {}),
      // Test inject: finish headless compile without spawning a harness.
      // Either way the driver is wrapped for resource accounting (#528 Phase C).
      runTurn: accountedRunTurn,
      harnessLadder,
      harnessHealth,
      harnessHealthContext,
      providerEgressConsent,
      onFailover: onConversationRunnerFailover,
    });
    // Headless compilation has its own outer automations ladder. Keep the
    // injected conversation driver automations-scoped and single-rung so breaker selection
    // can never jump providers inside one compile ledger turn.
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
    // Interactive automation turns run in a scratch cwd (the route passes it
    // as `dataDir`) and through an agent-plane dispatcher. This preserves the
    // automation's enrolled `consent.agent` grant boundary while keeping native
    // file tools away from the live automation source tree.
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
    // The headless compile, as an AWAITABLE task. Two callers need it: the
    // fire-and-forget `compileAutomation` route seam, and `reviseAutomation`,
    // which cannot know whether the compiled handler still matches the
    // published prompt unless it sees the outcome (issue #541 review).
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
      // Resolve core_link_anchor tokens before the model runs. The token
      // contains only an opaque anchor id; row and field scopes come from
      // the addressed vault's live link + selector.
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
      // Compiles are one-shot drafts. Reusing the interactive chat/edit
      // worktree lets a failed publish leave a rebase in progress, which
      // then poisons a later retry (and can conflict with UI edits).
      // The compile run id is already unique; its final UUID segment is
      // safe for WorktreeStore session ids.
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

          // Each provider attempt owns a fresh worktree and ledger turn. A
          // provider failure advances only after this turn has settled; compile
          // output is never replayed into another stateful session.
          await runHeadlessAutomationCompile({
            runner: automationCompileRunner,
            journalDbFile: workspace.journalDbFile,
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
            // Rung 0 is the user's automations primary unless the manifest
            // pinned a different provider, in which case the pin only counts if
            // that harness is a live ladder member. Later rungs ARE the ladder.
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
              // Discard a failed compile's isolated branch. This also clears an
              // interrupted rebase before the next provider starts.
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
      preparePublishedApp: prewarmApp,
      deregister: deregisterAndCleanup,
      reconcile: () => {
        // The lifecycle interface is intentionally fire-and-forget here; the
        // reconciler already reports the failure to health/logging. Awaited
        // publish/start paths call reconcileScheduler directly and receive the
        // rejection so a failed data-cursor bootstrap cannot look ready.
        void reconcileScheduler(vaultId).catch(() => undefined);
      },
      // Bundled ids are reserved (issue #434): a scaffold/clone must never
      // mint one, or a code-store app would shadow the shipped blueprint.
      isBundledAppId,
      isSystemManagedAutomation: isSystemRecognitionRef,
      isSystemManagedApp: (appId) => recognitionTemplateIds.has(appId),
      // Install a bundled blueprint in place (issue #434): its UI is already
      // part of the main client, so enroll with origin 'installed', register
      // the data plane, and grant declared scopes — no git or id minting.
      // Idempotent — an already-installed app returns its existing
      // registration. Returns undefined for a non-bundled id (→ 404).
      installBundledApp: async (templateId) => {
        if (!bundledAppIds.has(templateId)) return undefined;
        const meta = await readBundledAppMeta(bundledAppDir(templateId));
        const alreadyInstalled = plane.installedAppIds().has(templateId);
        plane.installApp(templateId, meta.name);
        await requireRuntime().registry.ensureUploaded(templateId);
        await grantDeclaredBundledScopes(plane, templateId);
        await prewarmApp(templateId, bundledAppDir(templateId));
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
      // Per-vault rename for an installed bundled app (issue #434): the code
      // is read-only, so the name lands on the enrollment record, not app.json.
      // Returns false when the id isn't an installed bundled app, so the meta
      // route falls through to its code-store app.json rewrite.
      renameBundledApp: (appId, name) => {
        if (!plane.installedAppIds().has(appId)) return false;
        plane.setAppLabel(appId, name);
        return true;
      },
      ext,
      compileAutomation: (input) => {
        // Fire-and-forget for the route seam; `stop()` still drains it, and a
        // throw out of the body lands on `automation-runs` health instead of
        // becoming an unhandled rejection.
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
            journalDbFile: workspace.journalDbFile,
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
          // One publish of the standing instructions through the ordinary
          // lifecycle seam — used for the revision AND for the roll-back, so
          // both take the same validate + publish + reconcile path.
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
              journalDbFile: workspace.journalDbFile,
              harnessSessionDir: workspace.harnessSessionDir,
              runTurn: accountedRunTurn,
              harnessPrefs,
              // Steering is an attended owner action. The conversation row is
              // ensured before TurnPlane asks for this proof, so the durable
              // direct grant is both FK-safe and rechecked at the door.
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

    // Mount-time materialization happens before this host is published in
    // `settledHosts`, so it must not call the runtime-registration callbacks
    // that resolve code back through that map. The ordinary mount loop below
    // registers, enrolls, grants and prewarms every newly published recipe.
    const systemInstallLifecycleOpts: LifecycleRouteOptions = {
      store,
      codeAppsDir,
      ensureRegistered: async () => undefined,
      deregister: async () => undefined,
      reconcile: () => undefined,
      ext,
      // The generated recognition bundles contain vendored ML/PDF runtime
      // code. Their human-owned sources are linted in the blueprint suite;
      // this release-only lifecycle needs the matching validation profile.
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
      // Release-owned recipes are exact snapshots. Clearing the session's
      // app dir removes stale helper files from an older bundled version;
      // the owner-controlled manifest state was merged above.
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
          // A publish/rollback may have added/removed/toggled an
          // automation — resync THIS vault's cron scheduler off the new `main`.
          await reconcileScheduler(vaultId);
        },
        onAppDeleted: async (appId) => {
          await deregisterAndCleanup(appId);
          await reconcileScheduler(vaultId);
        },
        // The listing union half (issue #434): installed bundled apps, with
        // their metadata read from the shipped blueprint dir + the per-vault
        // rename. Merged with the git code-store apps in GET /_apps.
        bundledApps: async () =>
          Promise.all(
            plane.installedApps().map(async ({ name, label }) => {
              const meta = await readBundledAppMeta(bundledAppDir(name));
              return {
                id: name,
                name: label ?? meta.name ?? name,
                ...(meta.description === undefined
                  ? {}
                  : { description: meta.description }),
                kind: "app" as const,
                hasIndex: meta.hasIndex,
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
      // App lifecycle over HTTP (issue #141, Phase 2): the gateway owns
      // scaffold / clone / update-meta / automation create+toggle+delete.
      makeLifecycleRouteHandler(lifecycleOpts),
      // Automation runtime ops over HTTP (issue #141): list/read/turn-now,
      // the run feed + per-run detail, and insights — all over THIS
      // vault's conversation ledger (the journal.db ledger band).
      makeAutomationsRouteHandler({
        store,
        journalDbFile: workspace.journalDbFile,
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
            journalDbFile: workspace.journalDbFile,
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
  // One persistent in-process cron scheduler PER VAULT for the gateway's
  // lifetime; `reconcileScheduler(vaultId)` (mount + every publish/delete)
  // settles that vault's in-memory registry off ITS `main`. Coalesced per
  // vault so concurrent publishes don't thrash it. Scheduled fires enter
  // their vault's ambient scope, so `ctx.vault`, transcripts, and code all
  // ride the vault the automation lives in.
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
      makeJournalDbProvider(plane.workspace.journalDbFile)
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
   * The ingress STORAGE key for a polled event source. It extends the
   * engine's own `eventSourceKey` (`event:<connectorKind>:<event>`) with the
   * bound connection id and a filter digest, because two automations on the
   * same connector kind must not share one `trigger_ingress` lane — a
   * multi-account connector would otherwise deliver account A's events to
   * account B's automation. Deriving it from the engine helper keeps the
   * shared prefix from drifting.
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
      // Same invariant `readIngressCursor` holds (trigger-ingress-cursor.ts):
      // the ingress half of this position only ever advances to the last row
      // actually handed back. Rows past the cap are still in
      // `trigger_ingress` and ride the next tick — surplus, not a gap.
      // `polled.skipped` stays: a provider page limit or an expired Gmail
      // history IS unrecoverable, because the source no longer holds them.
      const deliveredId = records.at(-1)?.id ?? position.ingressId;
      // A provider gap and a retention gap are both unrecoverable, so they sum;
      // the provider reason leads because it names the upstream cause.
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
      purpose: row.manifest.vault.purpose,
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
      // Preserve the established webhook handler contract: ctx.input is the
      // authenticated request body, while gap metadata remains visible on
      // the native turn itself.
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
      // An injected scheduler belongs to the DEFAULT vault, whichever order
      // it mounts in — the id check alone already makes that at most one
      // vault (a `schedulers.size === 0` co-condition would silently drop the
      // injection now that the default is not the first vault activated).
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
            // This legacy ledger now carries liveness only. Missed/source
            // position and gap truth live solely in automation_trigger_cursor.
            onTick: (at) => schedulerLedgerFor(vaultId).recordTick(at),
            onDormancyChange: (dormant, at) =>
              runWithVaultContext({ vaultId }, () => {
                schedulerLedgerFor(vaultId).setDormant(dormant, at);
              }),
            // Issue #570: gateway default cron zone (tier 2). Re-read prefs each
            // register/reconcile so Settings changes apply without a restart.
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

  // The Notifications doorbell is coalesced per vault (#647 review). Recomputing the
  // projection costs a listOutbox scan plus three queries, and each SSE ring
  // makes every subscribed client refetch the whole Notifications — a bulk connector
  // sync commits far too often to pay that per commit. A burst therefore
  // collapses to one recomputation per window instead of one per commit;
  // the leading edge still fires immediately so a lone write feels instant.
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
    timer.unref();
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

  provenanceDoorbell = (vaultId, entityTypes) => {
    ringNotificationsDoorbell(vaultId);
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
        // Every automation app acts through an enrolled consent.agent (duaility
        // §12) — enroll identities in THIS vault as the desired set settles,
        // and grant each automation's DECLARED scopes at the same moment
        // (issue #306 decision 2: installing was the consent).
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
        // Disabled bundled recognition recipes remain durable app rows so
        // Automations can show their owner-controlled toggles, but they must
        // not occupy scheduler registrations or bootstrap data cursors until
        // enabled. Ordinary disabled automations stay in `rows` so their
        // cursor retention semantics remain unchanged.
        const schedulerRows = rows.filter((row) =>
          recognitionTemplateIds.has(row.ownerApp)
            ? row.enabled
            : // User automations are the experimental surface (v0): with the
              // gate off they never arm, while system recognition recipes
              // above keep the photos pipeline (OCR, faces, embeddings)
              // flowing through the same scheduler.
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
  // The desktop/daemon gateway IS the always-on host, so it answers webhook
  // POSTs directly. `makeWebhookRouteHandler`
  // is single-apps-dir (it resolves against ONE `appsDir` closed over at
  // construction), so one instance is built per vault, cached by id; a
  // cheap pre-scan across every MOUNTED vault's `list()` (webhook ids are
  // minted from 24 random bytes — cross-vault collision is not a realistic
  // concern) resolves which vault owns the slug and delegates the WHOLE
  // request to that vault's instance, so nothing `makeWebhookRouteHandler`
  // already does (auth, rate limit, body cap, response shape) is
  // reimplemented here. Accepted requests enter the durable ingress table;
  // the same cursor engine that handles cron/data/condition drains them.
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
    // Automations experiment off: no webhook ingress. Fall through so the
    // host's chain answers not-found instead of durably accepting a trigger
    // that nothing will ever fire.
    if (!experimental.automations) return false;
    const url = new URL(req.url, "http://x");
    const slug = url.pathname
      .slice(automation.WEBHOOK_ROUTE_PREFIX.length)
      .replace(/^\/+/u, "")
      .replace(/\/+$/u, "");
    // Mirror `makeWebhookRouteHandler`'s own POST + slug-shape gate so a
    // malformed request short-circuits to the default vault's 404/405
    // without paying for a scan across every vault.
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

  // Turn backpressure (issue #420, Wave 6): a modest per-vault ceiling on
  // concurrently-running turns, shared by BOTH the per-app `_turn` route
  // (via Runtime) and the vault-assistant route. One limiter per vault id so
  // busy tabs on vault A never starve vault B; the auto-titler yields to it.
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
  // One Runtime for the gateway's lifetime; its apps dir, registry, chat
  // runner, and session scratch all resolve through the request's vault
  // (the Runtime keeps one registry per resolved apps dir, so N vaults get
  // N registries).
  const runtime = new Runtime({
    appsDir: () => currentWorkspace().appsDir,
    // Shared kit assets (kit.ts / kit.css) are served from the blueprints
    // package's canonical `kit/` dir; apps no longer ship per-app copies.
    sharedAssetsDir: KIT_DIR,
    timeModuleUrl: TIME_ENGINE_MODULE_URL,
    userStore: prefs,
    conversationHistoryStore,
    conversationRunner: {
      // Facade over the request vault's unified runner (#280) — builder-
      // capable, so turns persist as `kind='build'` (issue #181). EVERY
      // ask turn rides the vault register (issue #286 phase 2: the vault
      // is the only store) — the owner assistant wearing the app lens.
      runKind: "build",
      run: async (input) => {
        // Model prefs plumbing: an explicit `input.model` (the `_turn` POST
        // body) always wins; otherwise resolve off the register — `ask` is
        // the per-app copilot, anything else (including unset) is the
        // builder chat.
        //
        // The two runners below are built once at boot, but neither PICKS a
        // harness kind at construction: each carries only its subsystem tag
        // and calls `prefsLoader(subsystem)` inside every turn. So the same
        // `input.register` fork that names the subsystem here also lands on
        // a harness that resolves `harness.<subsystem>` fresh — the model key
        // and the backend that receives it can't disagree, and a re-pin
        // takes effect on the next turn with no restart.
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
      // The model list is a pure catalog read; enumeration is owned by the
      // warmer. A Refresh (or a cold cache) kicks a warm fire-and-forget and
      // the client polls `modelsStatus` until it leaves `loading`.
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
    // Compatibility resolver (issue #434): bundled system UI is compiled into
    // the main client, but the generic opaque-app route can still resolve an
    // installed blueprint's shipped directory (no per-vault copy). Everything
    // else — compiled automations or future opaque app sources — resolves to
    // the git code-store worktree. The installed check is per-vault so a
    // legacy snapshot-cloned app keeps resolving from the store. The app-engine
    // static-path sandbox applies identically to whichever dir is returned.
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
    // Despite the plural name this is not a listing: `turn-routes` calls it
    // per turn and then RUNS in the root it picks, defaulting builder turns to
    // `draft`. Opening the editing session here is therefore load-bearing —
    // deferring it would make the first builder turn silently run in the
    // published `app` dir instead of the user's worktree.
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

  // The vault assistant (shell-level Q&A over the whole vault): one
  // runner for the gateway's lifetime — every turn resolves the request's
  // vault (prompt, vault_sql credential, scratch cwd) at call time.
  const assistantRunner = makeAssistantConversationRunner({
    prefsLoader,
    subsystem: "assistant",
    getDispatcher,
    vaults: vaultRegistry,
    // Measure + label every assistant harness run (#528 Phase C); never throttled.
    runTurn: accountedRunTurn,
    harnessLadder,
    harnessHealth,
    harnessHealthContext,
    providerEgressConsent,
    onFailover: onConversationRunnerFailover,
  });

  // LLM auto-title (issue #420, Wave 3): after the first turn of a new
  // assistant thread settles, a cheap one-shot inference names it — the
  // claude.ai affordance that beats first-message truncation. Fire-and-forget:
  // this closure returns void immediately and self-schedules; any failure is
  // swallowed so a title miss never touches the turn. Provider-agnostic — the
  // titler runs at the `fast` capability TIER (never a hardcoded model id;
  // governance no-hardcoded-model-ids), overridable per harness via the
  // `model.<harnessKind>.title` prefs slot. "User rename wins": the generated
  // title is only applied when the stored title is STILL the exact derived
  // truncation, re-checked after the (async) generation returns.
  const generateAssistantTitle = (args: {
    conversationId: string;
    userMessage: string;
    assistantText: string;
  }): void => {
    void (async () => {
      try {
        // Yield to interactive turns (issue #420, Wave 6): the titler is a
        // nice-to-have one-shot, so it skips generation whenever the vault is at
        // its turn ceiling rather than competing for a slot.
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
        // The `fast` tier is only meaningful on harnesses that understand the
        // tier vocabulary (claude-code); on codex a bare tier token would be
        // sent verbatim, so skip unless the owner configured an explicit slot.
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
        // Apply only if the thread still carries the derived truncation — a
        // manual rename between record and generation wins.
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
    // Universal capture has no user-visible conversation, but provider
    // consent is conversation-scoped and FK-backed. Keep one hidden build
    // conversation per vault so the authenticated, attended classify action
    // can leave a durable direct receipt before any text egresses.
    const captureConversationId = "centraid:capture-classifier";
    const captureLedger = journalConversationStore(
      currentWorkspace().journalDbFile
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

  // Ask-register lens metadata (issue #286 phase 2): the app copilot's
  // `register: 'ask'` turns ARE the owner assistant wearing the app lens —
  // name + description bias the prompt, never a permission boundary.
  // Resolved per turn off the live `main` manifest so a publish lands
  // without a restart.
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

  // The per-app ask register: the same assistant runner wearing the app
  // lens — prompt-level bias, never a permission boundary (it is still
  // the owner asking their own vault).
  const askRunner = makeAssistantConversationRunner({
    prefsLoader,
    subsystem: "ask",
    getDispatcher,
    vaults: vaultRegistry,
    // Measure + label every ask-register harness run (#528 Phase C); never throttled.
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

  // Diagnostics bundle assembly (issue #351): a closure so the route
  // handler (`diagnostics-routes.ts`) stays thin wiring. `config` is
  // whatever's useful for support — paths, the backup config, whether
  // device access is enforced — and is redacted (secret-shaped keys,
  // e.g. the remote backup provider's `apiKey`) inside
  // `buildDiagnosticsBundle` before it ever reaches the response.
  const buildDiagnostics = () =>
    buildDiagnosticsBundle({
      health,
      logs: logStore,
      vaults: vaultRegistry,
      config: {
        paths,
        backup: options.backup,
        deviceAccessEnabled: Boolean(options.deviceAccess),
        // Steward-absence + local Commons sync instrumentation (#731):
        // reachability, absence episodes, pull outcomes, op-log size, and
        // member lag per grant — read-only, no network egress. See
        // docs/logs.md.
        ...commonsObservabilitySection({
          vaults: vaultRegistry
            .planesList()
            .map((plane) => ({ vaultId: plane.boot.vaultId, db: plane.db })),
        }),
      },
    });

  // ── Route chain ───────────────────────────────────────────────────────
  const routeEntries: RoutePrefixRegistration[] = [
    forRoutePrefixes(
      ["/centraid/_web", "/centraid/_apps"],
      webControlSessions.handler
    ),
    // Gateway identity + version handshake (issue #289): cheap static
    // JSON, mounted first — health polling hits it every few seconds.
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
          // Experimental gates (v0): a gated-off feature is absent from the
          // handshake, so clients wall it in ONE place (C1) instead of
          // discovering dead routes.
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
          // Paired-device roster + revoke (issue #376): the wire twin of
          // `cli/device-admin.ts`'s list/revoke. Every request is scoped to
          // the caller's proved EndpointId and persisted enrollments.
          forRoutePrefixes(
            "/centraid/_gateway/devices",
            makeDevicesRouteHandler({
              enrollments: options.devicePairing.enrollments,
              tickets: options.devicePairing.tickets,
              endpointTicket: options.devicePairing.endpointTicket,
              ...(options.isHostCustody
                ? { canMintPairingTicket: options.isHostCustody }
                : {}),
              // The mint target when the caller names no vault: the owner's
              // PERSONAL vault, never Shared. The `OrUndefined` variant is
              // used deliberately — this seam must not throw when every vault
              // has been deleted.
              defaultVaultId: () => vaultRegistry.defaultVaultIdOrUndefined(),
              vaultIds: () =>
                vaultRegistry.list().map((vault) => vault.vaultId),
              onEndpointRevoked: options.devicePairing.onEndpointRevoked,
              vaultName: (id) => vaultRegistry.get(id)?.name,
              // *Add someone* (#726 P1): mints the new vault (identity
              // keypair included — `VaultRegistry.create` mints it).
              mintVaultForPerson: (name) => vaultRegistry.create(name),
              // Cleanup twin (#750): a failed provision removes the vault it
              // minted (dir + keys + mount), leaving zero durable state.
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
          // The people on this gateway (#726): owners are the principals
          // vaults belong to; the devices route above only binds hardware.
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
          // The same-machine link ceremony a cross-owner edge needs (#726
          // P2 §3): propose a link from a vault you own, the other owner's
          // device approves. Same-owner edges never touch this surface.
          // `peer` (audit #726 finding 1) is the SAME `peerPlane.dial` every
          // other outbound peer capability in this file already gates on —
          // absent, `ticket`/`redeem` answer a typed refusal instead of
          // reaching for a transport that isn't wired.
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
    // Component-level health + structured error tail. `_gateway/info`
    // is the liveness probe; this is the "what's actually wrong" surface.
    forRoutePrefixes(
      "/centraid/_gateway/health",
      makeHealthRouteHandler(health)
    ),
    // Owner "pause background work" control (#528 Phase B): hot-applied,
    // in-memory only, never a durable Resource-mode flip. Same bearer gate
    // and owner-facing family as health.
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
    // A single JSON document a user can save + hand to support: version,
    // health snapshot, log tail, vault sizes, and a redacted config
    // summary. Mounted right after health — same bearer gate, same
    // "owner-facing diagnostics" family.
    forRoutePrefixes(
      "/centraid/_gateway/diagnostics",
      makeDiagnosticsRouteHandler(buildDiagnostics)
    ),
    // Backup status + manual "run now" (issue #351): thin wiring over
    // `BackupService`. `backupService` is `undefined` when
    // `options.backup?.enabled` is false — the handler answers
    // `{configured: false}` rather than 404 in that case. Same bearer
    // gate, same owner-facing-diagnostics family as health/diagnostics.
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
    // Gateway-level storage connections (issue #367 §C1): CRUD + real
    // connectivity probe + per-vault replication status. Same bearer gate,
    // same owner-facing-diagnostics family as backup/health.
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
    // Due task/event reminders, computed live — the desktop main process
    // polls this to fire OS notifications (issue: Tasks/Agenda comparison
    // flagged "no time-based alerts, anywhere").
    forRoutePrefixes(
      ["/centraid/_reminders", "/centraid/_brief"],
      makeRemindersRouteHandler(vaultRegistry, options.devicePairing)
    ),
    // Realtime gateway logs (JSON tail + SSE) — the diagnostics surface
    // the desktop's Settings → Logs screen streams from.
    forRoutePrefixes("/centraid/_logs", makeLogsRouteHandler(logStore)),
    // The assistant's `_turn`/`resolve` surface — mounted BEFORE the
    // generic `_vault` handler, which answers 404 for any sub-route it
    // doesn't know (same prefix family).
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
    // Scenario seeds (issue #290 phase 1): load/reset an app's demo data.
    // Mounted BEFORE the generic `_vault` handler (same prefix family).
    forRoutePrefixes(
      "/centraid/_vault/demo",
      makeDemoRouteHandler(vaultRegistry, {
        codeAppsDir: () => currentSettledHost().codeAppsDir(),
        // Same precedence as `codeDirOverride` above: a bundled app INSTALLED
        // in this vault serves from the shipped blueprint tree, so that is
        // where its scenario generator lives too.
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
    // File-drop imports (issue #290 phase 2): stage → review → publish.
    forRoutePrefixes(
      "/centraid/_vault/imports",
      makeImportRouteHandler(vaultRegistry)
    ),
    // Semantic photo search (issue #721 E3). Mounted BEFORE the generic
    // `_vault` handler — and deeper than the owner's enrichment-settings
    // surface at `/centraid/_vault/enrich`, which the generic handler still
    // owns.
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
    // Blob custody (issue #296): staged uploads in, consent-checked +
    // Range-capable bytes out. Mounted BEFORE the generic `_vault`
    // handler (same prefix family).
    forRoutePrefixes(
      "/centraid/_vault/blobs",
      makeBlobRouteHandler(vaultRegistry, options.dataPlaneHttp)
    ),
    // Broker-carried connection credentials (issue #304): health list,
    // configure, pause/resume, and the PKCE consent ceremony. Mounted
    // BEFORE the generic `_vault` handler (same prefix family).
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
    // Consent-derived offline replica protocol (#406). Mounted before the
    // generic owner `_vault` handler because both share that prefix. The
    // intent lane executes through the ordinary app dispatcher; the route
    // only adds durable device-scoped admission/dedupe around it.
    forRoutePrefixes(
      ["/centraid/_vault/replica", "/centraid/_vault/changes"],
      makeReplicaRouteHandler(vaultRegistry, {
        // The embedded desktop host is enrolled in the canonical store above
        // even though it has no remote-pairing plane. Replica access must
        // consult that same store or the host proves an EndpointId that the
        // route can never resolve, producing replica_device_not_enrolled.
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
    // Owner consent surface for the vault plane (grants, parked
    // confirmations, rename/presentation). Its `_vault` prefix
    // is disjoint from every other route family. Vault create/delete are
    // ADMIN acts (server CLI) — they no longer ride HTTP (#289).
    forRoutePrefixes(
      "/centraid/_vault",
      makeVaultRouteHandler(vaultRegistry, {
        ...(effectiveDeviceAccess
          ? { deviceAccess: effectiveDeviceAccess }
          : {}),
        onOutboxDecided: drainOutbox,
        // Storage-connection attach flow (issue #367 §C1/§C4/§C10): resolves
        // `blob_store.connectionId` and gates on the recovery-kit nudge.
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
        // fix (this session): agent-grant approval can be the FIRST enrollment
        // touch for an automation's agent — resolve its real manifest name
        // the same way reconcileScheduler does, so `approveAgentGrant` never
        // has to fall back to a bare id-derived name.
        resolveAutomationName: async (appId) => {
          const { rows } = await automation.list(
            currentSettledHost().codeAppsDir()
          );
          return rows.find((r) => r.ownerApp === appId)?.name;
        },
      })
    ),
    // Template catalog (issue #141): the gateway owns it, so the renderer
    // reads `GET /centraid/_templates` directly. Templates are SEEDS —
    // gateway-level, read-only material instantiated INTO a vault (#280).
    forRoutePrefixes(
      "/centraid/_templates",
      makeTemplatesRouteHandler({
        ...(paths.templatesCacheDir
          ? { cacheDir: paths.templatesCacheDir }
          : {}),
        // Catalog installed-state (issue #434): whether each bundled app is
        // already installed in the request's vault, so the Discover card shows
        // "Open" instead of "Install". Degrades to "nothing installed" if no
        // vault is addressed — the catalog is readable before any vault exists.
        installedAppIds: () => {
          try {
            return vaultRegistry.current().installedAppIds();
          } catch {
            return new Set<string>();
          }
        },
      })
    ),
    // Harness detection (codex/claude credentials on the gateway host).
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
            // Only force a spawn on explicit refresh; otherwise serve cache.
            // `probeIfMissing` delivers the "probe once on first read when
            // cold" half of that promise — without it a cold gateway (fresh
            // start, nothing persisted yet) answered `undefined` and an
            // installed, authed harness showed no models until the user
            // manually hit Refresh (#665). The in-flight de-dupe inside
            // resolveAcpCapabilities keeps concurrent cold reads to one probe.
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
    // The request vault's store-backed handlers (apps-store / lifecycle /
    // automations), resolved per request off the ambient vault scope. With
    // the automations experiment off, only the apps prefix dispatches — the
    // `_automations`/`_insights` families fall through to not-found while
    // the mixed lifecycle handler stays mounted for apps.
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

  // `composedHandler` owns the whole request: resolve the vault the request
  // is addressed to (#289), then replay the chain `startRuntimeHttpServer`
  // used to run — chat-history → prefs → extra handlers → `runtime.handle`
  // — inside that vault's ambient scope. WITHOUT the bearer check, for
  // hosts that own auth themselves. CORS is the host's job too: a fronting
  // gateway emits its own.
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
  // Retain the public BuiltGateway seam as a one-entry compiled dispatcher;
  // callers never receive or linearly walk the underlying route registry.
  const extraHandlers: RouteHandler[] = [prefixDispatch];
  const dispatchChain: RouteHandler = async (req, res) => {
    if (await prefixDispatch(req, res)) return true;
    await runtime.handle(req, res);
    return true;
  };

  // Deliberately NOT in `routeEntries`: the scopes listing spans every vault
  // the caller owns, so it is dispatched outside the per-vault scope (see
  // its call site).
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
    ...(options.peerPlane?.dial ? { peerDial: options.peerPlane.dial } : {}),
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
  // Owner-tier steward-absence recovery (#731): same enrollment-derived
  // owner check and vault resolution as `commonsHandler` above — this is a
  // sibling door onto the same Commons plane, not a new auth story.
  const commonsRecoveryHandler = makeCommonsRecoveryRouteHandler({
    enrollments: enrollmentStore,
    vaultFor: (vaultId) => vaultRegistry.get(vaultId)?.db,
    // Successor invitations ride the same peer push the ordinary commons
    // door uses (issue #750), so the ceremony ends with members invited
    // rather than with a steward of one.
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
  // The D9 answer route (#726 P3 decision 9) — a same-machine owner-tier
  // surface, mounted like any other route, distinct from the peer plane.
  const edgeAnswerHandler = makeEdgeAnswerRouteHandler({
    gatewayDatabase,
    enrollments: enrollmentStore,
    links: vaultLinksStore,
    vaultFor: (vaultId) => vaultRegistry.get(vaultId)?.db,
    ...(options.peerPlane?.dial ? { peerDial: options.peerPlane.dial } : {}),
  });
  /*
   * The peer plane (#726 P3 decision 6). Mounted OUTSIDE the prefix registry
   * on purpose: every route in there resolves a proved DEVICE first, and a
   * peer is not a device. It reads the same `vault_links` rows an edge is
   * judged against — one table, one answerer (D3).
   */
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
        // The remote-give frames (#726 P3 decision 7) — same vault resolver
        // and gateway.db the same-machine edge plane already uses.
        vaultFor: (vaultId) => vaultRegistry.get(vaultId)?.db,
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
        gatewayDatabase,
      })
    : undefined;
  /*
   * Peer-plane background delivery (#726 P3 gaps 2 & 3): drains
   * the ONE share outbox (`share_effects`: a give's ORIGINAL bytes, a D9
   * 'refuse' the origin has not heard yet, a give the peer was offline for)
   * on the gateway's own clock
   * rather than never — same posture as the outbox sweep below (bounded rows
   * per tick, backs off on failure, never throws out of the timer). `dial`
   * is read LIVE so a build that wires it after this point (or never) still
   * behaves correctly — the sweep simply idles until one exists.
   */
  const peerPlaneSweep = createPeerPlaneSweep({
    db: gatewayDatabase,
    links: vaultLinksStore,
    vaultFor: (vaultId) => vaultRegistry.get(vaultId)?.db,
    commonsVaults: () =>
      vaultRegistry.planesList().map((plane) => ({
        vaultId: plane.boot.vaultId,
        db: plane.db,
        gateway: plane.gateway,
        credential: plane.ownerCredential,
      })),
    dial: () => options.peerPlane?.dial,
    /*
     * Route re-assertion retry (issue #750 invariant 3). The eager push runs
     * where the EndpointId is first learned (the daemon's endpoint host);
     * this tick is the RETRY path — `announceLocalRoutes` is a no-op until
     * the endpoint changes, and stays armed while any linked peer has not
     * heard the change (the `gateway_meta` pin is only written on full
     * delivery). Signed per LOCAL vault with its own identity seed.
     */
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

  const composedHandler: RouteHandler = async (req, res) => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    // Duration histogram per route (issue #659 R5). Recorded on response
    // 'close' rather than on return, so a streamed body (SSE, blob range) is
    // measured to the byte and not just to the handler's first await.
    const startedAt = performance.now();
    res.once("close", () =>
      routeLatency.record(url.pathname, performance.now() - startedAt)
    );
    /*
     * The peer lane, before anything else can look at this request (#726 P3).
     *
     * TWO steps, and they are not the same guard. The handler matches on the
     * RAW `req.url`, so `/centraid/_peer/../_gateway/devices` still reaches
     * it — `url.pathname` above already resolved that `..` away — and its own
     * confinement check refuses it. The second step is what closes the
     * owner-tier hole: a peer-marked request that is not a peer-plane request
     * at all cannot fall through to a bearer-authenticated route, where the
     * forwarder's own upstream bearer would otherwise satisfy the gate. A
     * peer must never satisfy an owner-tier check by ANY route, so the answer
     * is the plane's own `not_found` rather than a 403 that would confirm the
     * route exists.
     *
     * Path confinement itself lives in the FORWARDERS (`peer_target_allowed`
     * in the Rust relay, `isPeerPlaneTarget` in the TS endpoint). Registering
     * this route confines nothing on its own; it is the backstop for a future
     * forwarder that forgets.
     */
    if (peerPlaneHandler && (await peerPlaneHandler(req, res))) return true;
    if (req.headers[PEER_ENDPOINT_HEADER] !== undefined)
      return sendJson(res, 404, { state: "not_found" });
    // The Rust-owned iroh relay calls this metadata-only control surface
    // before it can inject the remote EndpointId into an upstream request.
    // Requiring that not-yet-injected identity here is circular. The route's
    // per-boot control secret (plus the outer loopback bearer in production)
    // authenticates it, so dispatch it at gateway scope in every vault state.
    if (
      (url.pathname === "/centraid/_gateway/info" ||
        url.pathname.startsWith("/centraid/_gateway/tunnel/")) &&
      (await prefixDispatch(req, res))
    ) {
      return true;
    }
    // The CLI lane into ticket minting is always open, by design: the landlord
    // has shell access on this box, and `centraid-gateway pair` carries no
    // device identity — which is precisely what the route's own host-custody
    // check (`canMintPairingTicket` → `isDirectHostRequest`) exists to
    // authorize. Demanding a proved device HERE made that hatch unreachable,
    // so a headless daemon could never enroll its FIRST device from the CLI.
    //
    // Skipping ahead grants nothing. The bearer was already enforced upstream
    // by `startRuntimeHttpServer` (this path is not in `publicPaths`), and the
    // route still applies host-custody-or-vault-owner itself. `isDirectHostRequest`
    // keeps the skip narrow: an iroh-forwarded request arrives on loopback too
    // but carries device headers, so it falls through to the identity gate.
    if (
      url.pathname === "/centraid/_gateway/devices/ticket" &&
      isDirectHostRequest(req) &&
      (await prefixDispatch(req, res))
    ) {
      return true;
    }
    // A native merged grid cannot attach `x-centraid-vault` to an ordinary
    // image URL. Carry the explicit scope in a gateway-plane URL, then rewrite
    // it into the existing consent/range-capable blob lane before vault
    // resolution. Authorization below remains exactly the same.
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
    // Resolve the request's vault (issue #289): a proved device enrollment
    // scopes what it may address; the header picks within it. No identity is a
    // hard refusal. Loopback embeds use the persisted host enrollment created
    // above, not wildcard reach.
    //
    // Device-key resolution has one host-owned seam. The daemon endpoint host
    // accepts either its per-boot proved iroh headers or the explicitly
    // injected desktop EndpointId on a kernel-observed loopback socket.
    // Direct bearer/device-token identity was removed in #555.
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
    // The scopes listing answers "which vaults may I work in", which is by
    // definition not one vault, so it is dispatched HERE — after the device
    // identity is proved, and BEFORE the single-vault `runWithVaultContext`
    // scope below; the `x-centraid-vault` header is irrelevant to it.
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
    // The D9 answer surface (#726 P3 decision 9): `/centraid/_gateway/edges/pending`
    // and `/centraid/_gateway/edges/:edgeId/answer` — sub-paths `edgesHandler`
    // itself never matches (it checks exact equality against `EDGES_PATH`).
    if (
      url.pathname.startsWith(`${EDGES_PATH}/`) &&
      (await edgeAnswerHandler(req, res))
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
    // No `x-centraid-vault` header → the gateway's DEFAULT vault (the owner's
    // personal one), whenever this device is enrolled in it. Falling straight
    // to `enrolled[0]` would put a headerless request in whichever vault the
    // device's enrollment rows happen to rank first, disagreeing with
    // `defaultVaultId()` and with every other unscoped seam. A device NOT
    // enrolled in the default still
    // lands in the first vault it actually holds (a ticket minted against a
    // named vault ranks that vault first, so a targeted pair is unaffected).
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
        // L4 attribution (#599): resolve the ACTING OWNER once, here, from
        // the device binding, so everything downstream reads "who did this"
        // off the request scope instead of re-deriving it from hardware.
        // `ownsVault` is the one write predicate (#726): the enrollment view
        // only yields vaults the device's owner owns, so an un-revoked row
        // IS ownership.
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
    // Publish the live origin to the unified chat runner so post-turn
    // webhook minting can build absolute `_centraid-hook` URLs.
    serverUrl = publicBaseUrl;

    // A vault arriving after boot can introduce an earlier WAL RPO than the
    // currently armed timer and also needs its host/scheduler activated.
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
    // Web/control session expiry reclamation on the gateway clock instead of
    // on every HTTP request (issue #659 G3).
    webControlSessions.startSweeping();
    // Peer-plane background delivery (#726 P3 gaps 2 & 3) on the gateway clock.
    peerPlaneSweep.start();

    // Start the per-vault in-process cron schedulers as they mount. Under
    // n8n semantics they only fire while running — downtime is not
    // backfilled (issue #149). The schedulers run REGARDLESS of the
    // automations experiment: system recognition recipes (photo OCR, faces,
    // embeddings, transcripts) ride the same cursor engine, so photos keep
    // indexing with the experiment off. The gate lives in reconcile's row
    // set instead — user automations never arm while off.
    schedulersStarted = true;
    for (const [, sched] of schedulers) sched.start();

    // Mount EVERY vault's workspace (#289): host bundle, app registry sync
    // + enrollment, scheduler reconcile — so each vault's automations fire
    // and each client's first request finds its vault warm.
    await forEachSequentially(vaultRegistry.planesList(), (plane) =>
      hostFor(plane).then(() => undefined)
    );
    // Commons mechanics are compiled state, not backup truth. A normal mount,
    // restore, or restore-after-erase rebuilds every local member seat from
    // the steward grants after all vaults are available.
    recompileMountedCommons();

    // Vault standing duties on the gateway clock: a sweep now, then hourly.
    vaultRegistry.start();

    // Adaptive backstop: active/deferred work retries quickly, an empty queue
    // follows the hardware profile's idle cadence, and errors back off.
    scheduleOutboxSweep(hardwareProfile.outboxIdleIntervalMs);

    // Warm the host-capability catalog — the model list — for each detected
    // harness on EVERY gateway start, in the background so it never delays
    // readiness. Best-effort; the warmer dedupes, so a client Refresh mid-boot
    // joins this run.
    if (warmer) {
      const activeWarmer = warmer;
      void (async () => {
        // Every registered harness kind, not a hardcoded pair. The probe is a
        // single `<bin> --version` per kind (concurrent, and a kind with no
        // configured binary short-circuits without spawning), and only the
        // kinds that actually resolve go on to the far more expensive warm.
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

    // Offsite backup engine: hourly scheduler, started only when enabled.
    backupService.start();
  };

  const stop = async (): Promise<void> => {
    unsubscribeLateMount();
    pushWakeRelay.stop();
    webControlSessions.stopSweeping();
    peerPlaneSweep.stop();
    // A mount notification may already be building its code host. Let that
    // bounded work settle before closing vault databases or removing temp
    // roots; otherwise shutdown races git/SQLite initialization.
    await Promise.all(lateMountTasks);
    await Promise.all([...schedulers.values()].map((sched) => sched.stop()));
    if (outboxTimer) clearTimeout(outboxTimer);
    // A trailing Notifications doorbell must not outlive the registry it samples.
    for (const open of notificationsDoorbellWindows.values())
      clearTimeout(open.timer);
    notificationsDoorbellWindows.clear();
    // Await the in-flight backup run (if any): its post-registration steps
    // write shipper + backup state, and the vault registry teardown below
    // closes the very planes it would touch.
    await backupService.stop();
    // Drain detached automation lifecycle work (compiles, revisions) and any
    // in-flight interactive/steering turn before the vault databases close —
    // otherwise shutdown can land mid-`store.closeItem` or orphan an ACP
    // child (issue #541 review).
    // Snapshotted before awaiting: each task's `finally` removes itself from
    // the live set, and a queued lock tail can still append behind us.
    const detached = Array.from(detachedAutomationTasks);
    const lockTails = Array.from(automationConversationLocks.values());
    await Promise.all(detached);
    await Promise.all(lockTails);
    const journalFiles = vaultRegistry
      .planesList()
      .map((plane) => plane.workspace.journalDbFile);
    // Sweep clock down, WAL checkpoint, files closed. Idempotent.
    vaultRegistry.stop();
    // Release THIS gateway's memoized `journal.db` handles (another gateway in
    // the same process keeps its own).
    closeJournalConversationStores(journalFiles);
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

/**
 * Validate a manifest's declared vault block into an install-scope block
 * (issue #306). Manifests are app-authored input: anything malformed grants
 * nothing rather than something surprising.
 */
/**
 * Display metadata for a bundled blueprint app, read from its shipped
 * `app.json` + `index.html` presence (issue #434). Mirrors the shape
 * `WorktreeStore.listAppsWithMeta` produces for code-store apps so the two
 * origins merge into one listing. A malformed/absent app.json degrades to
 * id-only — the app still lists, just without pretty metadata.
 */
async function readBundledAppMeta(dir: string): Promise<{
  name?: string;
  description?: string;
  iconKey?: string;
  colorKey?: string;
  hasIndex: boolean;
}> {
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(dir, "app.json"), "utf8")
    ) as Record<string, unknown>;
  } catch {
    manifest = {};
  }
  let hasIndex = false;
  try {
    await fs.access(path.join(dir, "index.html"));
    hasIndex = true;
  } catch {
    hasIndex = false;
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
    hasIndex,
  };
}

function manifestScopeBlock(raw: unknown): InstallScopeBlock | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const block = raw as { purpose?: unknown; scopes?: unknown };
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
  return {
    ...(typeof block.purpose === "string" && block.purpose !== ""
      ? { purpose: block.purpose }
      : {}),
    scopes,
  };
}

/** Every automation execution is attenuated, including manifests declaring no vault access. */
function executionScopeBlock(raw: unknown): InstallScopeBlock {
  return manifestScopeBlock(raw) ?? { scopes: [] };
}
