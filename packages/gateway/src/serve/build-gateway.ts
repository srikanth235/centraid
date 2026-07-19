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

import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AnalyticsStore,
  ASSISTANT_APP_ID,
  AUTHED_DEVICE_HEADER,
  COMPANION_GRANTS_HEADER,
  ConversationHistoryStore,
  ConversationStore,
  InsightsStore,
  PrefsStore,
  Runtime,
  changesSubscriberCount,
  cleanupDeregisteredApp,
  deriveTitle,
  generateConversationTitle,
  makeConversationRouteHandler,
  makeJournalDbProvider,
  makeUserStoreRouteHandler,
  resolveSubsystemModel,
  resolveSubsystemRunner,
  TurnLimiter,
  prewarmAppAssets,
  type AskModelInfo,
  type ConversationRunner,
  type ModelSubsystem,
  type RuntimeLogger,
  type ToolResult,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
  type VaultWorkspace,
} from '@centraid/app-engine';
import { KIT_DIR, bundledAppDir, listBundledAppTemplates } from '@centraid/blueprints';
import * as automation from '@centraid/automation';
import {
  runAutomation,
  runPreflight,
  runTurn,
  CatalogWarmer,
  deriveStatus,
  readRunnerModels,
  readRunnerTools,
  enumerateRunnerModels,
  enumerateHostTools,
  probeCliAvailability,
  type CatalogSurface,
  type RunnerKind,
  type RunnerPrefs,
  type SurfaceStatus,
} from '@centraid/agent-runtime';
import {
  readBlobStoreSettings,
  custodyStateCounts,
  jitterDelayMs,
  type PreviewCodec,
} from '@centraid/vault';
import { createImagePreviewCodec } from '../preview/codec.js';
import { WorktreeStore } from '../worktree-store/index.js';
import { openVaultRegistry, type VaultRegistry } from './vault-registry.js';
import { createDiskHealthProbe } from './disk-health.js';
import { createBrokerHealthProbe } from './broker-health.js';
import { createSchedulerHealthProbe } from './scheduler-health.js';
import { createEnrichmentHealthProbe } from './enrichment-health.js';
import { createBlobSweepHealthProbe } from './blob-sweep-health.js';
import { createStorageQuotaHealthProbe } from './storage-quota-health.js';
import { createVaultIntegrityHealthProbe } from './vault-integrity-health.js';
import { GatewayInstanceLease } from './gateway-instance-lease.js';
import { ConnectionBroker } from './connection-broker.js';
import { OutboxExecutor } from './outbox-executor.js';
import type { InstallScopeBlock, VaultPlane } from './vault-plane.js';
import { runWithVaultContext, VAULT_HEADER, type DeviceAccess } from './vault-context.js';
import type { EnrollmentStore } from './enrollment-store.js';
import type { PairingTicketStore } from './pairing-store.js';
import type { DeviceTokenStore } from './device-token-store.js';
import { makeVaultRouteHandler } from '../routes/vault-routes.js';
import { makePairRouteHandler } from '../routes/pair-routes.js';
import { makeDevicesRouteHandler } from '../routes/devices-routes.js';
import { makeDeviceWorkRouteHandler } from '../routes/device-work-routes.js';
import { companionRequestAllowed } from './companion-access.js';
import { makeReplicaRouteHandler } from '../routes/replica-routes.js';
import type { ReplicaIntentDispatchOutcome } from '../routes/replica-intent-route.js';
import { makeConnectionsRouteHandler } from '../routes/connections-routes.js';
import { makeDemoRouteHandler } from '../routes/demo-routes.js';
import { makeImportRouteHandler } from '../routes/import-routes.js';
import { makeBlobRouteHandler } from '../routes/blob-routes.js';
import {
  makeDataPlaneControlHandler,
  type DataPlaneControlOptions,
} from '../routes/data-plane-control.js';
import type { DataPlaneHttpOptions } from './data-plane-handoff.js';
import { makeAppsStoreRouteHandler } from '../routes/apps-store-routes.js';
import { makeDraftCodeDirResolver, type ExtBandOps } from '../lifecycle/ext-band.js';
import {
  makeAutomationsRouteHandler,
  runEventsSubscriberCount,
} from '../routes/automations-routes.js';
import { RunEventBus } from '../runs/run-event-bus.js';
import { defaultLogger } from './default-logger.js';
import { GatewayLogStore } from './gateway-log-store.js';
import { buildDiagnosticsBundle } from './gateway-diagnostics.js';
import { makeDiagnosticsRouteHandler } from '../routes/diagnostics-routes.js';
import { makeBackupRouteHandler } from '../routes/backup-routes.js';
import { makeLifecycleRouteHandler } from '../routes/lifecycle-routes.js';
import { publishAndReconcile, type LifecycleRouteOptions } from '../lifecycle/lifecycle-shared.js';
import {
  finalizeCompiledManifest,
  runHeadlessAutomationCompile,
} from '../lifecycle/headless-automation-compile.js';
import { makeUnifiedConversationRunner } from '../runs/unified-conversation-runner.js';
import {
  assistantCwd,
  makeAssistantConversationRunner,
  makeVaultToolRunners,
} from '../runs/assistant-conversation-runner.js';
import { buildAssistantPrompt } from '../runs/assistant-prompt.js';
import { makeAssistantRouteHandler } from '../routes/assistant-routes.js';
import { makeTemplatesRouteHandler } from '../routes/templates-routes.js';
import { makeAgentsRouteHandler } from '../routes/agents-routes.js';
import { makeGatewayInfoRouteHandler } from '../routes/gateway-info-routes.js';
import { makeHealthRouteHandler } from '../routes/health-routes.js';
import { makeRemindersRouteHandler } from '../routes/reminders-routes.js';
import { HealthRegistry } from './health-registry.js';
import { GatewayPerformanceMonitor } from './gateway-performance.js';
import { measureStorageLatency } from './storage-latency.js';
import { resolveGatewayHardwareProfile } from './hardware-profile.js';
import { logsEventsSubscriberCount, makeLogsRouteHandler } from '../routes/logs-routes.js';
import { sendJson } from '../routes/route-helpers.js';
import type { GatewayPaths } from '../paths.js';
import { BackupService } from '../backup/backup-service.js';
import type { BackupConfig } from '../backup/backup-config.js';
import { openStorageConnectionStore } from '../backup/storage-connections.js';
import { StorageUsagePoller } from '../backup/storage-usage.js';
import { PricingWarmer } from './pricing-warmer.js';
import { RecoveryKitStateStore } from '../backup/recovery-kit-state.js';
import { makeStorageCredentialsResolver } from '../backup/storage-credentials.js';
import { makeStorageRouteHandler } from '../routes/storage-routes.js';
import { RecoverJobRunner } from '../backup/recover-job.js';
import { makeRecoverRouteHandler } from '../routes/recover-routes.js';
import { WebAppSessions } from './web-app-sessions.js';

export type { DeviceAccess } from './vault-context.js';

export interface BuildGatewayOptions {
  /** On-disk slots the runtime reads/writes. Caller-derived. */
  paths: GatewayPaths;
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
   * Device-plane access control (issue #289 phase 2). When set, the
   * composed handler resolves the calling device from the request and
   * refuses vaults the device is not enrolled in; the vault list filters
   * to the device's enrollments. Absent (loopback embed, tests), the
   * transport is implicitly enrolled in every vault.
   */
  deviceAccess?: DeviceAccess;
  /** Optional Rust byte-plane X-Sendfile handoff (issue #456 N3). */
  dataPlaneHttp?: DataPlaneHttpOptions;
  /** Auth callback used only by the native iroh relay on loopback. */
  dataPlaneControl?: DataPlaneControlOptions;
  /** Host-selected preview engine; daemon defaults to native sharp/libvips. */
  previewCodec?: PreviewCodec;
  /**
   * The daemon's device-pairing plane (issue #376): its `EnrollmentStore`
   * + `PairingTicketStore` + `DeviceTokenStore`. When set, `buildGateway`
   * mounts `POST /centraid/_gateway/pair` (`routes/pair-routes.ts`) — the
   * HTTP twin of the iroh `gw-pair` ceremony, for devices that cannot dial
   * the iroh endpoint directly. `serve()` also adds that route's path to
   * the HTTP listener's `publicPaths` when this is set. Absent for the
   * desktop embed (no dataDir-backed device plane) and most tests.
   */
  devicePairing?: {
    enrollments: EnrollmentStore;
    tickets: PairingTicketStore;
    deviceTokens: DeviceTokenStore;
    /**
     * The gateway's iroh EndpointTicket for a HTTP-minted pairing ticket's
     * `gw` field (`POST /centraid/_gateway/devices/ticket`), read lazily at
     * mint time. Undefined before the daemon has an endpoint.
     */
    endpointTicket?: () => string | undefined;
    /** Close Rust-owned iroh transports after a device loses its final enrollment. */
    onEndpointRevoked?: (endpointId: string) => void | Promise<void>;
  };
  /**
   * Durable PWA control sessions (issue #376). When `controlsFile` is set,
   * `WebAppSessions` persists CONTROL cookies there so a web pairing
   * survives a gateway restart / the sliding 30-day idle window instead of
   * forcing a fresh pairing ticket every 12h. `isDeviceValid` propagates
   * `devices revoke` to live control/app cookies (a revoked device's cookie
   * stops authorizing at once). Absent (desktop embed, tests) → in-memory
   * control sessions with no revocation hook, exactly the prior behavior.
   */
  webSessions?: {
    controlsFile?: string;
    isDeviceValid?: (deviceKey: string) => boolean;
  };
  /**
   * Offsite backup engine (PROTOCOL.md/FORMAT.md), off by default. When
   * `enabled`, `buildGateway` constructs a `BackupService` (component
   * `'backups'` on `health`), starts its hourly scheduler from `start()`,
   * and stops it from `stop()`. State lives under `paths.backupDir`
   * (defaults to a `backup` sibling of `paths.vaultDir`).
   */
  backup?: BackupConfig;
}

/** Fires one automation. Shared by the cron scheduler + the run-now route. */
export type FireAutomation = (
  automationRef: string,
  opts: {
    runId?: string;
    triggerKind: AutomationTriggerKind;
    triggerOrigin: AutomationTriggerOrigin;
    /** Trigger payload surfaced to the handler as `ctx.input` (condition/data fires). */
    input?: unknown;
  },
) => void;

/** A route handler in the gateway chain: `true` when it owned the response. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export interface RoutePrefixRegistration {
  readonly prefixes: readonly string[];
  readonly handler: RouteHandler;
}

/** Register a handler in the immutable prefix table built at gateway boot (#456 R1). */
export function forRoutePrefixes(
  prefixes: string | readonly string[],
  handler: RouteHandler,
): RoutePrefixRegistration {
  return { prefixes: typeof prefixes === 'string' ? [prefixes] : prefixes, handler };
}

interface RoutePrefixNode {
  readonly children: Map<string, RoutePrefixNode>;
  readonly registrations: RoutePrefixRegistration[];
}

function routeSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean);
}

/**
 * Compile route families into a segment trie. Dispatch reads and strips the
 * request query exactly once, performs O(path-depth) map lookups, then invokes
 * only matching handlers from most-specific prefix to least-specific prefix.
 */
export function createRoutePrefixDispatch(
  registrations: readonly RoutePrefixRegistration[],
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
    const raw = req.url ?? '/';
    const query = raw.indexOf('?');
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
    for (let depth = matches.length - 1; depth >= 0; depth--) {
      for (const registration of matches[depth]!) {
        if (invoked.has(registration)) continue;
        invoked.add(registration);
        if (await registration.handler(req, res)) return true;
      }
    }
    return false;
  };
}

export function replicaDispatchOutcome(result: ToolResult): ReplicaIntentDispatchOutcome {
  if (result.isError) {
    const denied = new Set([
      'UNKNOWN_APP',
      'UNKNOWN_ACTION',
      'WRONG_KIND',
      'INVALID_INPUT',
      'INVALID_MANIFEST',
      'NO_ACTIVE_VERSION',
    ]).has(result.structuredContent.code);
    return denied
      ? { status: 'denied', reason: result.structuredContent.message }
      : {
          // HANDLER_ERROR includes a vault bridge failure after the canonical
          // command committed but before journal finalization/transport
          // completed. GATEWAY_BUSY and any future infrastructure error are
          // likewise safe to retry. The route keeps the admitted intent in
          // `sending`; deterministic intent-bound invocation ids dedupe it.
          status: 'retryable',
          reason: result.structuredContent.message,
        };
  }
  const value = result.structuredContent;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const outcome = value as {
      status?: unknown;
      invocationId?: unknown;
      reason?: unknown;
      output?: unknown;
    };
    const reason = typeof outcome.reason === 'string' ? outcome.reason : undefined;
    if (outcome.status === 'parked') {
      return {
        status: 'parked',
        ...(typeof outcome.invocationId === 'string' ? { invocationId: outcome.invocationId } : {}),
        ...(reason ? { reason } : {}),
      };
    }
    if (outcome.status === 'denied' || outcome.status === 'failed') {
      return {
        status: outcome.status,
        reason: reason ?? `app action ${outcome.status}`,
        ...(outcome.output !== undefined ? { output: outcome.output } : {}),
      };
    }
    if (outcome.status === 'executed' || outcome.status === 'replayed') {
      return {
        status: 'executed',
        ...(outcome.output !== undefined ? { output: outcome.output } : {}),
      };
    }
  }
  return { status: 'executed', ...(value !== undefined ? { output: value } : {}) };
}

// Prefixes the chat-history + prefs routes answer to, mirrored from
// app-engine's http-server.ts so `composedHandler` matches the same URLs
// `startRuntimeHttpServer` does.
const CONVERSATIONS_PREFIX = '/_centraid-conversations';
const USER_STORE_PREFIX = '/_centraid-user';

/** Shared device-tier gate, before any owner/app/action route can dispatch. */
function readonlyRequestAllowed(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  let url = new URL(req.url ?? '/', 'http://gateway.local');
  if (url.pathname === '/centraid/_web/control') {
    const target = url.searchParams.get('path');
    if (target?.startsWith('/')) url = new URL(target, 'http://gateway.local');
  }
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (method !== 'POST') return false;
  if (
    url.pathname === '/centraid/_tool/centraid_read' ||
    url.pathname === '/centraid/_tool/centraid_describe' ||
    /^\/centraid\/_draft\/[^/]+\/_tool\/centraid_(?:read|describe)$/.test(url.pathname)
  ) {
    return true;
  }
  // Checkpoints record only how far this device has durably consumed the
  // read protocol; they grant no write authority over app/vault data.
  return url.pathname === '/centraid/_vault/replica/checkpoint';
}

/** The per-vault host bundle — one per vault, built lazily, cached by id. */
interface VaultHost {
  vaultId: string;
  store: WorktreeStore;
  codeAppsDir: () => string;
  draftCodeDir: (appId: string, sessionId: string) => Promise<string | undefined>;
  runner: ConversationRunner;
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
  /** Device-prefs store (`prefs.json`) — #280 killed the identity DB. */
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
  appsStore(): Promise<WorktreeStore>;
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
  syncApps(vaultId?: string): Promise<void>;
  /** Scoped cookie sessions used only by generated apps embedded in the browser PWA. */
  webAppSessions: WebAppSessions;
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
   * unique), then blocks until the fire completes and answers with its
   * outcome. Returns `false` for any non-matching URL so the host can
   * fall through to `composedHandler`.
   */
  webhookHandler: RouteHandler;
  /**
   * The pre-vault recovery routes (`/centraid/_gateway/recover/*`, issue #439
   * R1 wave 4), mounted like `webhookHandler` as a TOP-LEVEL handler outside
   * `composedHandler`'s per-request vault scope — recovery stands up (and
   * adopts) the home vault before one is chosen. Bearer-gated by the app-engine
   * check (not public) and admin-plane only. Returns `false` for any
   * non-matching URL so the host falls through to `composedHandler`.
   */
  recoverHandler: RouteHandler;
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
  start(publicBaseUrl: string): Promise<void>;
  /** Stop every vault's cron scheduler. Idempotent. */
  stop(): Promise<void>;
}

export async function buildGateway(options: BuildGatewayOptions): Promise<BuiltGateway> {
  const { paths } = options;
  // Every log line tees through the gateway log store (realtime Logs
  // surface) before reaching the console/host logger — see logs-routes.ts.
  // Persistence (issue #351) is opt-in via `paths.logsDir` — omitted, this
  // is exactly the prior in-memory-only store (tests, disposable embeds).
  const logStore = new GatewayLogStore(undefined, paths.logsDir ? { dir: paths.logsDir } : {});
  const logger = logStore.wrap(options.logger ?? defaultLogger(options.logTag));

  // Component-level health (observability for self-hosters): subsystems
  // report ok/error at their own success/failure points, warns/errors land
  // in a structured ring buffer, and `GET /centraid/_gateway/health`
  // aggregates it all. Hosts push externally-owned components (e.g. the
  // desktop's iroh tunnel) through `BuiltGateway.health`.
  const health = new HealthRegistry();
  const performanceMonitor = new GatewayPerformanceMonitor();
  health.setPerformanceMetricsSource(
    () => performanceMonitor.snapshot(),
    () => performanceMonitor.resetMeasurement(),
  );
  let storageFsyncMs: number | undefined;
  try {
    const storageLatency = await measureStorageLatency(paths.vaultDir);
    storageFsyncMs = storageLatency.fsyncMs;
    performanceMonitor.setStorageFsyncMs(storageLatency.fsyncMs);
    health.reportOk('storage-latency', `4 KiB fsync ${storageLatency.fsyncMs.toFixed(1)} ms`);
  } catch (err) {
    health.reportDegraded(
      'storage-latency',
      `boot fsync probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  health.registerProbe('event-loop', async () => {
    const sample = performanceMonitor.snapshot();
    const detail = `p50 ${sample.eventLoopLagP50Ms.toFixed(1)} ms; p99 ${sample.eventLoopLagP99Ms.toFixed(1)} ms; max ${sample.eventLoopLagMaxMs.toFixed(1)} ms`;
    return sample.eventLoopLagP99Ms >= 50
      ? { status: 'degraded', detail }
      : { status: 'ok', detail };
  });
  const hardwareProfile = resolveGatewayHardwareProfile(
    storageFsyncMs === undefined ? {} : { storageFsyncMs },
  );
  // App-engine's worker/compression seams initialize lazily, after this boot
  // probe. Publish the resolved class so slow storage and explicit overrides
  // select the same actual limits that this health line reports.
  process.env.CENTRAID_RESOLVED_HARDWARE_PROFILE = hardwareProfile.class;
  // Publish the exact resolved values, including validated operator
  // overrides. Lazy consumers read these values instead of independently
  // reclassifying the host and drifting from this health record.
  process.env.CENTRAID_WORKER_MAX_CONCURRENT = String(hardwareProfile.workerMaxConcurrent);
  process.env.CENTRAID_WORKER_MAX_OLD_GENERATION_MB = String(
    hardwareProfile.workerMaxOldGenerationMb,
  );
  process.env.CENTRAID_WORKER_POOL_SIZE = String(hardwareProfile.workerPoolSize);
  process.env.CENTRAID_REPLICATION_CONCURRENCY = String(hardwareProfile.replicationConcurrency);
  process.env.CENTRAID_STATIC_BROTLI_QUALITY = String(hardwareProfile.staticBrotliQuality);
  process.env.CENTRAID_STATIC_GZIP_QUALITY = String(hardwareProfile.staticGzipQuality);
  health.reportOk(
    'hardware-profile',
    `${hardwareProfile.class}; sqlite=${hardwareProfile.sqliteSynchronous}; workers=${hardwareProfile.workerMaxConcurrent}x${hardwareProfile.workerMaxOldGenerationMb}MB; pool=${hardwareProfile.workerPoolSize}; replication=${hardwareProfile.replicationConcurrency}; compression=br${hardwareProfile.staticBrotliQuality}/gz${hardwareProfile.staticGzipQuality}; mount=${hardwareProfile.vaultMountStrategy}; sweep=${hardwareProfile.vaultSweepIntervalMs}ms`,
  );
  const webAppSessions = new WebAppSessions(options.webSessions ?? {});

  // Bundled blueprint apps (issue #434): these ids serve in place from the
  // shipped @centraid/blueprints package, upgrade with every release, and are
  // RESERVED — a code-store app must never shadow one. The set is fixed for
  // the process lifetime (it's the release's catalog), so we resolve it once
  // here and close over it for the resolver, the id-reservation guard, and
  // the install/listing paths below.
  const bundledAppIds = new Set((await listBundledAppTemplates()).map((t) => t.id));
  const isBundledAppId = (id: string): boolean => bundledAppIds.has(id);

  // Second-gateway detection (issue #351 tier 1): "one gateway per user" is
  // an owner-stated topology, never enforced — nothing stops a copied vault
  // dir or a daemon + desktop embed both pointed at the same root from
  // corrupting data via cross-copy WAL semantics. A lease file at the vault
  // registry root records who's serving; a FRESH foreign lease is never
  // clobber-written (split-brain must be loud, never auto-resolved — mirrors
  // the backup protocol's generation fencing), a STALE one (crashed owner)
  // is reclaimed cleanly. Constructed BEFORE the vault registry (moved up
  // from its original spot, issue #367 §C6) so `isConflicted()` is a valid
  // closure target for `VaultRegistryOptions.leaseConflicted` below — the
  // blob sweep's orphan-delete gate reads this on every tick.
  const instanceLease = new GatewayInstanceLease({
    rootDir: paths.vaultDir,
    health,
    logger: health.loggerFor('instance', logger),
  });
  // WAL ownership must be known before the registry opens any vault plane.
  instanceLease.claim();

  // Gateway-level storage state (issue #367 §C1/§C10): the storage-
  // connection entity (a sealed provider api key, shared by the backup
  // engine and every vault's CAS tier) and the recovery-kit
  // confirmation flag, generalized off the backup-only field it started as.
  // Both live under `paths.storageDir` (default a `storage` sibling of
  // `vaultDir`, same convention as `backupDir`) — gateway plumbing, never
  // inside a vault directory a raw copy could carry off-box.
  const storageDir = paths.storageDir ?? path.join(path.dirname(paths.vaultDir), 'storage');
  const storageConnections = await openStorageConnectionStore(storageDir);
  let walCaptureConfigured =
    options.backup?.enabled === true || (await storageConnections.list()).length > 0;
  const recoveryKit = new RecoveryKitStateStore(storageDir);
  // Provider usage cache (issue #367 §D1) — cache-with-TTL + stale-while-
  // refresh in front of a provider connection's optional `usage` capability
  // (PROTOCOL.md § Usage). Never polls on its own timer; see storage-usage.ts.
  const storageUsage = new StorageUsagePoller({ storageConnections });

  // Model price catalog (issue #445) — seed the app-engine pricing seam from a
  // fresh-enough disk cache and kick a background LiteLLM refresh. Costing works
  // from the bundled snapshot regardless; this only overlays fresher rates. The
  // cache file sits beside `model-catalog.json` when the host pins one.
  const pricingCacheFile =
    paths.modelPricingFile ??
    (paths.modelCatalogFile
      ? path.join(path.dirname(paths.modelCatalogFile), 'model-pricing.json')
      : undefined);
  const pricingWarmer = new PricingWarmer({
    ...(pricingCacheFile ? { cacheFile: pricingCacheFile } : {}),
    logger: health.loggerFor('pricing', logger),
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
  let provenanceDoorbell: (vaultId: string, entityTypes?: readonly string[]) => void = () => {};
  const vaultRegistry: VaultRegistry = openVaultRegistry({
    rootDir: paths.vaultDir,
    synchronous: hardwareProfile.sqliteSynchronous,
    replicationConcurrency: hardwareProfile.replicationConcurrency,
    sweepIntervalMs: hardwareProfile.vaultSweepIntervalMs,
    shouldDeferBackgroundWork: () => health.shouldDeferBackgroundWork(),
    walCaptureEnabled: () => walCaptureConfigured,
    // Disposable runner cache lives outside the vault tree (defaults to a
    // `-cache` sibling of `vaultDir` when the host doesn't pin one).
    ...(paths.cacheDir ? { cacheRootDir: paths.cacheDir } : {}),
    logger: health.loggerFor('vaults', logger),
    // Lease-gated reconciliation (issue #367 §C6): every mounted plane's
    // blob sweep reads this fresh on each tick.
    leaseConflicted: () => instanceLease.isConflicted(),
    // Storage-connection-backed credential resolution (issue #367 §C3):
    // supersedes the legacy `CENTRAID_S3_*` env-var lane for any vault whose
    // `blob_store.connectionId` is set; vaults without one keep working off
    // the env-var default (`vault-plane.ts`'s `defaultEnvS3Credentials`).
    s3Credentials: makeStorageCredentialsResolver(storageConnections),
    onProvenanceCommitted: (vaultId, entityTypes) => provenanceDoorbell(vaultId, entityTypes),
    // Preview backstop codec (issue #405 §2): the gateway holds plaintext on
    // ingest inside the owner's trust boundary, so generating tiny/medium
    // derivatives here leaks nothing to the provider. One shared stateless
    // codec instance fans out to every mounted plane's blob sweep, closing the
    // "no raster codec in the runtime" gap for imported / weak-client /
    // server-ingested images (capable clients still generate at capture).
    previewCodec: options.previewCodec ?? createImagePreviewCodec(),
  });

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
  health.registerProbe('vaults', async () => {
    vaultRegistry.rescan();
    const planes = vaultRegistry.planesList();
    const failed = vaultRegistry.failedMounts();
    const unreadable: string[] = [];
    for (const plane of planes) {
      try {
        plane.db.vault.prepare('PRAGMA user_version').get();
      } catch (err) {
        unreadable.push(
          `${plane.boot.vaultId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const quarantined = planes.filter((p) => p.quarantine !== null);

    if (failed.length > 0 || unreadable.length > 0) {
      const notes = [
        ...failed.map((f) => `${f.dir}: ${f.message} (since ${f.at})`),
        ...unreadable.map((u) => `${u} — vault.db unreadable`),
      ];
      return { status: 'error', detail: notes.join('; ') };
    }
    if (quarantined.length > 0) {
      const detail = quarantined
        .map((p) => `${p.boot.vaultId} (source seq ${p.quarantine?.sourceSeq}) needs review`)
        .join('; ');
      return { status: 'error', detail: `restored from backup — ${detail}` };
    }
    return planes.length > 0
      ? { status: 'ok', detail: `${planes.length} vault${planes.length === 1 ? '' : 's'} mounted` }
      : { status: 'error', detail: 'no vaults mounted' };
  });

  // Disk watermark (issue #351): free space on the vault volume, plus a
  // cheap per-vault DB size so "which vault is eating the disk" doesn't
  // need a shell. Thresholds live in disk-health.ts.
  health.registerProbe(
    'disk',
    createDiskHealthProbe({
      rootDir: paths.vaultDir,
      vaults: () =>
        vaultRegistry.planesList().map((p) => ({ vaultId: p.boot.vaultId, dir: p.dir })),
    }),
  );

  // `instanceLease` is constructed above (before the vault registry) —
  // `start()`/`stop()` below drive its renew timer; `instanceId` also rides
  // `_gateway/info` so a client can detect a gateway swap-under-it.

  // Connection health lives in each vault's DB (`needs-auth` flips there,
  // not in broker memory) — surface "N connections need re-auth" so a dead
  // OAuth token shows up here instead of as silent connector failures.
  health.registerProbe('connections', async () => {
    let total = 0;
    let needsAuth = 0;
    for (const plane of vaultRegistry.planesList()) {
      const rows = plane.db.vault
        .prepare(`SELECT status, COUNT(*) AS n FROM sync_connection GROUP BY status`)
        .all() as Array<{ status: string; n: number }>;
      for (const row of rows) {
        total += row.n;
        if (row.status === 'needs-auth') needsAuth += row.n;
      }
    }
    if (needsAuth > 0) {
      return {
        status: 'degraded',
        detail: `${needsAuth} of ${total} connection${total === 1 ? '' : 's'} need re-auth`,
      };
    }
    return { status: 'ok', detail: `${total} connection${total === 1 ? '' : 's'} configured` };
  });

  // Broker credential health (issue #351 tier 2): narrower than `connections`
  // above — specifically the ConnectionBroker's own custody of
  // broker-carried (oauth2/api_key) credentials, naming which ones are dead
  // or sitting on an overdue token nobody has refreshed yet. See
  // `broker-health.ts` for why this is a separate signal from `connections`.
  health.registerProbe(
    'broker',
    createBrokerHealthProbe({
      vaults: () =>
        vaultRegistry.planesList().map((p) => ({ vaultId: p.boot.vaultId, db: p.db.vault })),
    }),
  );

  // Scheduler ledger (issue #351 tier 2): one shared `ConversationStore` per
  // mounted vault, bound to that vault's `journal.db` via the SAME
  // `makeJournalDbProvider` path `fire.ts` and the analytics stores use —
  // guarantees the conversation-ledger band (`automation_state` included)
  // exists before this reads/writes it, regardless of tick timing. Memoized
  // so a health poll or a scheduler tick never reopens the file. Written
  // from each vault's scheduler `onTick` hook below; read by the
  // `scheduler` liveness probe and by `automations`'s reconcile push.
  const schedulerLedgers = new Map<string, automation.SchedulerLedgerStore>();
  const schedulerLedgerFor = (vaultId: string): automation.SchedulerLedgerStore => {
    const existing = schedulerLedgers.get(vaultId);
    if (existing) return existing;
    const plane = vaultRegistry.get(vaultId);
    if (!plane) throw new Error(`gateway: unknown vault "${vaultId}"`);
    const ledger = new automation.SchedulerLedgerStore(
      new ConversationStore(makeJournalDbProvider(plane.workspace.journalDbFile)),
    );
    schedulerLedgers.set(vaultId, ledger);
    return ledger;
  };

  // Per-vault scheduler liveness + missed-run visibility (issue #351 tiers
  // 2/3) — see scheduler-health.ts. Reads the SAME ledger `onTick` writes.
  health.registerProbe(
    'scheduler',
    createSchedulerHealthProbe({
      vaults: () =>
        vaultRegistry.planesList().map((p) => ({
          vaultId: p.boot.vaultId,
          snapshot: () => schedulerLedgerFor(p.boot.vaultId).load(),
        })),
    }),
  );

  // Enricher run health (issue #351 wave 4) — see enrichment-health.ts for
  // why this is narrower than `automations`/`automation-runs`. Run history
  // rides its own memoized `ConversationStore` (same journalDbFile binding
  // `schedulerLedgerFor` uses, kept separate so this probe never reaches
  // into scheduler-ledger.ts's private state).
  const enrichmentConversationStores = new Map<string, ConversationStore>();
  const enrichmentConversationStoreFor = (vaultId: string): ConversationStore => {
    const existing = enrichmentConversationStores.get(vaultId);
    if (existing) return existing;
    const plane = vaultRegistry.get(vaultId);
    if (!plane) throw new Error(`gateway: unknown vault "${vaultId}"`);
    const store = new ConversationStore(makeJournalDbProvider(plane.workspace.journalDbFile));
    enrichmentConversationStores.set(vaultId, store);
    return store;
  };
  health.registerProbe(
    'enrichment',
    createEnrichmentHealthProbe({
      vaults: () =>
        vaultRegistry.planesList().map((p) => ({
          vaultId: p.boot.vaultId,
          listAutomations: async () => {
            const { rows } = await automation.list(settledHostFor(p.boot.vaultId).codeAppsDir());
            return rows.map((r) => ({ id: r.id, enabled: r.enabled, ref: r.ref }));
          },
          recentRuns: (automationRef, limit) =>
            enrichmentConversationStoreFor(p.boot.vaultId)
              .listAutomationTurns(automationRef, { limit })
              .map((t) => ({
                ok: t.ok,
                ...(t.endedAt !== undefined ? { endedAt: t.endedAt } : {}),
              })),
        })),
    }),
  );

  // Blob custody-sweep health (issue #351 wave 4, #367 prep) — see
  // blob-sweep-health.ts. `s3Configured`/`counts` are cheap synchronous
  // reads (settings JSON + a GROUP BY over the custody mirror); `sweepStatus`
  // reads `BlobCustody`'s own in-memory record of its last `reconcile()`.
  health.registerProbe(
    'blob-sweep',
    createBlobSweepHealthProbe({
      vaults: () =>
        vaultRegistry.planesList().map((p) => ({
          vaultId: p.boot.vaultId,
          s3Configured: () => readBlobStoreSettings(p.db.vault).kind === 's3',
          counts: () => custodyStateCounts(p.db.vault),
          sweepStatus: () => p.db.blobs.sweepStatus(),
        })),
    }),
  );

  // On-disk integrity (issue #374 tier 5b) — see vault-integrity-health.ts.
  // Self-throttled hourly per vault (quick_check is a full logical scan,
  // not a per-tick-cheap read); distinct from the `vaults` probe above,
  // which only proves the file still opens.
  health.registerProbe(
    'vault-integrity',
    createVaultIntegrityHealthProbe({
      vaults: () =>
        vaultRegistry.planesList().map((p) => ({
          vaultId: p.boot.vaultId,
          vault: p.db.vault,
          journal: p.db.journal,
        })),
    }),
  );

  // Storage quota watermark (issue #367 §D2) — degraded/error off a
  // provider-reported quota only (see storage-quota-health.ts); reads the
  // SAME cache `GET storage/usage` serves, so this never issues its own
  // network call beyond what that poller's TTL already allows.
  health.registerProbe(
    'storage-quota',
    createStorageQuotaHealthProbe({
      connections: async () =>
        (await storageConnections.list()).map((c) => ({
          connectionId: c.id,
          name: c.name,
          kind: c.kind,
        })),
      usageFor: (connectionId) => storageUsage.usageFor(connectionId),
    }),
  );

  // Numeric signals (issue #351 tier 3): outbox backlog, summed across
  // mounted vaults — cheap COUNT(*) at snapshot time, same style as the
  // `connections` probe above. `rssBytes`/`uptimeMs` need no wiring (see
  // `HealthRegistry.snapshot`). `sseClients` sums three production SSE
  // surfaces' live subscriber counts — `logsEventsSubscriberCount` /
  // `runEventsSubscriberCount` (issue #351's SSE subscriber-cap change,
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
          .prepare(`SELECT COUNT(*) AS n FROM outbox_item WHERE status = 'approved'`)
          .get() as { n: number } | undefined;
        outboxPending += row?.n ?? 0;
      } catch {
        /* a vault whose outbox table isn't there yet contributes 0 */
      }
    }
    return {
      outboxPending,
      sseClients:
        logsEventsSubscriberCount() + runEventsSubscriberCount() + changesSubscriberCount(),
    };
  });

  // Offsite backup engine (PROTOCOL.md/FORMAT.md). A static daemon config
  // still takes precedence; otherwise the service resolves the provider
  // storage connection marked for backup on every operation. This makes a
  // connection created in the desktop immediately effective without a
  // process restart or a second, hidden configuration source.
  const backupDir = paths.backupDir ?? path.join(path.dirname(paths.vaultDir), 'backup');
  const backupService = new BackupService({
    ...(options.backup?.enabled ? { config: options.backup } : {}),
    backupDir,
    vaults: vaultRegistry,
    health,
    logger: health.loggerFor('backups', logger),
    recoveryKit,
    storageConnections,
  });

  // The daemon-owned recovery job (issue #439 R1 wave 4). It runs the
  // service-layer `recover()` verb with the LIVE gateway's own seams wired in:
  // `adopt` mounts the recovered vault through the registry, and
  // `resolveRemoteTier` hands back the mounted plane's `db.remote()` so the
  // previews-first warm pass runs in-process. Progress persists under
  // `storageDir` (metadata only — never the kit keyring or the api-key); `init`
  // reconciles a job the previous daemon process died mid-flight (marks it
  // interrupted + sweeps torn staging scratch).
  const recoverJob = new RecoverJobRunner({
    dir: storageDir,
    vaultRoot: paths.vaultDir,
    backupDir,
    adopt: (vaultId) => {
      vaultRegistry.adopt(vaultId);
    },
    resolveRemoteTier: (ctx) => vaultRegistry.get(ctx.vaultId)?.db.remote() ?? undefined,
    logger: health.loggerFor('backups', logger),
  });
  await recoverJob.init();
  const recoverHandler = makeRecoverRouteHandler({
    job: recoverJob,
    isFresh: () => vaultRegistry.isFresh(),
  });

  const currentWorkspace = (): VaultWorkspace => vaultRegistry.currentWorkspace();

  // Device prefs (`prefs.json`) + the request vault's ledger stores. The
  // analytics/insights providers resolve the request's vault per call, so
  // every client sees its own vault's ledger (#289).
  const prefs = new PrefsStore(paths.prefsFile);
  const journalProvider = () => currentWorkspace().journal();
  const analyticsStore = new AnalyticsStore(journalProvider);
  const insightsStore = new InsightsStore(journalProvider);
  // Lazy archive rehydration (issue #438 wave 3): opening a conversation whose
  // cold ranges were custody-gated-pruned reads the sealed segment blobs back
  // through the ACTIVE vault's CAS door (`db.blobs.open` — local hit or remote
  // fetch → unseal → verify → promote). Resolved per call via `current()` — the
  // SAME active-vault resolution `currentWorkspace` uses — so a vault switch
  // reads the right file. The store degrades to `archiveUnavailable` if a fetch
  // fails; the standalone http-server host wires no reader at all.
  const conversationHistoryStore = new ConversationHistoryStore(currentWorkspace, {
    archiveBlobReader: (sha) => vaultRegistry.current().db.blobs.open(sha),
  });

  // Per-turn prefs loader. Re-reads `prefs.json` every chat turn so a
  // settings change lands without a restart.
  //
  // Runner selection is PER SUBSYSTEM: `runner.<subsystem>` pins one
  // register (assistant/ask/builder/automations) to a runner; unpinned
  // registers inherit `agent.runner.kind`, which is now "the default agent"
  // rather than "the one active runner". Callers that don't name a
  // subsystem get the default agent — byte-identical to the old behavior,
  // which is what keeps a prefs file with no `runner.*` keys working
  // exactly as it did.
  const prefsLoader = async (subsystem?: ModelSubsystem): Promise<RunnerPrefs | undefined> => {
    const allPrefs = prefs.getAllPrefs();
    const kindRaw = subsystem
      ? resolveSubsystemRunner(allPrefs, subsystem)
      : allPrefs['agent.runner.kind'];
    // Codex is the default when the user hasn't picked — matches the
    // settings panel's "Codex preferred when both present" copy.
    const kind: RunnerPrefs['kind'] =
      kindRaw === 'codex' || kindRaw === 'claude-code' ? kindRaw : 'codex';
    const binPath =
      typeof allPrefs['agent.runner.binPath'] === 'string'
        ? (allPrefs['agent.runner.binPath'] as string)
        : undefined;
    const extraArgsRaw = allPrefs['agent.runner.extraArgs'];
    const extraArgs = Array.isArray(extraArgsRaw)
      ? (extraArgsRaw.filter((v) => typeof v === 'string') as string[])
      : undefined;
    return {
      kind,
      ...(binPath ? { binPath } : {}),
      ...(extraArgs ? { extraArgs } : {}),
    };
  };

  // Per-subsystem model resolution (shared prefs contract): explicit
  // (request/manifest) → `model.<runnerKind>.<subsystem>` → `model.<runnerKind>.default`
  // → nothing (the backend's own built-in default).
  //
  // The runner is resolved FIRST, for THIS subsystem, and that kind is what
  // scopes the model key. Model prefs are per runner (`model.<kind>.<sub>`),
  // so reading them against the global kind while the subsystem actually runs
  // on a different one hands the turn a model its backend has never heard of.
  // Both halves come off the same per-turn `prefsLoader` every register reads,
  // so a re-pin lands mid-session without a restart.
  const resolveModel = async (
    subsystem: ModelSubsystem,
    explicit?: string,
  ): Promise<string | undefined> => {
    const runnerPrefs = await prefsLoader(subsystem);
    if (!runnerPrefs) return explicit;
    return resolveSubsystemModel(prefs.getAllPrefs(), runnerPrefs.kind, subsystem, explicit);
  };

  // One warmer owns ALL host-capability enumeration — models + tools, both
  // runners — shared by the boot probe and the status routes so concurrent
  // warms dedupe (a client Refresh mid-boot joins the boot warm). Enumerators
  // honor the active runner's binPath/extraArgs; inactive runners enumerate
  // with defaults. Tools are captured by spawning the CLI against a mock-LLM
  // server (`enumerateHostTools`) from a stable cwd (the gateway's own working
  // dir, NOT a draft worktree — a worktree cwd makes the claude SDK report 0
  // tools).
  const toolProbeCwd = process.cwd();
  const catalogPath = paths.modelCatalogFile;
  // Catalog warms are best-effort; failures record as tagged warn events
  // (visible in `_gateway/health`) without flipping any component red.
  const catalogLogger = health.loggerFor('catalog', logger);
  const warmer = catalogPath
    ? new CatalogWarmer({
        catalogPath,
        enumerateModels: async (kind) => {
          const runnerPrefs = await prefsLoader();
          const isActive = runnerPrefs?.kind === kind;
          return enumerateRunnerModels({
            kind,
            ...(isActive && runnerPrefs?.binPath ? { binPath: runnerPrefs.binPath } : {}),
            ...(isActive && runnerPrefs?.extraArgs ? { extraArgs: runnerPrefs.extraArgs } : {}),
          });
        },
        enumerateTools: async (kind) => {
          const runnerPrefs = await prefsLoader();
          const isActive = runnerPrefs?.kind === kind;
          return enumerateHostTools(kind, {
            cwd: toolProbeCwd,
            ...(isActive && runnerPrefs?.binPath ? { binPath: runnerPrefs.binPath } : {}),
          });
        },
      })
    : undefined;

  // Read + refresh contract for a catalog surface: a Refresh (or a cold cache)
  // kicks the warmer fire-and-forget; the response carries whatever's cached
  // now plus the tri-state so the client knows whether to poll. `ready` wins
  // over `loading`, so a Refresh over an existing list keeps showing it.
  const resolveCatalogSurface = async <T>(
    surface: CatalogSurface,
    kind: RunnerKind,
    refresh: boolean,
    read: (cp: string, k: RunnerKind) => Promise<T[]>,
  ): Promise<{ list: T[]; status: SurfaceStatus }> => {
    if (!catalogPath || !warmer) return { list: [], status: 'empty' };
    const list = await read(catalogPath, kind);
    if (refresh || list.length === 0) void warmer.warm(kind, surface);
    return { list, status: deriveStatus(list.length, warmer.isWarming(kind, surface)) };
  };

  const resolveCatalogModels = catalogPath
    ? (kind: RunnerKind, refresh: boolean) =>
        resolveCatalogSurface('models', kind, refresh, readRunnerModels)
    : undefined;
  const resolveCatalogTools = catalogPath
    ? (kind: RunnerKind, refresh: boolean) =>
        resolveCatalogSurface('tools', kind, refresh, readRunnerTools)
    : undefined;

  // Ask-model picker (kit Ask panel, subsystem `ask`) — GET/PUT
  // `/centraid/<appId>/_turn/model`. Reads/writes the SAME
  // `model.<runnerKind>.ask` prefs key `resolveModel` resolves at turn
  // time — where `<runnerKind>` is ASK's resolved runner, not the default
  // agent, so the picker never reads one key and writes another once the
  // owner pins `runner.ask`. Off the SAME catalog surface the desktop's Settings → Agents
  // picker reads (`resolveCatalogModels`) — one source of truth, no second
  // store. A cold/empty catalog just means an empty `catalog` list; the
  // picker still shows "Use default".
  const askModelPrefs = {
    get: async (): Promise<AskModelInfo> => {
      const runnerPrefs = (await prefsLoader('ask')) ?? { kind: 'codex' as const };
      const allPrefs = prefs.getAllPrefs();
      const scoped = allPrefs[`model.${runnerPrefs.kind}.ask`];
      const current = typeof scoped === 'string' && scoped.length > 0 ? scoped : null;
      const savedDefault = allPrefs[`model.${runnerPrefs.kind}.default`];
      const { list } = resolveCatalogModels
        ? await resolveCatalogModels(runnerPrefs.kind, false)
        : { list: [] };
      const defaultModel =
        typeof savedDefault === 'string' && savedDefault.length > 0
          ? savedDefault
          : list.find((m) => m.default)?.id;
      return {
        runnerKind: runnerPrefs.kind,
        ...(defaultModel ? { defaultModel } : {}),
        current,
        catalog: list.map((m) => ({ id: m.id, label: m.name ?? m.id })),
      };
    },
    set: async (model: string | null): Promise<void> => {
      const runnerPrefs = (await prefsLoader('ask')) ?? { kind: 'codex' as const };
      prefs.setPrefs({
        [`model.${runnerPrefs.kind}.ask`]: model && model.length > 0 ? model : null,
      });
    },
  };

  // Catalog invalidation (issue #308 B4): the warmer used to run at boot /
  // manual Refresh only, so a published app, an install, or a new
  // connection could leave both model surfaces blind to new host tools
  // until someone clicked Refresh. Lifecycle events kick a re-warm of the
  // active runner's tools surface — fire-and-forget, deduped by the warmer.
  const invalidateToolCatalog = (): void => {
    if (!warmer) return;
    void (async () => {
      const runnerPrefs = await prefsLoader();
      if (!runnerPrefs) return;
      await warmer.warm(runnerPrefs.kind, 'tools');
    })().catch((err: unknown) => {
      catalogLogger.warn(
        `tool-catalog invalidation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  // Cycle break: the chat runner needs the Runtime's dispatcher, but
  // the Runtime is constructed *with* the chat runner. The runtimeRef
  // holder resolves at call time, after the assignment below.
  let runtimeRef: Runtime | undefined;
  const getDispatcher = (): Runtime['dispatcher'] => {
    const rt = runtimeRef;
    if (!rt) throw new Error('chat runner invoked before runtime was constructed');
    return rt.dispatcher;
  };
  // The runner builds webhook URLs against the live server origin, known
  // only after `startRuntimeHttpServer` resolves below — a turn only ever
  // runs post-start, so this holder is populated by then.
  let serverUrl = '';

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

  // The connection broker (issue #304): resolves a connector's broker-carried
  // credential (oauth2/api_key sealed on the connection row) per fire —
  // refresh under a per-connection single-flight, values injected transport-
  // side, never handed to handler code. Resolves the CURRENT vault's plane at
  // call time, exactly like `vaultFor` below.
  const connectionBroker = new ConnectionBroker(() => vaultRegistry.current());

  // The outbox executor (issue #306): the only writer on the broker's
  // `allowWrites` lane, draining owner-approved / grant-matched items. It
  // runs OUTSIDE the fire loop — kicked after owner approvals, after each
  // fire (grant-matched items a connector just staged), and on a slow clock.
  const outboxExecutor = new OutboxExecutor(connectionBroker, health.loggerFor('outbox', logger));
  const drainOutbox = (plane: VaultPlane): void => {
    void outboxExecutor
      .drain(plane)
      .then(() => health.reportOk('outbox'))
      .catch((err) => {
        const message = `outbox drain failed: ${err instanceof Error ? err.message : String(err)}`;
        health.reportError('outbox', message);
        logger.warn(message);
      });
  };

  // Install-time scopes (issue #306 decision 2): enrolling an app grants the
  // vault block its manifest declares — installing IS the consent. Read off
  // the app's live `main` app.json; malformed or absent blocks grant nothing.
  const grantScopesFromDir = async (
    plane: VaultPlane,
    appId: string,
    dir: string | undefined,
  ): Promise<void> => {
    if (!dir) return;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'app.json'), 'utf8')) as {
        vault?: { purpose?: unknown; scopes?: unknown };
      };
      const block = manifestScopeBlock(raw.vault);
      if (block) plane.ensureAppInstallGrant(appId, block);
    } catch (err) {
      logger.warn(
        `install-time grant for app "${appId}" failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  };
  const grantDeclaredAppScopes = async (
    plane: VaultPlane,
    store: WorktreeStore,
    appId: string,
  ): Promise<void> => {
    // Code-store apps (scaffolds, clones, compiled automations): read the
    // live `main` app.json.
    await grantScopesFromDir(plane, appId, await store.resolveActiveAppDir(appId));
  };
  // Installed bundled apps (issue #434) declare their scopes in the shipped
  // blueprint's app.json — read it there, not from the (empty) code store.
  const grantDeclaredBundledScopes = (plane: VaultPlane, appId: string): Promise<void> =>
    grantScopesFromDir(plane, appId, bundledAppDir(appId));

  const prewarmApp = async (appId: string, dir: string): Promise<void> => {
    try {
      const result = await prewarmAppAssets(dir, KIT_DIR);
      if (result.bundles > 0) {
        logger.info(
          `app assets: prewarmed ${appId} (${result.bundles} bundle(s), ${result.variants} compressed variant(s))`,
        );
      }
    } catch (error) {
      logger.warn(
        `app assets: prewarm failed for ${appId}: ${error instanceof Error ? error.message : String(error)}`,
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
    if (health.shouldDeferBackgroundWork()) {
      scheduleOutboxSweep(hardwareProfile.outboxIdleIntervalMs);
      return;
    }
    const settled = await Promise.allSettled(
      vaultRegistry.planesList().map((plane) => outboxExecutor.drain(plane)),
    );
    let active = false;
    let failed = false;
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        active ||= result.value.approved > 0 || result.value.deferred > 0;
      } else {
        failed = true;
        logger.warn(
          `outbox sweep failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        );
      }
    }
    if (failed) health.reportError('outbox', 'one or more adaptive outbox sweeps failed');
    else health.reportOk('outbox');
    const nextDelay = failed
      ? Math.min(hardwareProfile.outboxIdleIntervalMs * 2, 15 * 60 * 1000)
      : active
        ? 5_000
        : hardwareProfile.outboxIdleIntervalMs;
    scheduleOutboxSweep(nextDelay);
  };

  // The one fire path, shared by "run now" (manual) and the cron schedulers
  // (scheduled). Runs on THIS host with the gateway's own runner pref,
  // against the CURRENT vault's live `main` code + its data tree, streaming
  // each run over the event bus. Scheduled fires enter their vault's scope
  // via `runWithVaultContext` (see schedulerFor); manual fires inherit the
  // request's scope.
  const fireAutomation: FireAutomation = (automationRef, opts): void => {
    // Mint the runId here so every fire (cron included) has a bus channel.
    const runId = opts.runId ?? `${automationRef}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
    void (async () => {
      const runnerPrefs = await prefsLoader('automations');
      const host = await currentVaultHost();
      const ws = currentWorkspace();
      // Prefs fallback for `ctx.agent` calls — the automation's own
      // `requires.model` (read inside `runFire`) still wins over this.
      const automationsModel = await resolveModel('automations');
      await runAutomation({
        automationRef,
        runId,
        appsDir: ws.appsDir,
        journalDbFile: ws.journalDbFile,
        codeAppsDir: host.codeAppsDir(),
        // Each fire's ctx.vault rides the automation's enrolled
        // agent.agent credential, resolved per app id (duaility §12).
        vaultFor: (appId: string) => vaultRegistry.agentBridgeFor(appId),
        resolveConnection: connectionBroker.resolveForFire,
        runner: runnerPrefs?.kind ?? 'codex',
        triggerKind: opts.triggerKind,
        triggerOrigin: opts.triggerOrigin,
        ...(opts.input !== undefined ? { input: opts.input } : {}),
        ...(automationsModel ? { model: automationsModel } : {}),
        onRunEvent: (ev) => runEventBus.publish(runId, ev),
      });
      // Grant-matched outbox items the fire just staged drain now, not
      // on the next clock tick (issue #306 phase 3).
      drainOutbox(vaultRegistry.current());
      health.reportOk('automation-runs');
    })().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      // Failed before the ledger opened: close off the bus or the viewer hangs.
      runEventBus.publish(runId, { type: 'run.end', ok: false, error: message });
      health.reportError('automation-runs', `${opts.triggerKind} ${automationRef}: ${message}`);
      logger.warn(`${opts.triggerKind} ${automationRef} failed: ` + message);
    });
  };

  const settledHostFor = (vaultId: string): VaultHost => {
    const host = settledHosts.get(vaultId);
    if (!host) throw new Error(`gateway: vault ${vaultId} workspace not mounted yet`);
    return host;
  };

  /** The current request's vault's mounted host (sync — post-mount paths only). */
  const currentSettledHost = (): VaultHost => settledHostFor(vaultRegistry.current().boot.vaultId);

  /** The current request's vault's host bundle, mounting it on first touch. */
  const currentVaultHost = (): Promise<VaultHost> => hostFor(vaultRegistry.current());

  /**
   * Mount one vault's host bundle: build it, load its app registry into the
   * runtime (identity enrollment included), then settle its scheduler. The
   * whole mount runs inside the vault's ambient scope; cached by vault id,
   * so a vault created by the admin CLI mid-flight mounts on first request.
   */
  const hostFor = (plane: VaultPlane): Promise<VaultHost> => {
    const vaultId = plane.boot.vaultId;
    const cached = hosts.get(vaultId);
    if (cached) return cached;
    const built = runWithVaultContext({ vaultId }, async () => {
      const host = await buildHost(plane);
      await requireRuntime().bootstrap();
      for (const appId of await host.store.listApps()) {
        await requireRuntime().registry.ensureUploaded(appId);
        vaultRegistry.enrollApp(appId);
        await grantDeclaredAppScopes(plane, host.store, appId);
        const appDir = await host.store.resolveActiveAppDir(appId);
        if (appDir) await prewarmApp(appId, appDir);
      }
      // Installed bundled apps (issue #434) aren't in the git store, so the
      // loop above misses them — re-register each from the enrollment record
      // so it serves (from the shipped blueprint dir) after a gateway restart.
      for (const appId of plane.installedAppIds()) {
        await requireRuntime().registry.ensureUploaded(appId);
        await grantDeclaredBundledScopes(plane, appId);
        await prewarmApp(appId, bundledAppDir(appId));
      }
      settledHosts.set(vaultId, host);
      await reconcileScheduler(vaultId);
      return host;
    }).catch((err) => {
      // A failed mount must not poison the cache — drop it so the next
      // request retries (e.g. after a transient git failure).
      hosts.delete(vaultId);
      throw err;
    });
    hosts.set(vaultId, built);
    return built;
  };

  /** Re-sync one vault's registry off its live `main` (see BuiltGateway.syncApps). */
  const syncApps = async (vaultId?: string): Promise<void> => {
    const plane = vaultId ? vaultRegistry.get(vaultId) : vaultRegistry.current();
    if (!plane) throw new Error(`gateway: unknown vault "${vaultId}"`);
    const id = plane.boot.vaultId;
    const host = await hostFor(plane);
    await runWithVaultContext({ vaultId: id }, async () => {
      await requireRuntime().bootstrap();
      for (const appId of await host.store.listApps()) {
        await requireRuntime().registry.ensureUploaded(appId);
        vaultRegistry.enrollApp(appId);
        await grantDeclaredAppScopes(plane, host.store, appId);
      }
      for (const appId of plane.installedAppIds()) {
        await requireRuntime().registry.ensureUploaded(appId);
        await grantDeclaredBundledScopes(plane, appId);
      }
    });
    await reconcileScheduler(id);
  };

  // Drop an app from the registry AND delete its wrapper dir under the
  // request's vault (`<apps>/<id>/` — logs, settings, blobs), then run the
  // vault-side uninstall cascade (§11: revoke + retire enrollment — the
  // ext band is RETAINED there; the owner purges it separately, #286).
  const deregisterAndCleanup = async (appId: string): Promise<void> => {
    const removed = await requireRuntime().registry.deregister(appId);
    if (removed) await cleanupDeregisteredApp(currentWorkspace().appsDir, removed, logger);
    vaultRegistry.revokeApp(appId);
  };

  const requireRuntime = (): Runtime => {
    if (!runtimeRef) throw new Error('gateway: runtime not constructed yet');
    return runtimeRef;
  };

  async function buildHost(plane: VaultPlane): Promise<VaultHost> {
    const workspace = plane.workspace;
    const vaultId = workspace.vaultId;
    const store = new WorktreeStore({ root: plane.codeStoreRoot });
    await store.init();
    const codeAppsDir = (): string => path.join(store.getActiveMainLink(), 'apps');
    // The ext band (issue #286 phase 2): publish applies an app's declared
    // extension tables to THIS vault; drafts branch a scratch band there.
    const ext: ExtBandOps = {
      applyAppExt: (appId, tables) => plane.applyAppExt(appId, tables),
      seedAppExtDraft: (appId, tables, seedOpts) =>
        plane.gateway.seedAppExtDraft(plane.ownerCredential, appId, tables, seedOpts),
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
      subsystem: 'builder',
      getDispatcher,
      publicBaseUrl: () => serverUrl,
      ext,
      ...makeVaultToolRunners(vaultRegistry),
      ...(paths.modelCatalogFile ? { catalogPath: paths.modelCatalogFile } : {}),
      ...(options.sessionIdFor ? { sessionIdFor: options.sessionIdFor } : {}),
    });
    const lifecycleOpts: LifecycleRouteOptions = {
      store,
      codeAppsDir,
      ...(paths.templatesCacheDir ? { templatesCacheDir: paths.templatesCacheDir } : {}),
      ensureRegistered: async (appId) => {
        await requireRuntime().registry.ensureUploaded(appId);
        vaultRegistry.enrollApp(appId);
        await grantDeclaredAppScopes(plane, store, appId);
        invalidateToolCatalog();
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
      // Install a bundled blueprint in place (issue #434): enroll with
      // origin 'installed' + register + grant declared scopes, no git, no id
      // minting. Idempotent — an already-installed app returns its existing
      // registration. Returns undefined for a non-bundled id (→ 404).
      installBundledApp: async (templateId) => {
        if (!bundledAppIds.has(templateId)) return undefined;
        const meta = await readBundledAppMeta(bundledAppDir(templateId));
        const alreadyInstalled = plane.installedAppIds().has(templateId);
        plane.installApp(templateId, meta.name);
        await requireRuntime().registry.ensureUploaded(templateId);
        await grantDeclaredBundledScopes(plane, templateId);
        await prewarmApp(templateId, bundledAppDir(templateId));
        invalidateToolCatalog();
        return {
          id: templateId,
          ...(meta.name !== undefined ? { name: meta.name } : {}),
          ...(meta.description !== undefined ? { description: meta.description } : {}),
          ...(meta.iconKey !== undefined ? { iconKey: meta.iconKey } : {}),
          ...(meta.colorKey !== undefined ? { colorKey: meta.colorKey } : {}),
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
        invalidateToolCatalog();
        return true;
      },
      ext,
      compileAutomation: ({ automationRef, runId, enableOnSuccess }) => {
        const parsed = automation.parseRef(automationRef);
        if (!parsed) return;
        void (async () => {
          const row = await automation.readAppOwned(
            codeAppsDir(),
            parsed.appId,
            parsed.automationId,
          );
          if (!row) return;
          const enabledBeforeCompile = row.enabled;
          // Compiles are one-shot drafts. Reusing the interactive chat/edit
          // worktree lets a failed publish leave a rebase in progress, which
          // then poisons a later retry (and can conflict with UI edits).
          // The compile run id is already unique; its final UUID segment is
          // safe for WorktreeStore session ids.
          const runSuffix = runId.split(':').at(-1) ?? crypto.randomUUID().slice(0, 8);
          const sessionId = `compile-${parsed.appId}-${runSuffix}`;
          await runHeadlessAutomationCompile({
            runner,
            journalDbFile: workspace.journalDbFile,
            runnerSessionDir: workspace.runnerSessionDir,
            dataDir: workspace.appsDir,
            appId: parsed.appId,
            draftSessionId: sessionId,
            automationRef,
            automationName: row.name,
            instructions: row.manifest.prompt,
            runId,
            onSuccess: async () => {
              const appDir = await store.snapshotSessionAppDir(sessionId, parsed.appId);
              const manifestFile = path.join(
                appDir,
                'automations',
                parsed.automationId,
                automation.MANIFEST_FILE,
              );
              const manifest = automation.parseManifest(await fs.readFile(manifestFile, 'utf8'));
              const compiled = finalizeCompiledManifest(manifest, {
                enabledBeforeCompile,
                enableOnSuccess,
              });
              await fs.writeFile(manifestFile, `${JSON.stringify(compiled, null, 2)}\n`);
              await publishAndReconcile(lifecycleOpts, {
                appId: parsed.appId,
                sessionId,
                appDir,
                message: `compile ${parsed.automationId}`,
                ephemeralSession: true,
              });
              health.reportOk('automation-runs', `Plan ready for ${row.name}`);
            },
            onFailure: async (error) => {
              health.reportError(
                'automation-runs',
                `Compile failed for ${row.name}: ${error}. Retry from the automation thread.`,
              );
              logger.warn?.(`Headless compile failed for ${automationRef}: ${error}`);
              // Discard a failed compile's isolated branch. This also
              // clears any interrupted rebase before the user retries.
              await store.closeSession(sessionId).catch(() => undefined);
              if (row.manifest.onFailure) {
                const target = automation.parseRef(row.manifest.onFailure, parsed.appId);
                if (target) {
                  fireAutomation(`${target.appId}/${target.automationId}`, {
                    triggerKind: 'on_failure',
                    triggerOrigin: 'manual',
                    input: {
                      automationRef,
                      compileRunId: runId,
                      error,
                      phase: 'compile',
                    },
                  });
                }
              }
            },
          });
        })();
      },
    };

    const handlers: RouteHandler[] = [
      makeAppsStoreRouteHandler(store, {
        onAppLive: async (appId) => {
          await requireRuntime().registry.ensureUploaded(appId);
          vaultRegistry.enrollApp(appId);
          await grantDeclaredAppScopes(plane, store, appId);
          // A publish/rollback may have added/removed/toggled an
          // automation — resync THIS vault's cron scheduler off the new `main`.
          await reconcileScheduler(vaultId);
          invalidateToolCatalog();
        },
        onAppDeleted: async (appId) => {
          await deregisterAndCleanup(appId);
          await reconcileScheduler(vaultId);
          invalidateToolCatalog();
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
                ...(meta.description !== undefined ? { description: meta.description } : {}),
                kind: 'app' as const,
                hasIndex: meta.hasIndex,
                ...(meta.iconKey !== undefined ? { iconKey: meta.iconKey } : {}),
                ...(meta.colorKey !== undefined ? { colorKey: meta.colorKey } : {}),
              };
            }),
          ),
        ext,
      }),
      // App lifecycle over HTTP (issue #141, Phase 2): the gateway owns
      // scaffold / clone / update-meta / automation create+toggle+delete.
      makeLifecycleRouteHandler(lifecycleOpts),
      // Automation runtime ops over HTTP (issue #141): list/read/run-now,
      // the run feed + per-run detail, and insights — all over THIS
      // vault's conversation ledger (the journal.db ledger band).
      makeAutomationsRouteHandler({
        store,
        journalDbFile: workspace.journalDbFile,
        analytics: analyticsStore,
        insights: insightsStore,
        runAutomation: ({ automationRef, runId }) =>
          fireAutomation(automationRef, {
            runId,
            triggerKind: 'manual',
            triggerOrigin: 'manual',
          }),
        subscribeRunEvents: (runId, listener) => runEventBus.subscribe(runId, listener),
      }),
    ];

    return {
      vaultId,
      store,
      codeAppsDir,
      draftCodeDir,
      runner,
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
  const reconcileStates = new Map<string, { inFlight?: Promise<void>; dirty: boolean }>();
  let schedulersStarted = false;

  const schedulerFor = (vaultId: string): automation.LocalScheduler => {
    const existing = schedulers.get(vaultId);
    if (existing) return existing;
    const created: automation.LocalScheduler =
      options.scheduler && schedulers.size === 0 && vaultId === vaultRegistry.defaultVaultId()
        ? options.scheduler
        : new automation.InProcessScheduler({
            fire: (ref) =>
              runWithVaultContext({ vaultId }, () =>
                fireAutomation(ref, { triggerKind: 'scheduled', triggerOrigin: 'cron' }),
              ),
            evaluate: (ref, triggerIndex) =>
              runWithVaultContext({ vaultId }, () => evaluateCondition(ref, triggerIndex)),
            onError: (err, ref) => {
              const message =
                `scheduled ${ref} failed: ` + (err instanceof Error ? err.message : String(err));
              health.reportError('automation-runs', message);
              logger.warn(message);
            },
            // Missed-run ledger (issue #351 tier 2): every processed minute,
            // before any fire, compare the persisted `lastTickAt` against
            // `at` — a gap wide enough to be a real outage gets ONE recorded
            // entry per enabled cron automation (earliest missed fire),
            // never a retro-execution (see scheduler-ledger.ts). Runs inside
            // this vault's scope so `automation.list` resolves its `main`.
            onTick: (at) => {
              void runWithVaultContext({ vaultId }, async () => {
                const { rows } = await automation.list(settledHostFor(vaultId).codeAppsDir());
                const missed = automation.recordSchedulerTick({
                  ledger: schedulerLedgerFor(vaultId),
                  now: at,
                  automations: rows,
                });
                if (missed.length > 0) {
                  const latest = missed[missed.length - 1]!;
                  health.reportDegraded(
                    'automation-runs',
                    `${missed.length} automation${missed.length === 1 ? '' : 's'} missed a ` +
                      `scheduled fire during downtime (vault ${vaultId}) — latest ` +
                      `${latest.automationRef} scheduled for ${latest.scheduledFor}`,
                  );
                  logger.warn(
                    `scheduler (vault ${vaultId}): recorded ${missed.length} missed window(s) ` +
                      'after a gap — recorded, not retro-executed',
                  );
                }
              }).catch((err) => {
                logger.warn(
                  `scheduler ledger tick (vault ${vaultId}) failed: ` +
                    (err instanceof Error ? err.message : String(err)),
                );
              });
            },
            onDormancyChange: (dormant, at) =>
              runWithVaultContext({ vaultId }, () => {
                schedulerLedgerFor(vaultId).setDormant(dormant, at);
              }),
          });
    schedulers.set(vaultId, created);
    if (schedulersStarted) created.start();
    return created;
  };

  provenanceDoorbell = (vaultId, entityTypes) => {
    runWithVaultContext({ vaultId }, () => schedulers.get(vaultId)?.nudge(entityTypes));
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
      do {
        settled.dirty = false;
        const { rows } = await automation.list(settledHostFor(vaultId).codeAppsDir());
        // Every automation app acts through an enrolled agent.agent (duaility
        // §12) — enroll identities in THIS vault as the desired set settles,
        // and grant each automation's DECLARED scopes at the same moment
        // (issue #306 decision 2: installing was the consent).
        const plane = vaultRegistry.get(vaultId);
        const nameByOwnerApp = new Map(rows.map((r) => [r.ownerApp, r.name]));
        for (const appId of new Set(rows.map((r) => r.ownerApp))) {
          try {
            vaultRegistry.enrollAutomationAgent(appId, nameByOwnerApp.get(appId));
          } catch (err) {
            logger.warn(
              `vault plane: agent enrollment for "${appId}" failed: ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
        }
        for (const row of rows) {
          const block = manifestScopeBlock(row.manifest.vault);
          if (!block || !plane) continue;
          try {
            plane.ensureAgentInstallGrant(row.ownerApp, block);
          } catch (err) {
            logger.warn(
              `install-time grant for automation "${row.ownerApp}" failed: ` +
                (err instanceof Error ? err.message : String(err)),
            );
          }
        }
        const diff = await sched.reconcile(rows);
        if (diff.added.length || diff.updated.length || diff.removed.length) {
          logger.info(
            `scheduler reconcile (vault ${vaultId}) — ` +
              `added=${diff.added.length} updated=${diff.updated.length} removed=${diff.removed.length}`,
          );
        }
      } while (settled.dirty);
    });
    settled.inFlight = work
      .then(() =>
        health.reportOk(
          'automations',
          `scheduler${schedulers.size === 1 ? '' : 's'} running for ${schedulers.size} vault${schedulers.size === 1 ? '' : 's'}`,
        ),
      )
      .catch((err) => {
        const message =
          `scheduler reconcile failed: ` + (err instanceof Error ? err.message : String(err));
        health.reportError('automations', message);
        logger.warn(message);
        throw err;
      })
      .finally(() => {
        settled.inFlight = undefined;
      });
    return settled.inFlight;
  };

  // Condition-trigger evaluation (duaility: time semantics live in the
  // data). On the trigger's `every` gate, run its consented read under the
  // automation's agent grant; unseen rows fire the automation with the
  // rows as `ctx.input`. A receipted deny or bridge error logs and skips —
  // failure never widens access and never stalls the tick. Runs inside the
  // vault scope its scheduler established.
  const evaluateCondition = async (ref: string, triggerIndex: number): Promise<void> => {
    const parsed = automation.parseRef(ref);
    if (!parsed) return;
    const row = await automation.readAppOwned(
      currentSettledHost().codeAppsDir(),
      parsed.appId,
      parsed.automationId,
    );
    if (!row || !row.enabled || !row.manifest.vault) return;
    const trigger = row.manifest.triggers[triggerIndex];
    if (!trigger) return;
    const purpose = row.manifest.vault.purpose;
    const vault = vaultRegistry.agentBridgeFor(parsed.appId);
    const journalDbFile = currentWorkspace().journalDbFile;
    if (trigger.kind === 'condition') {
      const evaluation = await automation.evaluateConditionTrigger({
        automationRef: ref,
        trigger,
        triggerIndex,
        purpose,
        journalDbFile,
        vault,
      });
      if (evaluation.reason) {
        logger.warn(`condition trigger ${ref}[${triggerIndex}] skipped: ${evaluation.reason}`);
        return;
      }
      if (!evaluation.fire) return;
      fireAutomation(ref, {
        triggerKind: 'scheduled',
        triggerOrigin: 'condition',
        input: {
          trigger: { kind: 'condition', index: triggerIndex, entity: trigger.entity },
          rows: evaluation.rows,
          matched: evaluation.matched,
        },
      });
      return;
    }
    if (trigger.kind === 'data') {
      const evaluation = await automation.evaluateDataTrigger({
        automationRef: ref,
        trigger,
        triggerIndex,
        purpose,
        journalDbFile,
        vault,
      });
      if (evaluation.reason) {
        // Reconcile uses this same evaluator to establish a fresh watcher's
        // no-history cursor. A soft "skip" there would let publish report
        // ready without a cursor and make the first real write become the
        // bootstrap (and therefore not fire). Reject instead: reconcile
        // propagates readiness failure, while minute/nudge callers route it
        // through the scheduler's fire-and-forget onError path.
        throw new Error(`data trigger ${ref}[${triggerIndex}] failed: ${evaluation.reason}`);
      }
      if (!evaluation.fire) return;
      fireAutomation(ref, {
        triggerKind: 'scheduled',
        triggerOrigin: 'data',
        input: {
          trigger: { kind: 'data', index: triggerIndex, entities: trigger.entities },
          changes: evaluation.changes,
        },
      });
    }
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
  // already does (auth, rate limit, in-flight guard, body cap, response
  // shape) is reimplemented here.
  const webhookHandlers = new Map<string, RouteHandler>();

  /**
   * Blocking automation fire for the webhook route — unlike the
   * fire-and-forget `fireAutomation` the scheduler/manual-run routes use
   * (which streams progress over the SSE bus and returns immediately), a
   * webhook POST awaits the run to completion and answers with its outcome,
   * matching the contract `makeWebhookRouteHandler` expects from its `fire`
   * callback.
   */
  const webhookFire = async (
    vaultId: string,
    automationRef: string,
    body: unknown,
  ): Promise<automation.WebhookFireResult> => {
    const plane = vaultRegistry.get(vaultId);
    if (!plane) return { ok: false, error: `unknown vault "${vaultId}"` };
    const host = settledHostFor(vaultId);
    const runId = `${automationRef}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
    const runnerPrefs = await prefsLoader('automations');
    // Prefs fallback for `ctx.agent` calls — the automation's own
    // `requires.model` (read inside `runFire`) still wins over this.
    const automationsModel = await resolveModel('automations');
    try {
      const { outcome } = await runWithVaultContext({ vaultId }, () =>
        runAutomation({
          automationRef,
          runId,
          appsDir: plane.workspace.appsDir,
          journalDbFile: plane.workspace.journalDbFile,
          codeAppsDir: host.codeAppsDir(),
          // Each fire's ctx.vault rides the automation's enrolled
          // agent.agent credential, resolved per app id (duaility §12) —
          // same as the default local fire path above.
          vaultFor: (appId: string) => vaultRegistry.agentBridgeFor(appId),
          resolveConnection: connectionBroker.resolveForFire,
          runner: runnerPrefs?.kind ?? 'codex',
          triggerKind: 'scheduled',
          triggerOrigin: 'webhook',
          ...(body !== undefined ? { input: body } : {}),
          ...(automationsModel ? { model: automationsModel } : {}),
          onRunEvent: (ev) => runEventBus.publish(runId, ev),
        }),
      );
      // Grant-matched outbox items the fire just staged drain now (issue
      // #306 phase 3), same as the default local fire path.
      drainOutbox(plane);
      // Health parity with `fireAutomation` (issue #351 tier 2): a
      // webhook-triggered fire used to bypass `automation-runs` entirely —
      // a connector wired to a broken webhook could fail silently forever.
      // This mirrors `fireAutomation`'s semantics exactly: `reportOk` means
      // the FIRE PIPELINE ran (not that the automation's own outcome was
      // ok — a failing handler still reports pipeline-ok here); only an
      // exception firing the run at all (caught below) flips it to error.
      health.reportOk('automation-runs');
      return { ok: outcome.ok, runId, ...(outcome.error ? { error: outcome.error } : {}) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      health.reportError('automation-runs', `webhook ${automationRef}: ${message}`);
      runEventBus.publish(runId, { type: 'run.end', ok: false, error: message });
      return { ok: false, runId, error: message };
    }
  };

  const webhookHandlerForVault = (vaultId: string): RouteHandler => {
    const existing = webhookHandlers.get(vaultId);
    if (existing) return existing;
    const handler = automation.makeWebhookRouteHandler({
      appsDir: settledHostFor(vaultId).codeAppsDir(),
      fire: ({ automationRef, body }) => webhookFire(vaultId, automationRef, body),
    });
    webhookHandlers.set(vaultId, handler);
    return handler;
  };

  const webhookHandler: RouteHandler = async (req, res) => {
    if (!req.url || !req.url.startsWith(automation.WEBHOOK_ROUTE_PREFIX)) return false;
    const url = new URL(req.url, 'http://x');
    const slug = url.pathname
      .slice(automation.WEBHOOK_ROUTE_PREFIX.length)
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    // Mirror `makeWebhookRouteHandler`'s own POST + slug-shape gate so a
    // malformed request short-circuits to the default vault's 404/405
    // without paying for a scan across every vault.
    const isPost = (req.method ?? 'GET').toUpperCase() === 'POST';
    const looksLikeSlug = /^[A-Za-z0-9_-]+$/.test(slug);
    let targetVaultId = vaultRegistry.defaultVaultId();
    if (isPost && looksLikeSlug) {
      for (const plane of vaultRegistry.planesList()) {
        const vaultId = plane.boot.vaultId;
        const host = settledHosts.get(vaultId);
        if (!host) continue; // not yet mounted — nothing to match there
        const { rows } = await automation.list(host.codeAppsDir());
        if (rows.some((r) => automation.webhookTriggerOf(r.triggers)?.id === slug)) {
          targetVaultId = vaultId;
          break;
        }
      }
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
    // Shared kit assets (kit.js / kit.css) are served from the blueprints
    // package's canonical `kit/` dir; apps no longer ship per-app copies.
    sharedAssetsDir: KIT_DIR,
    userStore: prefs,
    conversationHistoryStore,
    conversationRunner: {
      // Facade over the request vault's unified runner (#280) — builder-
      // capable, so turns persist as `kind='build'` (issue #181). EVERY
      // ask turn rides the vault register (issue #286 phase 2: the vault
      // is the only store) — the owner assistant wearing the app lens.
      runKind: 'build',
      run: async (input) => {
        // Model prefs plumbing: an explicit `input.model` (the `_turn` POST
        // body) always wins; otherwise resolve off the register — `ask` is
        // the per-app copilot, anything else (including unset) is the
        // builder chat.
        //
        // The two runners below are built once at boot, but neither PICKS a
        // runner kind at construction: each carries only its subsystem tag
        // and calls `prefsLoader(subsystem)` inside every turn. So the same
        // `input.register` fork that names the subsystem here also lands on
        // a runner that resolves `runner.<subsystem>` fresh — the model key
        // and the backend that receives it can't disagree, and a re-pin
        // takes effect on the next turn with no restart.
        const subsystem: ModelSubsystem = input.register === 'ask' ? 'ask' : 'builder';
        const model = await resolveModel(subsystem, input.model);
        const resolvedInput = model !== input.model ? { ...input, model } : input;
        if (input.register === 'ask') return askRunner.run(resolvedInput);
        return (await currentVaultHost()).runner.run(resolvedInput);
      },
    },
    conversationRunnerSessionDir: () => currentWorkspace().runnerSessionDir,
    runnerStatus: async (statusOpts) => {
      const runnerPrefs = await prefsLoader();
      if (!runnerPrefs) {
        return {
          kind: 'none' as const,
          ok: false,
          reason: 'No coding agent configured.',
          hint: 'Open Settings → Agents and pick Codex or Claude Code.',
        };
      }
      // The model list is a pure catalog read; enumeration is owned by the
      // warmer. A Refresh (or a cold cache) kicks a warm fire-and-forget and
      // the client polls `modelsStatus` until it leaves `loading`.
      const status = await runPreflight(runnerPrefs, catalogPath ? { catalogPath } : {});
      if (catalogPath && warmer && status.ok) {
        const count = status.models?.length ?? 0;
        if ((statusOpts?.refresh ?? false) || count === 0)
          void warmer.warm(runnerPrefs.kind, 'models');
        status.modelsStatus = deriveStatus(count, warmer.isWarming(runnerPrefs.kind, 'models'));
      }
      return status;
    },
    logger,
    // Resolver rule (issue #434): a bundled blueprint app installed in the
    // request's vault serves in place from the shipped @centraid/blueprints
    // package (upgrades with every release, no per-vault copy). Everything
    // else — code the gateway can't otherwise get: compiled automations,
    // future builder forks/downloads — resolves to the git code-store
    // worktree, as before. The installed check is per-vault so a legacy
    // snapshot-cloned app keeps serving from the store. The app-engine
    // static-path sandbox applies identically to whichever dir is returned.
    codeDirOverride: async (appId: string) => {
      if (bundledAppIds.has(appId) && vaultRegistry.current().installedAppIds().has(appId)) {
        return bundledAppDir(appId);
      }
      return (await currentVaultHost()).store.resolveActiveAppDir(appId);
    },
    draftCodeDir: async (appId: string, sessionId: string) =>
      (await currentVaultHost()).draftCodeDir(appId, sessionId),
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
    subsystem: 'assistant',
    getDispatcher,
    vaults: vaultRegistry,
  });

  // LLM auto-title (issue #420, Wave 3): after the first turn of a new
  // assistant thread settles, a cheap one-shot inference names it — the
  // claude.ai affordance that beats first-message truncation. Fire-and-forget:
  // this closure returns void immediately and self-schedules; any failure is
  // swallowed so a title miss never touches the turn. Provider-agnostic — the
  // titler runs at the `fast` capability TIER (never a hardcoded model id;
  // governance no-hardcoded-model-ids), overridable per runner via the
  // `model.<runnerKind>.title` prefs slot. "User rename wins": the generated
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
        const runnerPrefs = await prefsLoader();
        if (!runnerPrefs) return;
        const slot = prefs.getAllPrefs()[`model.${runnerPrefs.kind}.title`];
        const configured = typeof slot === 'string' && slot.length > 0 ? slot : undefined;
        // The `fast` tier is only meaningful on runners that understand the
        // tier vocabulary (claude-code); on codex a bare tier token would be
        // sent verbatim, so skip unless the owner configured an explicit slot.
        if (!configured && runnerPrefs.kind !== 'claude-code') return;
        const title = await generateConversationTitle({
          runTurn,
          runnerPrefs,
          cwd: assistantCwd(vaultRegistry),
          model: configured ?? 'fast',
          userMessage: args.userMessage,
          assistantText: args.assistantText,
          timeoutMs: 20_000,
        });
        if (!title) return;
        // Apply only if the thread still carries the derived truncation — a
        // manual rename between record and generation wins.
        const meta = conversationHistoryStore.getSessionMeta(ASSISTANT_APP_ID, args.conversationId);
        if (!meta || meta.title !== deriveTitle(args.userMessage)) return;
        conversationHistoryStore.renameSession(ASSISTANT_APP_ID, args.conversationId, title);
      } catch {
        /* fire-and-forget — a title miss never affects the turn */
      }
    })();
  };

  // Ask-register lens metadata (issue #286 phase 2): the app copilot's
  // `register: 'ask'` turns ARE the owner assistant wearing the app lens —
  // name + description bias the prompt, never a permission boundary.
  // Resolved per turn off the live `main` manifest so a publish lands
  // without a restart.
  const askAppMeta = async (appId: string): Promise<{ name?: string; description?: string }> => {
    try {
      const host = await currentVaultHost();
      const dir = await host.store.resolveActiveAppDir(appId);
      if (!dir) return {};
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'app.json'), 'utf8')) as {
        name?: unknown;
        description?: unknown;
      };
      return {
        ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
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
    subsystem: 'ask',
    getDispatcher,
    vaults: vaultRegistry,
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
      config: { paths, backup: options.backup, deviceAccessEnabled: Boolean(options.deviceAccess) },
    });

  // ── Route chain ───────────────────────────────────────────────────────
  const routeEntries: RoutePrefixRegistration[] = [
    forRoutePrefixes(['/centraid/_web', '/centraid/_apps'], webAppSessions.handler),
    // Gateway identity + version handshake (issue #289): cheap static
    // JSON, mounted first — health polling hits it every few seconds.
    forRoutePrefixes(
      '/centraid/_gateway/info',
      makeGatewayInfoRouteHandler({ instanceId: instanceLease.instanceId }),
    ),
    ...(options.dataPlaneControl
      ? [
          forRoutePrefixes(
            '/centraid/_gateway/tunnel',
            makeDataPlaneControlHandler(options.dataPlaneControl),
          ),
        ]
      : []),
    // HTTP ticket redemption (issue #376): the direct-transport twin of
    // the iroh `gw-pair` ceremony. Mounted only when the daemon wired its
    // device-pairing stores; `serve.ts` marks its path bearer-free. A
    // no-op passthrough (`return false`) on every other host.
    ...(options.devicePairing
      ? [
          forRoutePrefixes(
            '/centraid/_gateway/pair',
            makePairRouteHandler({
              vaults: vaultRegistry,
              tickets: options.devicePairing.tickets,
              enrollments: options.devicePairing.enrollments,
              deviceTokens: options.devicePairing.deviceTokens,
            }),
          ),
          // Paired-device roster + revoke (issue #376): the wire twin of
          // `cli/device-admin.ts`'s list/revoke, scoped to the caller's plane
          // (device caller sees only its vaults; admin sees all). Mounted only
          // when the daemon wired its device-pairing stores.
          forRoutePrefixes(
            '/centraid/_gateway/devices',
            makeDevicesRouteHandler({
              enrollments: options.devicePairing.enrollments,
              deviceTokens: options.devicePairing.deviceTokens,
              tickets: options.devicePairing.tickets,
              endpointTicket: options.devicePairing.endpointTicket,
              onEndpointRevoked: options.devicePairing.onEndpointRevoked,
              vaultName: (id) => vaultRegistry.get(id)?.name,
              onRevoked: (rows) => {
                for (const row of rows) {
                  const plane = vaultRegistry.get(row.vaultId);
                  plane?.forgetReplicaDevice(row.endpointId);
                  plane?.db.blobTransfers.revokePairedDevice(row.endpointId);
                }
              },
            }),
          ),
          forRoutePrefixes(
            '/centraid/_gateway/device-work',
            makeDeviceWorkRouteHandler({
              vaults: vaultRegistry,
              enrollments: options.devicePairing.enrollments,
            }),
          ),
        ]
      : []),
    // Component-level health + structured error tail. `_gateway/info`
    // is the liveness probe; this is the "what's actually wrong" surface.
    forRoutePrefixes('/centraid/_gateway/health', makeHealthRouteHandler(health)),
    // A single JSON document a user can save + hand to support: version,
    // health snapshot, log tail, vault sizes, and a redacted config
    // summary. Mounted right after health — same bearer gate, same
    // "owner-facing diagnostics" family.
    forRoutePrefixes(
      '/centraid/_gateway/diagnostics',
      makeDiagnosticsRouteHandler(buildDiagnostics),
    ),
    // Backup status + manual "run now" (issue #351): thin wiring over
    // `BackupService`. `backupService` is `undefined` when
    // `options.backup?.enabled` is false — the handler answers
    // `{configured: false}` rather than 404 in that case. Same bearer
    // gate, same owner-facing-diagnostics family as health/diagnostics.
    forRoutePrefixes(
      '/centraid/_gateway/backup',
      makeBackupRouteHandler({
        vaults: vaultRegistry,
        recoveryKitStore: recoveryKit,
        backupService,
      }),
    ),
    // Gateway-level storage connections (issue #367 §C1): CRUD + real
    // connectivity probe + per-vault replication status. Same bearer gate,
    // same owner-facing-diagnostics family as backup/health.
    forRoutePrefixes(
      '/centraid/_gateway/storage',
      makeStorageRouteHandler({
        storageConnections,
        recoveryKit,
        vaults: vaultRegistry,
        storageUsage,
        onConnectionsChanged: async () => {
          walCaptureConfigured =
            options.backup?.enabled === true || (await storageConnections.list()).length > 0;
          for (const plane of vaultRegistry.planesList()) plane.rescheduleWalCapture();
          await backupService.refreshWalSchedule();
        },
      }),
    ),
    // Due task/event reminders, computed live — the desktop main process
    // polls this to fire OS notifications (issue: Tasks/Agenda comparison
    // flagged "no time-based alerts, anywhere").
    forRoutePrefixes('/centraid/_reminders', makeRemindersRouteHandler(vaultRegistry)),
    // Realtime gateway logs (JSON tail + SSE) — the diagnostics surface
    // the desktop's Settings → Logs screen streams from.
    forRoutePrefixes('/centraid/_logs', makeLogsRouteHandler(logStore)),
    // The assistant's `_turn`/`resolve` surface — mounted BEFORE the
    // generic `_vault` handler, which answers 404 for any sub-route it
    // doesn't know (same prefix family).
    forRoutePrefixes(
      '/centraid/_vault/assistant',
      makeAssistantRouteHandler({
        vaults: vaultRegistry,
        conversationStore: conversationHistoryStore,
        runner: assistantRunner,
        conversationLocks: new Map(),
        resolveModel,
        generateTitle: generateAssistantTitle,
        limiter: turnLimiterForCurrentVault,
      }),
    ),
    // Scenario seeds (issue #290 phase 1): load/reset an app's demo data.
    // Mounted BEFORE the generic `_vault` handler (same prefix family).
    forRoutePrefixes(
      '/centraid/_vault/demo',
      makeDemoRouteHandler(vaultRegistry, {
        codeAppsDir: () => currentSettledHost().codeAppsDir(),
      }),
    ),
    // File-drop imports (issue #290 phase 2): stage → review → publish.
    forRoutePrefixes('/centraid/_vault/imports', makeImportRouteHandler(vaultRegistry)),
    // Blob custody (issue #296): staged uploads in, consent-checked +
    // Range-capable bytes out. Mounted BEFORE the generic `_vault`
    // handler (same prefix family).
    forRoutePrefixes(
      '/centraid/_vault/blobs',
      makeBlobRouteHandler(vaultRegistry, options.dataPlaneHttp),
    ),
    // Broker-carried connection credentials (issue #304): health list,
    // configure, pause/resume, and the PKCE consent ceremony. Mounted
    // BEFORE the generic `_vault` handler (same prefix family).
    forRoutePrefixes(
      ['/centraid/_vault/connections', '/centraid/_vault/oauth/callback'],
      makeConnectionsRouteHandler(vaultRegistry, connectionBroker, {
        onConnectionChanged: invalidateToolCatalog,
      }),
    ),
    // Consent-derived offline replica protocol (#406). Mounted before the
    // generic owner `_vault` handler because both share that prefix. The
    // intent lane executes through the ordinary app dispatcher; the route
    // only adds durable device-scoped admission/dedupe around it.
    forRoutePrefixes(
      ['/centraid/_vault/replica', '/centraid/_vault/changes'],
      makeReplicaRouteHandler(vaultRegistry, {
        ...(options.devicePairing ? { enrollments: options.devicePairing.enrollments } : {}),
        dispatchIntent: async (input) =>
          replicaDispatchOutcome(
            await getDispatcher().write({
              app: input.appId,
              action: input.action,
              input: input.input,
              intentId: input.intentId,
            }),
          ),
      }),
    ),
    // Owner consent surface for the vault plane (grants, parked
    // confirmations, rename/presentation). Its `_vault` prefix
    // is disjoint from every other route family. Vault create/delete are
    // ADMIN acts (server CLI) — they no longer ride HTTP (#289).
    forRoutePrefixes(
      '/centraid/_vault',
      makeVaultRouteHandler(vaultRegistry, {
        ...(options.deviceAccess ? { deviceAccess: options.deviceAccess } : {}),
        onOutboxDecided: drainOutbox,
        // Storage-connection attach flow (issue #367 §C1/§C4/§C10): resolves
        // `blob_store.connectionId` and gates on the recovery-kit nudge.
        storageConnections,
        recoveryKit,
        // fix (this session): agent-grant approval can be the FIRST enrollment
        // touch for an automation's agent — resolve its real manifest name
        // the same way reconcileScheduler does, so `approveAgentGrant` never
        // has to fall back to a bare id-derived name.
        resolveAutomationName: async (appId) => {
          const { rows } = await automation.list(currentSettledHost().codeAppsDir());
          return rows.find((r) => r.ownerApp === appId)?.name;
        },
      }),
    ),
    // Template catalog (issue #141): the gateway owns it, so the renderer
    // reads `GET /centraid/_templates` directly. Templates are SEEDS —
    // gateway-level, read-only material instantiated INTO a vault (#280).
    forRoutePrefixes(
      '/centraid/_templates',
      makeTemplatesRouteHandler({
        ...(paths.templatesCacheDir ? { cacheDir: paths.templatesCacheDir } : {}),
        // Remote template fetch is deferred for v1 (issue #434, Phase 4): the
        // catalog serves only the shipped @centraid/blueprints. Remote install
        // is the one case where install legitimately copies (a download), so
        // the `remoteTemplatesUrl` refresh wiring is intentionally NOT passed
        // here — the mechanism stays in makeTemplatesRouteHandler and returns
        // when the remote/third-party app catalog is designed.
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
      }),
    ),
    // Coding-agent detection (codex/claude credentials on the gateway host).
    forRoutePrefixes(
      '/centraid/_agents',
      makeAgentsRouteHandler(
        catalogPath
          ? {
              ...(resolveCatalogModels ? { resolveModels: resolveCatalogModels } : {}),
              ...(resolveCatalogTools ? { resolveTools: resolveCatalogTools } : {}),
            }
          : {},
      ),
    ),
    // The request vault's store-backed handlers (apps-store / lifecycle /
    // automations), resolved per request off the ambient vault scope.
    forRoutePrefixes(
      ['/centraid/_apps', '/centraid/_automations', '/centraid/_insights'],
      async (req, res) => {
        const host = await currentVaultHost();
        for (const handler of host.handlers) {
          if (await handler(req, res)) return true;
        }
        return false;
      },
    ),
  ];

  // `composedHandler` owns the whole request: resolve the vault the request
  // is addressed to (#289), then replay the chain `startRuntimeHttpServer`
  // used to run — chat-history → prefs → extra handlers → `runtime.handle`
  // — inside that vault's ambient scope. WITHOUT the bearer check, for
  // hosts that own auth themselves. CORS is the host's job too: a fronting
  // gateway emits its own.
  const conversationHandler = makeConversationRouteHandler(() => conversationHistoryStore);
  const userStoreHandler = makeUserStoreRouteHandler(
    () => prefs,
    () => currentWorkspace().ownerPartyId,
  );
  const prefixDispatch = createRoutePrefixDispatch([
    forRoutePrefixes(CONVERSATIONS_PREFIX, conversationHandler),
    forRoutePrefixes(USER_STORE_PREFIX, userStoreHandler),
    ...routeEntries,
  ]);
  // Retain the public BuiltGateway seam as a one-entry compiled dispatcher;
  // callers never receive or linearly walk the underlying route registry.
  const extraHandlers: RouteHandler[] = [prefixDispatch];
  const dispatchChain: RouteHandler = async (req, res) => {
    if (await prefixDispatch(req, res)) return true;
    await runtime.handle(req, res);
    return true;
  };

  const composedHandler: RouteHandler = async (req, res) => {
    // Resolve the request's vault (issue #289): the device's enrollment set
    // scopes what it may address; the header picks within it. No header →
    // the device's sole enrollment; the ADMIN plane (the shared landlord
    // token — loopback embed, or the daemon bearer with no per-device
    // token, issue #376) carries no device key and is implicitly enrolled
    // in every vault, defaulting to the oldest. The server never persists
    // a pointer.
    //
    // Device-key resolution has two sources, tried in order: the iroh
    // endpoint-host's per-boot proof headers (`deviceAccess.deviceKeyFor`,
    // trusted because only that in-process forwarder can stamp them), else
    // the HTTP listener's own `AUTHED_DEVICE_HEADER` — stamped by
    // `startRuntimeHttpServer`'s pluggable `authorizeBearer` AFTER it
    // verifies the presented bearer names a per-device HTTP token (issue
    // #376). Both headers are deleted from the client-supplied request
    // before either can be trusted — a bearer-holder can never forge a
    // device identity for itself.
    // This header is authoritative only when stamped below from the proved
    // enrollment. A client-provided copy may restrict itself but can never
    // widen access, so discard it before device resolution.
    delete req.headers[COMPANION_GRANTS_HEADER];
    const rawHeader = req.headers[VAULT_HEADER];
    const requested = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const authedHeader = req.headers[AUTHED_DEVICE_HEADER];
    const authedDeviceKey =
      typeof authedHeader === 'string' && authedHeader.length > 0 ? authedHeader : undefined;
    const deviceKey = options.deviceAccess?.deviceKeyFor(req) ?? authedDeviceKey;
    let vaultId: string;
    if (deviceKey !== undefined) {
      const enrolled = options.deviceAccess?.vaultsFor(deviceKey) ?? [];
      if (enrolled.length === 0) {
        return sendJson(res, 403, {
          error: 'device_not_enrolled',
          message: 'this device is not enrolled in any vault on this gateway',
        });
      }
      if (requested !== undefined && !enrolled.includes(requested)) {
        return sendJson(res, 403, {
          error: 'vault_not_enrolled',
          message: 'this device is not enrolled in the requested vault',
        });
      }
      vaultId = requested ?? enrolled[0]!;
    } else if (requested !== undefined) {
      vaultId = requested;
    } else {
      vaultId = vaultRegistry.defaultVaultId();
    }
    if (!vaultRegistry.get(vaultId)) {
      return sendJson(res, 404, {
        error: 'vault_not_found',
        message: `unknown vault "${vaultId}"`,
      });
    }
    const enrollment =
      deviceKey !== undefined
        ? options.devicePairing?.enrollments.get(deviceKey, vaultId)
        : undefined;
    if (enrollment?.trust === 'readonly' && !readonlyRequestAllowed(req)) {
      return sendJson(res, 403, {
        error: 'readonly_device',
        message: 'this device is enrolled read-only and cannot mutate the gateway',
      });
    }
    if (enrollment?.grantProfile !== undefined) {
      if (!companionRequestAllowed(req, enrollment.grantProfile, enrollment.enrollmentId)) {
        return sendJson(res, 403, {
          error: 'companion_profile',
          message: 'this Companion device is not granted access to that gateway surface',
        });
      }
      req.headers[COMPANION_GRANTS_HEADER] = enrollment.grantProfile.join(',');
    }
    return runWithVaultContext(
      {
        vaultId,
        ...(deviceKey !== undefined ? { deviceKey } : {}),
        ...(enrollment?.grantProfile !== undefined
          ? { grantProfile: enrollment.grantProfile }
          : {}),
      },
      () => dispatchChain(req, res),
    );
  };

  let unsubscribeLateMount = (): void => undefined;
  const lateMountTasks = new Set<Promise<void>>();

  const start = async (publicBaseUrl: string): Promise<void> => {
    // Publish the live origin to the unified chat runner so post-turn
    // webhook minting can build absolute `_centraid-hook` URLs.
    serverUrl = publicBaseUrl;

    // Claim/renew the instance lease first — a fresh foreign lease should
    // flip `instance` health red as early in boot as possible, well before
    // any vault mounts (issue #351).
    instanceLease.start();

    // A vault arriving after boot can introduce an earlier WAL RPO than the
    // currently armed timer and also needs its host/scheduler activated.
    unsubscribeLateMount();
    unsubscribeLateMount = vaultRegistry.onMount((plane) => {
      const task = Promise.all([
        hostFor(plane).catch((error) =>
          logger.warn(
            `late vault host mount failed (${plane.boot.vaultId}): ` +
              (error instanceof Error ? error.message : String(error)),
          ),
        ),
        backupService
          .refreshWalSchedule()
          .catch((error) =>
            logger.warn(
              `late vault WAL schedule refresh failed: ` +
                (error instanceof Error ? error.message : String(error)),
            ),
          ),
      ]).then(() => undefined);
      lateMountTasks.add(task);
      void task.finally(() => lateMountTasks.delete(task));
    });

    // Start the per-vault in-process cron schedulers as they mount. Under
    // n8n semantics they only fire while running — downtime is not
    // backfilled (issue #149).
    schedulersStarted = true;
    for (const [, sched] of schedulers) sched.start();

    // Mount EVERY vault's workspace (#289): host bundle, app registry sync
    // + enrollment, scheduler reconcile — so each vault's automations fire
    // and each client's first request finds its vault warm.
    for (const plane of vaultRegistry.planesList()) {
      await hostFor(plane);
    }

    // Vault standing duties on the gateway clock: a sweep now, then hourly.
    vaultRegistry.start();

    // Adaptive backstop: active/deferred work retries quickly, an empty queue
    // follows the hardware profile's idle cadence, and errors back off.
    scheduleOutboxSweep(hardwareProfile.outboxIdleIntervalMs);

    // Warm the host-capability catalog — BOTH models and tools — for each
    // detected runner on EVERY gateway start, in the background so it never
    // delays readiness. Best-effort; the warmer dedupes, so a client Refresh
    // mid-boot joins this run.
    if (warmer) {
      const activeWarmer = warmer;
      void (async () => {
        const kinds: RunnerKind[] = ['codex', 'claude-code'];
        const surfaces: CatalogSurface[] = ['models', 'tools'];
        const checks = await Promise.all(
          kinds.map(async (kind) => ({
            kind,
            present: (await probeCliAvailability(kind)).available,
          })),
        );
        await Promise.all(
          checks
            .filter((c) => c.present)
            .flatMap((c) =>
              surfaces.map((surface) =>
                activeWarmer
                  .warm(c.kind, surface)
                  .catch((err) =>
                    catalogLogger.warn(
                      `catalog warm (${c.kind}/${surface}) failed: ` +
                        (err instanceof Error ? err.message : String(err)),
                    ),
                  ),
              ),
            ),
        );
      })();
    }

    // Offsite backup engine: hourly scheduler, started only when enabled.
    backupService.start();
  };

  const stop = async (): Promise<void> => {
    unsubscribeLateMount();
    // A mount notification may already be building its code host. Let that
    // bounded work settle before closing vault databases or removing temp
    // roots; otherwise shutdown races git/SQLite initialization.
    await Promise.all(lateMountTasks);
    await Promise.all([...schedulers.values()].map((sched) => sched.stop()));
    if (outboxTimer) clearTimeout(outboxTimer);
    // Await the in-flight backup run (if any): its post-registration steps
    // write shipper + backup state, and the vault registry teardown below
    // closes the very planes it would touch.
    await backupService.stop();
    // Flush any pending recovery-job progress write so a graceful shutdown
    // leaves a durable record (a still-`running` job is reconciled to
    // interrupted on the next `RecoverJobRunner.init`).
    await recoverJob.flush();
    // Release the lease so a fresh start (or another instance) sees an
    // absent file instead of waiting out LEASE_FRESH_WINDOW_MS.
    instanceLease.stop();
    // Sweep clock down, WAL checkpoint, files closed. Idempotent.
    vaultRegistry.stop();
    performanceMonitor.close();
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
    webAppSessions,
    extraHandlers,
    composedHandler,
    webhookHandler,
    recoverHandler,
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
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'app.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    manifest = {};
  }
  let hasIndex = false;
  try {
    await fs.access(path.join(dir, 'index.html'));
    hasIndex = true;
  } catch {
    hasIndex = false;
  }
  return {
    ...(typeof manifest.name === 'string' ? { name: manifest.name } : {}),
    ...(typeof manifest.description === 'string' ? { description: manifest.description } : {}),
    ...(typeof manifest.iconKey === 'string' ? { iconKey: manifest.iconKey } : {}),
    ...(typeof manifest.colorKey === 'string' ? { colorKey: manifest.colorKey } : {}),
    hasIndex,
  };
}

function manifestScopeBlock(raw: unknown): InstallScopeBlock | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const block = raw as { purpose?: unknown; scopes?: unknown };
  if (!Array.isArray(block.scopes)) return undefined;
  const verbs = new Set(['read', 'read+act', 'act', 'reveal']);
  const scopes = block.scopes.flatMap((s: unknown) => {
    if (s === null || typeof s !== 'object') return [];
    const scope = s as { schema?: unknown; table?: unknown; verbs?: unknown };
    if (typeof scope.schema !== 'string' || scope.schema === '') return [];
    if (typeof scope.verbs !== 'string' || !verbs.has(scope.verbs)) return [];
    return [
      {
        schema: scope.schema,
        ...(typeof scope.table === 'string' && scope.table !== '' ? { table: scope.table } : {}),
        verbs: scope.verbs as 'read' | 'read+act' | 'act' | 'reveal',
      },
    ];
  });
  if (scopes.length === 0) return undefined;
  return {
    ...(typeof block.purpose === 'string' && block.purpose !== ''
      ? { purpose: block.purpose }
      : {}),
    scopes,
  };
}
