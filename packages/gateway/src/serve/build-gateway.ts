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
 * Three hosts mount the same core:
 *
 *   - Electron embed: `buildGateway()` (or `serve()`) in the main
 *     process, paths derived from `gateway-paths.ts`.
 *   - `centraid-gateway` daemon: `serve()`, paths derived from a
 *     `--data-dir` config.
 *   - `@centraid/openclaw-plugin`: `buildGateway()` + mount
 *     `composedHandler` on the OpenClaw HTTP server (which owns auth),
 *     driving `start()`/`stop()` from `gateway_start`/shutdown.
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
  ConversationHistoryStore,
  InsightsStore,
  PrefsStore,
  Runtime,
  cleanupDeregisteredApp,
  makeConversationRouteHandler,
  makeUserStoreRouteHandler,
  type ConversationRunner,
  type RunnerStatus,
  type RunnerStatusOptions,
  type RuntimeLogger,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
  type VaultWorkspace,
} from '@centraid/app-engine';
import { KIT_DIR } from '@centraid/blueprints';
import * as automation from '@centraid/automation';
import {
  runAutomation,
  runPreflight,
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
import { WorktreeStore } from '../worktree-store/index.js';
import { openVaultRegistry, type VaultRegistry } from './vault-registry.js';
import { ConnectionBroker } from './connection-broker.js';
import type { VaultPlane } from './vault-plane.js';
import { runWithVaultContext, VAULT_HEADER, type DeviceAccess } from './vault-context.js';
import { makeVaultRouteHandler } from '../routes/vault-routes.js';
import { makeConnectionsRouteHandler } from '../routes/connections-routes.js';
import { makeDemoRouteHandler } from '../routes/demo-routes.js';
import { makeImportRouteHandler } from '../routes/import-routes.js';
import { makeBlobRouteHandler } from '../routes/blob-routes.js';
import { makeAppsStoreRouteHandler } from '../routes/apps-store-routes.js';
import { makeDraftCodeDirResolver, type ExtBandOps } from '../lifecycle/ext-band.js';
import { makeAutomationsRouteHandler } from '../routes/automations-routes.js';
import { RunEventBus } from '../runs/run-event-bus.js';
import { defaultLogger } from './default-logger.js';
import { makeLifecycleRouteHandler } from '../routes/lifecycle-routes.js';
import { makeUnifiedConversationRunner } from '../runs/unified-conversation-runner.js';
import {
  makeAssistantConversationRunner,
  makeVaultToolRunners,
} from '../runs/assistant-conversation-runner.js';
import { buildAssistantPrompt } from '../runs/assistant-prompt.js';
import { makeAssistantRouteHandler } from '../routes/assistant-routes.js';
import { makeTemplatesRouteHandler } from '../routes/templates-routes.js';
import { makeAgentsRouteHandler } from '../routes/agents-routes.js';
import { makeGatewayInfoRouteHandler } from '../routes/gateway-info-routes.js';
import { sendJson } from '../routes/route-helpers.js';
import type { GatewayPaths } from '../paths.js';

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
   * In-process chat runner override (Plane B). When set, this runner backs
   * `POST /centraid/<id>/_turn` instead of the gateway's own codex/claude
   * CLI runner. The OpenClaw plugin injects a `runEmbeddedAgent`-backed
   * runner so chat runs in OpenClaw's process — the desktop/daemon omit it
   * and get the default CLI runner (unchanged).
   */
  conversationRunner?: ConversationRunner;
  /**
   * Override for the `GET /centraid/_turn/runner-status` preflight. Defaults
   * to reporting the configured codex/claude CLI adapter (via `runPreflight`).
   * The OpenClaw plugin injects `{ kind: 'openclaw', ok: true }` — its chat
   * runs in-process, not through a CLI, so a codex/claude preflight would
   * misreport readiness.
   */
  runnerStatus?: (opts?: RunnerStatusOptions) => Promise<RunnerStatus>;
  /**
   * Override for how an automation is fired (Plane B). The gateway's default
   * runs the handler through `runAutomation` (codex/claude CLI puppet).
   * The OpenClaw plugin injects an in-process fire here, so BOTH scheduled
   * (cron) and manual (run-now) fires execute in OpenClaw's process. The
   * factory is called once with the gateway-resolved deps; it returns the
   * fire function the scheduler + automations route share.
   */
  fireAutomationFactory?: FireAutomationFactory;
  /**
   * Device-plane access control (issue #289 phase 2). When set, the
   * composed handler resolves the calling device from the request and
   * refuses vaults the device is not enrolled in; the vault list filters
   * to the device's enrollments. Absent (loopback embed, tests), the
   * transport is implicitly enrolled in every vault.
   */
  deviceAccess?: DeviceAccess;
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

/** Gateway-resolved deps handed to a {@link FireAutomationFactory}. */
export interface FireAutomationDeps {
  /** The current fire's vault workspace, resolved at fire time (#289). */
  workspace: () => VaultWorkspace;
  /** Resolves the current fire's vault's live `main` worktree apps dir. */
  codeAppsDir: () => string;
  /** Run-summary rollup (follows the current vault's transcripts.db). */
  analytics: AnalyticsStore;
  /** Logger for fire failures. */
  logger: RuntimeLogger;
}

/** Builds a {@link FireAutomation} from gateway-resolved deps. */
export type FireAutomationFactory = (deps: FireAutomationDeps) => FireAutomation;

/** A route handler in the gateway chain: `true` when it owned the response. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

// Prefixes the chat-history + prefs routes answer to, mirrored from
// app-engine's http-server.ts so `composedHandler` matches the same URLs
// `startRuntimeHttpServer` does.
const CONVERSATIONS_PREFIX = '/_centraid-conversations';
const USER_STORE_PREFIX = '/_centraid-user';

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
  /** Device-prefs store (`prefs.json`) — #280 killed the identity DB. */
  prefs: PrefsStore;
  /** Run-summary rollup over the current request's transcripts.db. */
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
   * automation surface (e.g. the OpenClaw plugin's `_centraid-hook`
   * webhook route) resolve automation CODE through this. Throws before
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
   * http-server.ts). Hosts that own auth (the OpenClaw plugin's
   * `auth: 'gateway'`) mount this on a single prefix route. Always
   * resolves the response, so it returns `true`.
   */
  composedHandler: RouteHandler;
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
  const logger = options.logger ?? defaultLogger(options.logTag);

  // Vault registry (duaility §12, #289): the gateway is a landlord hosting
  // N sovereign vaults — one plane per vault under the root, every request
  // addressed to exactly one of them. Required: post-#280 the whole app
  // surface (code, data, transcripts) is vault-scoped, so there is no
  // vault-less mode.
  const vaultRegistry: VaultRegistry = openVaultRegistry({
    rootDir: paths.vaultDir,
    logger,
  });
  const currentWorkspace = (): VaultWorkspace => vaultRegistry.currentWorkspace();

  // Device prefs (`prefs.json`) + the request vault's ledger stores. The
  // analytics/insights providers resolve the request's vault per call, so
  // every client sees its own vault's ledger (#289).
  const prefs = new PrefsStore(paths.prefsFile);
  const transcriptsProvider = () => currentWorkspace().transcripts();
  const analyticsStore = new AnalyticsStore(transcriptsProvider);
  const insightsStore = new InsightsStore(transcriptsProvider);
  const conversationHistoryStore = new ConversationHistoryStore(currentWorkspace, analyticsStore);

  // Per-turn prefs loader. Re-reads `prefs.json` every chat turn so a
  // settings change lands without a restart.
  const prefsLoader = async (): Promise<RunnerPrefs | undefined> => {
    const allPrefs = prefs.getAllPrefs();
    const kindRaw = allPrefs['agent.runner.kind'];
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
  // Synchronous handles to MOUNTED hosts — the schedulers + the OpenClaw
  // webhook route resolve code paths through these between requests (all
  // only run post-start, when every boot-time vault is mounted).
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

  // The one fire path, shared by "run now" (manual) and the cron schedulers
  // (scheduled). A host can override the fire entirely (Plane B — OpenClaw
  // runs it in-process); the default below runs on THIS host with the
  // gateway's own runner pref, against the CURRENT vault's live `main` code
  // + its data tree, streaming each run over the event bus. Scheduled fires
  // enter their vault's scope via `runWithVaultContext` (see schedulerFor);
  // manual fires inherit the request's scope.
  const fireAutomation: FireAutomation = options.fireAutomationFactory
    ? options.fireAutomationFactory({
        workspace: currentWorkspace,
        codeAppsDir: () => currentSettledHost().codeAppsDir(),
        analytics: analyticsStore,
        logger,
      })
    : (automationRef, opts): void => {
        // Mint the runId here so every fire (cron included) has a bus channel.
        const runId =
          opts.runId ?? `${automationRef}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
        void (async () => {
          const runnerPrefs = await prefsLoader();
          const host = await currentVaultHost();
          const ws = currentWorkspace();
          await runAutomation({
            automationRef,
            runId,
            appsDir: ws.appsDir,
            transcriptsDbFile: ws.transcriptsDbFile,
            codeAppsDir: host.codeAppsDir(),
            analytics: analyticsStore,
            // Each fire's ctx.vault rides the automation's enrolled
            // agent.agent credential, resolved per app id (duaility §12).
            vaultFor: (appId: string) => vaultRegistry.agentBridgeFor(appId),
            resolveConnection: connectionBroker.resolveForFire,
            runner: runnerPrefs?.kind ?? 'codex',
            triggerKind: opts.triggerKind,
            triggerOrigin: opts.triggerOrigin,
            ...(opts.input !== undefined ? { input: opts.input } : {}),
            onRunEvent: (ev) => runEventBus.publish(runId, ev),
          });
        })().catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          // Failed before the ledger opened: close off the bus or the viewer hangs.
          runEventBus.publish(runId, { type: 'run.end', ok: false, error: message });
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
      }
      settledHosts.set(vaultId, host);
      reconcileScheduler(vaultId);
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
      }
    });
    reconcileScheduler(id);
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
    // projects. A host-injected runner (Plane B) bypasses this per-vault one.
    const runner: ConversationRunner =
      options.conversationRunner ??
      makeUnifiedConversationRunner({
        store,
        prefsLoader,
        getDispatcher,
        publicBaseUrl: () => serverUrl,
        ext,
        ...makeVaultToolRunners(vaultRegistry),
        ...(paths.modelCatalogFile ? { catalogPath: paths.modelCatalogFile } : {}),
        ...(options.sessionIdFor ? { sessionIdFor: options.sessionIdFor } : {}),
      });

    const handlers: RouteHandler[] = [
      makeAppsStoreRouteHandler(store, {
        onAppLive: async (appId) => {
          await requireRuntime().registry.ensureUploaded(appId);
          vaultRegistry.enrollApp(appId);
          // A publish/rollback may have added/removed/toggled an
          // automation — resync THIS vault's cron scheduler off the new `main`.
          reconcileScheduler(vaultId);
        },
        onAppDeleted: async (appId) => {
          await deregisterAndCleanup(appId);
          reconcileScheduler(vaultId);
        },
        ext,
      }),
      // App lifecycle over HTTP (issue #141, Phase 2): the gateway owns
      // scaffold / clone / update-meta / automation create+toggle+delete.
      makeLifecycleRouteHandler({
        store,
        codeAppsDir,
        ...(paths.templatesCacheDir ? { templatesCacheDir: paths.templatesCacheDir } : {}),
        ensureRegistered: async (appId) => {
          await requireRuntime().registry.ensureUploaded(appId);
          vaultRegistry.enrollApp(appId);
        },
        deregister: deregisterAndCleanup,
        reconcile: () => reconcileScheduler(vaultId),
        ext,
      }),
      // Automation runtime ops over HTTP (issue #141): list/read/run-now,
      // the run feed + per-run detail, and insights — all over THIS
      // vault's transcripts ledger.
      makeAutomationsRouteHandler({
        store,
        transcriptsDbFile: workspace.transcriptsDbFile,
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
  const reconcileStates = new Map<string, { inFlight: boolean; dirty: boolean }>();
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
            onError: (err, ref) =>
              logger.warn(
                `scheduled ${ref} failed: ` + (err instanceof Error ? err.message : String(err)),
              ),
          });
    schedulers.set(vaultId, created);
    if (schedulersStarted) created.start();
    return created;
  };

  const reconcileScheduler = (vaultId: string): void => {
    const sched = schedulerFor(vaultId);
    let state = reconcileStates.get(vaultId);
    if (!state) {
      state = { inFlight: false, dirty: false };
      reconcileStates.set(vaultId, state);
    }
    if (state.inFlight) {
      state.dirty = true;
      return;
    }
    state.inFlight = true;
    const settled = state;
    void runWithVaultContext({ vaultId }, async () => {
      do {
        settled.dirty = false;
        const { rows } = await automation.list(settledHostFor(vaultId).codeAppsDir());
        // Every automation app acts through an enrolled agent.agent (duaility
        // §12) — enroll identities in THIS vault as the desired set settles.
        // Idempotent; grants stay owner-approved and deny-by-default.
        for (const appId of new Set(rows.map((r) => r.ownerApp))) {
          try {
            vaultRegistry.enrollAutomationAgent(appId);
          } catch (err) {
            logger.warn(
              `vault plane: agent enrollment for "${appId}" failed: ` +
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
    })
      .catch((err) =>
        logger.warn(
          `scheduler reconcile failed: ` + (err instanceof Error ? err.message : String(err)),
        ),
      )
      .finally(() => {
        settled.inFlight = false;
      });
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
    const transcriptsDbFile = currentWorkspace().transcriptsDbFile;
    if (trigger.kind === 'condition') {
      const evaluation = await automation.evaluateConditionTrigger({
        automationRef: ref,
        trigger,
        triggerIndex,
        purpose,
        transcriptsDbFile,
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
        transcriptsDbFile,
        vault,
      });
      if (evaluation.reason) {
        logger.warn(`data trigger ${ref}[${triggerIndex}] skipped: ${evaluation.reason}`);
        return;
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
    conversationRunner: options.conversationRunner ?? {
      // Facade over the request vault's unified runner (#280) — builder-
      // capable, so turns persist as `kind='build'` (issue #181). EVERY
      // ask turn rides the vault register (issue #286 phase 2: the vault
      // is the only store) — the owner assistant wearing the app lens.
      runKind: 'build',
      run: async (input) => {
        if (input.register === 'ask') return askRunner.run(input);
        return (await currentVaultHost()).runner.run(input);
      },
    },
    conversationRunnerSessionDir: () => currentWorkspace().runnerSessionDir,
    runnerStatus:
      options.runnerStatus ??
      (async (statusOpts) => {
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
      }),
    logger,
    codeDirOverride: async (appId: string) =>
      (await currentVaultHost()).store.resolveActiveAppDir(appId),
    draftCodeDir: async (appId: string, sessionId: string) =>
      (await currentVaultHost()).draftCodeDir(appId, sessionId),
    vaultFor: (appId: string) => vaultRegistry.bridgeFor(appId),
  });

  runtimeRef = runtime;

  // The vault assistant (shell-level Q&A over the whole vault): one
  // runner for the gateway's lifetime — every turn resolves the request's
  // vault (prompt, vault_sql credential, scratch cwd) at call time.
  const assistantRunner = makeAssistantConversationRunner({
    prefsLoader,
    getDispatcher,
    vaults: vaultRegistry,
  });

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

  // ── Route chain ───────────────────────────────────────────────────────
  const extraHandlers: RouteHandler[] = [
    // Gateway identity + version handshake (issue #289): cheap static
    // JSON, mounted first — health polling hits it every few seconds.
    makeGatewayInfoRouteHandler(),
    // The assistant's `_turn`/`resolve` surface — mounted BEFORE the
    // generic `_vault` handler, which answers 404 for any sub-route it
    // doesn't know (same prefix family).
    makeAssistantRouteHandler({
      vaults: vaultRegistry,
      conversationStore: conversationHistoryStore,
      runner: assistantRunner,
      conversationLocks: new Map(),
    }),
    // Scenario seeds (issue #290 phase 1): load/reset an app's demo data.
    // Mounted BEFORE the generic `_vault` handler (same prefix family).
    makeDemoRouteHandler(vaultRegistry, {
      codeAppsDir: () => currentSettledHost().codeAppsDir(),
    }),
    // File-drop imports (issue #290 phase 2): stage → review → publish.
    makeImportRouteHandler(vaultRegistry),
    // Blob custody (issue #296): staged uploads in, consent-checked +
    // Range-capable bytes out. Mounted BEFORE the generic `_vault`
    // handler (same prefix family).
    makeBlobRouteHandler(vaultRegistry),
    // Broker-carried connection credentials (issue #304): health list,
    // configure, pause/resume, and the PKCE consent ceremony. Mounted
    // BEFORE the generic `_vault` handler (same prefix family).
    makeConnectionsRouteHandler(vaultRegistry, connectionBroker),
    // Owner consent surface for the vault plane (grants, parked
    // confirmations, rename/presentation). Its `_vault` prefix
    // is disjoint from every other route family. Vault create/delete are
    // ADMIN acts (server CLI) — they no longer ride HTTP (#289).
    makeVaultRouteHandler(
      vaultRegistry,
      options.deviceAccess ? { deviceAccess: options.deviceAccess } : {},
    ),
    // Template catalog (issue #141): the gateway owns it, so the renderer
    // reads `GET /centraid/_templates` directly. Templates are SEEDS —
    // gateway-level, read-only material instantiated INTO a vault (#280).
    makeTemplatesRouteHandler({
      ...(paths.templatesCacheDir ? { cacheDir: paths.templatesCacheDir } : {}),
      ...(paths.remoteTemplatesUrl ? { remoteTemplatesUrl: paths.remoteTemplatesUrl } : {}),
    }),
    // Coding-agent detection (codex/claude credentials on the gateway host).
    makeAgentsRouteHandler(
      catalogPath
        ? {
            ...(resolveCatalogModels ? { resolveModels: resolveCatalogModels } : {}),
            ...(resolveCatalogTools ? { resolveTools: resolveCatalogTools } : {}),
          }
        : {},
    ),
    // The request vault's store-backed handlers (apps-store / lifecycle /
    // automations), resolved per request off the ambient vault scope.
    async (req, res) => {
      const host = await currentVaultHost();
      for (const handler of host.handlers) {
        if (await handler(req, res)) return true;
      }
      return false;
    },
  ];

  // `composedHandler` owns the whole request: resolve the vault the request
  // is addressed to (#289), then replay the chain `startRuntimeHttpServer`
  // used to run — chat-history → prefs → extra handlers → `runtime.handle`
  // — inside that vault's ambient scope. WITHOUT the bearer check, for
  // hosts that own auth (OpenClaw's `auth: 'gateway'`). CORS is the host's
  // job too: a fronting gateway emits its own.
  const conversationHandler = makeConversationRouteHandler(() => conversationHistoryStore);
  const userStoreHandler = makeUserStoreRouteHandler(
    () => prefs,
    () => currentWorkspace().ownerPartyId,
  );
  const dispatchChain: RouteHandler = async (req, res) => {
    const url = req.url ?? '';
    if (url.startsWith(CONVERSATIONS_PREFIX) && (await conversationHandler(req, res))) return true;
    if (url.startsWith(USER_STORE_PREFIX) && (await userStoreHandler(req, res))) return true;
    for (const handler of extraHandlers) {
      if (await handler(req, res)) return true;
    }
    await runtime.handle(req, res);
    return true;
  };

  const composedHandler: RouteHandler = async (req, res) => {
    // Resolve the request's vault (issue #289): the device's enrollment set
    // scopes what it may address; the header picks within it. No header →
    // the device's sole enrollment; shared-bearer transports (no device
    // key) are implicitly enrolled in every vault and default to the
    // oldest. The server never persists a pointer.
    const rawHeader = req.headers[VAULT_HEADER];
    const requested = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    const deviceKey = options.deviceAccess?.deviceKeyFor(req);
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
    return runWithVaultContext({ vaultId, ...(deviceKey !== undefined ? { deviceKey } : {}) }, () =>
      dispatchChain(req, res),
    );
  };

  const start = async (publicBaseUrl: string): Promise<void> => {
    // Publish the live origin to the unified chat runner so post-turn
    // webhook minting can build absolute `_centraid-hook` URLs.
    serverUrl = publicBaseUrl;

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
                    logger.warn(
                      `catalog warm (${c.kind}/${surface}) failed: ` +
                        (err instanceof Error ? err.message : String(err)),
                    ),
                  ),
              ),
            ),
        );
      })();
    }
  };

  const stop = async (): Promise<void> => {
    await Promise.all([...schedulers.values()].map((sched) => sched.stop()));
    // Sweep clock down, WAL checkpoint, files closed. Idempotent.
    vaultRegistry.stop();
  };

  return {
    runtime,
    prefs,
    analyticsStore,
    conversationHistoryStore,
    vaults: vaultRegistry,
    appsStore: async () => (await currentVaultHost()).store,
    codeAppsDir: () => currentSettledHost().codeAppsDir(),
    syncApps,
    extraHandlers,
    composedHandler,
    start,
    stop,
  } satisfies BuiltGateway;
}
