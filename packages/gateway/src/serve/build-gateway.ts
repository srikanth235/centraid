// governance: allow-repo-hygiene file-size-limit orchestration hub already at the cap; pending split of the route-handler wiring into a sibling module
/*
 * `buildGateway()` — construct the host-agnostic centraid gateway core.
 *
 * Issue #280 — the vault is the unit. The gateway core is one stable object
 * graph (runtime, dispatcher, prefs, route chain) whose PERSONAL surfaces
 * all resolve through the ACTIVE vault at call time: the conversation
 * ledger + run rollup ride the vault's `transcripts.db`, per-app data dirs
 * live under the vault's `apps/`, and each vault owns its OWN app code
 * store (`code/` — bare repo + worktrees). Switching vaults re-roots the
 * whole app world; `VaultRegistry.settleActivation()` runs the re-root
 * (registry sync + scheduler reconcile) before the switch response lands.
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
 * store, draft resolver, unified chat runner, store-backed route handlers)
 * is built lazily per vault and cached by vault id. The returned
 * `start(publicBaseUrl)` runs the post-listener lifecycle (activate the
 * current vault's workspace, scheduler start + reconcile — issue #149).
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
import type { VaultPlane } from './vault-plane.js';
import { makeVaultRouteHandler } from '../routes/vault-routes.js';
import { makeAppsStoreRouteHandler } from '../routes/apps-store-routes.js';
import { makeDraftCodeDirResolver } from '../lifecycle/draft-data.js';
import { makeAutomationsRouteHandler } from '../routes/automations-routes.js';
import { RunEventBus } from '../runs/run-event-bus.js';
import { defaultLogger } from './default-logger.js';
import { makeLifecycleRouteHandler } from '../routes/lifecycle-routes.js';
import { makeUnifiedConversationRunner } from '../runs/unified-conversation-runner.js';
import { makeAssistantConversationRunner } from '../runs/assistant-conversation-runner.js';
import { buildAssistantPrompt } from '../runs/assistant-prompt.js';
import { makeAssistantRouteHandler } from '../routes/assistant-routes.js';
import { makeTemplatesRouteHandler } from '../routes/templates-routes.js';
import { makeAgentsRouteHandler } from '../routes/agents-routes.js';
import type { GatewayPaths } from '../paths.js';

export interface BuildGatewayOptions {
  /** On-disk slots the runtime reads/writes. Caller-derived. */
  paths: GatewayPaths;
  /**
   * The cron scheduler `start()` runs (issue #149) is gateway-owned and
   * in-process: a single minute-boundary timer fires enabled cron
   * automations through the same `runAutomation` path as "run now".
   * There is no OS scheduler; missed minutes during downtime are skipped
   * (n8n semantics — no backfill). Defaults to a fresh `automation.InProcessScheduler`;
   * inject one (e.g. a spy) only for tests.
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
  /** The ACTIVE vault's workspace, resolved at fire time (#280). */
  workspace: () => VaultWorkspace;
  /** Resolves the active vault's live `main` worktree apps dir. */
  codeAppsDir: () => string;
  /** Run-summary rollup (follows the active vault's transcripts.db). */
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
  liveDataFile: (appId: string) => string;
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
  /** Run-summary rollup over the ACTIVE vault's transcripts.db. */
  analyticsStore: AnalyticsStore;
  conversationHistoryStore: ConversationHistoryStore;
  /**
   * The personal-vault registry (duaility §12). Hosts drive owner acts
   * (create/rename/switch/delete vaults, grants, confirmations) through
   * this; apps only ever reach the active vault via `ctx.vault`.
   */
  vaults: VaultRegistry;
  /**
   * The ACTIVE vault's git-store backend. Callers (the publish endpoint,
   * export/import, the desktop's file IPC) drive sessions + publishes
   * through this. Async — the store materializes lazily per vault.
   */
  activeAppsStore(): Promise<WorktreeStore>;
  /**
   * Resolves the ACTIVE vault's live `main` worktree apps dir, rotating
   * atomically per publish/rollback. Hosts that register their own
   * automation surface (e.g. the OpenClaw plugin's `_centraid-hook`
   * webhook route) resolve automation CODE through this. Throws before
   * `start()` has activated the first workspace.
   */
  codeAppsDir: () => string;
  /**
   * Route handlers run after auth, before `runtime.handle` (vault routes,
   * templates, agents, then the active vault's store-backed handlers).
   * Passed straight to `startRuntimeHttpServer` by `serve()`.
   */
  extraHandlers: RouteHandler[];
  /**
   * One handler replaying the full chain — `conversation → prefs →
   * extraHandlers[] → runtime.handle` — MINUS the bearer check (cf.
   * `app-engine` http-server.ts). Hosts that own auth (the OpenClaw
   * plugin's `auth: 'gateway'`) mount this on a single prefix route.
   * Always resolves the response, so it returns `true`.
   */
  composedHandler: RouteHandler;
  /**
   * Post-listener lifecycle. Call once the host has bound a socket,
   * passing the live origin so post-turn webhook minting can build
   * absolute `_centraid-hook` URLs. Activates the current vault's
   * workspace, then starts + reconciles the cron scheduler.
   */
  start(publicBaseUrl: string): Promise<void>;
  /** Stop the cron scheduler. Idempotent. */
  stop(): Promise<void>;
}

export async function buildGateway(options: BuildGatewayOptions): Promise<BuiltGateway> {
  const { paths } = options;
  const logger = options.logger ?? defaultLogger(options.logTag);

  // Vault registry (duaility §12, #280): the gateway is the sole holder of
  // the owner's vaults — one plane per vault under the root, exactly one
  // active at a time. Required: post-#280 the whole app surface (code,
  // data, transcripts) is vault-scoped, so there is no vault-less mode.
  const vaultRegistry: VaultRegistry = openVaultRegistry({
    rootDir: paths.vaultDir,
    logger,
  });
  const activeWorkspace = (): VaultWorkspace => vaultRegistry.activeWorkspace();

  // Device prefs (`prefs.json`) + the ACTIVE vault's ledger stores. The
  // analytics/insights providers resolve the active vault per call, so a
  // vault switch lands without reconstructing either store (#280).
  const prefs = new PrefsStore(paths.prefsFile);
  const transcriptsProvider = () => activeWorkspace().transcripts();
  const analyticsStore = new AnalyticsStore(transcriptsProvider);
  const insightsStore = new InsightsStore(transcriptsProvider);
  const conversationHistoryStore = new ConversationHistoryStore(activeWorkspace, analyticsStore);

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

  // ── Per-vault host bundles (#280) ─────────────────────────────────────
  // Each vault owns its app world: a git code store under the vault dir,
  // a draft resolver seeded from the vault's own live data, a unified chat
  // runner over that store, and the store-backed route handlers. Built
  // lazily per vault, cached by id; the active one resolves per request.
  const hosts = new Map<string, Promise<VaultHost>>();
  // Synchronous handle to the last ACTIVATED host — the scheduler + the
  // OpenClaw webhook route resolve code paths through this between
  // activations (both only run post-start, when it is always set).
  let currentHost: VaultHost | undefined;
  // In-process bus for live run streaming (issue #158): a fire publishes via
  // `onRunEvent`; the `run/events` SSE endpoint subscribes by runId.
  const runEventBus = new RunEventBus();

  // The one fire path, shared by "run now" (manual) and the cron scheduler
  // (scheduled). A host can override the fire entirely (Plane B — OpenClaw
  // runs it in-process); the default below runs on THIS host with the
  // gateway's own runner pref, against the ACTIVE vault's live `main` code
  // + its data tree, streaming each run over the event bus.
  const fireAutomation: FireAutomation = options.fireAutomationFactory
    ? options.fireAutomationFactory({
        workspace: activeWorkspace,
        codeAppsDir: () => requireHost().codeAppsDir(),
        analytics: analyticsStore,
        logger,
      })
    : (automationRef, opts): void => {
        // Mint the runId here so every fire (cron included) has a bus channel.
        const runId =
          opts.runId ?? `${automationRef}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
        void (async () => {
          const runnerPrefs = await prefsLoader();
          const host = await activeHost();
          const ws = activeWorkspace();
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

  const requireHost = (): VaultHost => {
    if (!currentHost) throw new Error('gateway: no vault workspace activated yet');
    return currentHost;
  };

  const activeHost = (): Promise<VaultHost> => {
    const plane = vaultRegistry.active();
    return hostFor(plane);
  };

  const hostFor = (plane: VaultPlane): Promise<VaultHost> => {
    const vaultId = plane.boot.vaultId;
    const cached = hosts.get(vaultId);
    if (cached) return cached;
    const built = buildHost(plane).catch((err) => {
      // A failed build must not poison the cache — drop it so the next
      // request retries (e.g. after a transient git failure).
      hosts.delete(vaultId);
      throw err;
    });
    hosts.set(vaultId, built);
    return built;
  };

  // Drop an app from the registry AND delete its wrapper dir under the
  // active vault (`<apps>/<id>/` — data.sqlite + blobs), then run the
  // vault-side uninstall cascade (§11: revoke + retire enrollment).
  const deregisterAndCleanup = async (appId: string): Promise<void> => {
    const removed = await requireRuntime().registry.deregister(appId);
    if (removed) await cleanupDeregisteredApp(activeWorkspace().appsDir, removed, logger);
    vaultRegistry.revokeApp(appId);
  };

  const requireRuntime = (): Runtime => {
    if (!runtimeRef) throw new Error('gateway: runtime not constructed yet');
    return runtimeRef;
  };

  async function buildHost(plane: VaultPlane): Promise<VaultHost> {
    const workspace = plane.workspace;
    const store = new WorktreeStore({ root: plane.codeStoreRoot });
    await store.init();
    const codeAppsDir = (): string => path.join(store.getActiveMainLink(), 'apps');
    // Stable live data file — injected so a publish migrates live data and a
    // draft seeds from it (issue #144). Rooted in THIS vault's workspace.
    const liveDataFile = (appId: string): string =>
      path.join(workspace.appsDir, appId, 'data.sqlite');
    // Draft preview (#141 + #144): resolve an app's code dir to its OPEN
    // session worktree and lazily seed the worktree's branched `data.sqlite`
    // from live there.
    const draftCodeDir = makeDraftCodeDirResolver(store, liveDataFile);

    // Unified chat (issue #141, Phase 3): every chat turn runs in the app's
    // draft worktree with the union of native file tools + the `centraid_*`
    // dispatcher — one surface that both tweaks the app's code and operates
    // its data. A host-injected runner (Plane B) bypasses this per-vault one.
    const runner: ConversationRunner =
      options.conversationRunner ??
      makeUnifiedConversationRunner({
        store,
        prefsLoader,
        getDispatcher,
        publicBaseUrl: () => serverUrl,
        liveDataFile,
        ...(paths.modelCatalogFile ? { catalogPath: paths.modelCatalogFile } : {}),
        ...(options.sessionIdFor ? { sessionIdFor: options.sessionIdFor } : {}),
      });

    const handlers: RouteHandler[] = [
      makeAppsStoreRouteHandler(store, {
        onAppLive: async (appId) => {
          await requireRuntime().registry.ensureUploaded(appId);
          vaultRegistry.enrollApp(appId);
          // A publish/rollback may have added/removed/toggled an
          // automation — resync the cron scheduler off the new `main`.
          reconcileScheduler();
        },
        onAppDeleted: async (appId) => {
          await deregisterAndCleanup(appId);
          reconcileScheduler();
        },
        liveDataFile,
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
        reconcile: reconcileScheduler,
        liveDataFile,
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
      vaultId: workspace.vaultId,
      store,
      codeAppsDir,
      liveDataFile,
      draftCodeDir,
      runner,
      handlers,
    };
  }

  // ── Scheduler (issue #149) ────────────────────────────────────────────
  // One persistent in-process cron scheduler for the gateway's lifetime;
  // `reconcileScheduler()` (activation + every publish/delete) settles its
  // in-memory registry off the ACTIVE vault's `main`. Coalesced so
  // concurrent publishes don't thrash it.
  const schedulerCodeAppsDir = (): string => requireHost().codeAppsDir();
  let scheduler: automation.LocalScheduler | undefined;
  let reconcileInFlight = false;
  let reconcileDirty = false;
  const reconcileScheduler = (): void => {
    const sched = scheduler;
    if (!sched) return;
    if (reconcileInFlight) {
      reconcileDirty = true;
      return;
    }
    reconcileInFlight = true;
    void (async () => {
      do {
        reconcileDirty = false;
        const { rows } = await automation.list(schedulerCodeAppsDir());
        // Every automation app acts through an enrolled agent.agent (duaility
        // §12) — enroll identities in the ACTIVE vault as the desired set
        // settles. Idempotent; grants stay owner-approved and deny-by-default.
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
            `scheduler reconcile — ` +
              `added=${diff.added.length} updated=${diff.updated.length} removed=${diff.removed.length}`,
          );
        }
      } while (reconcileDirty);
    })()
      .catch((err) =>
        logger.warn(
          `scheduler reconcile failed: ` + (err instanceof Error ? err.message : String(err)),
        ),
      )
      .finally(() => {
        reconcileInFlight = false;
      });
  };

  // Condition-trigger evaluation (duaility: time semantics live in the
  // data). On the trigger's `every` gate, run its consented read under the
  // automation's agent grant; unseen rows fire the automation with the
  // rows as `ctx.input`. A receipted deny or bridge error logs and skips —
  // failure never widens access and never stalls the tick.
  const evaluateCondition = async (ref: string, triggerIndex: number): Promise<void> => {
    const parsed = automation.parseRef(ref);
    if (!parsed) return;
    const row = await automation.readAppOwned(
      schedulerCodeAppsDir(),
      parsed.appId,
      parsed.automationId,
    );
    if (!row || !row.enabled || !row.manifest.vault) return;
    const trigger = row.manifest.triggers[triggerIndex];
    if (!trigger) return;
    const purpose = row.manifest.vault.purpose;
    const vault = vaultRegistry.agentBridgeFor(parsed.appId);
    const transcriptsDbFile = activeWorkspace().transcriptsDbFile;
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
  scheduler =
    options.scheduler ??
    new automation.InProcessScheduler({
      fire: (ref) => fireAutomation(ref, { triggerKind: 'scheduled', triggerOrigin: 'cron' }),
      evaluate: (ref, triggerIndex) => evaluateCondition(ref, triggerIndex),
      onError: (err, ref) =>
        logger.warn(
          `scheduled ${ref} failed: ` + (err instanceof Error ? err.message : String(err)),
        ),
    });

  // ── The runtime ───────────────────────────────────────────────────────
  // One Runtime for the gateway's lifetime; its apps dir, registry, chat
  // runner, and session scratch all resolve through the active vault.
  const runtime = new Runtime({
    appsDir: () => activeWorkspace().appsDir,
    // Shared kit assets (kit.js / kit.css) are served from the blueprints
    // package's canonical `kit/` dir; apps no longer ship per-app copies.
    sharedAssetsDir: KIT_DIR,
    userStore: prefs,
    conversationHistoryStore,
    conversationRunner: options.conversationRunner ?? {
      // Facade over the ACTIVE vault's unified runner (#280) — builder-
      // capable, so turns persist as `kind='build'` (issue #181). Ask
      // turns on vault-backed apps peel off onto the vault register
      // (issue #286 phase 2) — vault_sql/vault_invoke with the app lens.
      runKind: 'build',
      run: async (input) => {
        if (input.register === 'ask' && (await askAppMeta(input.appId)).vaultBacked) {
          return askRunner.run(input);
        }
        return (await activeHost()).runner.run(input);
      },
    },
    conversationRunnerSessionDir: () => activeWorkspace().runnerSessionDir,
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
    codeDirOverride: async (appId: string) => (await activeHost()).store.resolveActiveAppDir(appId),
    draftCodeDir: async (appId: string, sessionId: string) =>
      (await activeHost()).draftCodeDir(appId, sessionId),
    vaultFor: (appId: string) => vaultRegistry.bridgeFor(appId),
  });

  runtimeRef = runtime;

  // The vault assistant (shell-level Q&A over the whole vault): one
  // runner for the gateway's lifetime — every turn resolves the ACTIVE
  // vault (prompt, vault_sql credential, scratch cwd) at call time.
  const assistantRunner = makeAssistantConversationRunner({
    prefsLoader,
    getDispatcher,
    vaults: vaultRegistry,
  });

  // Ask-register manifest probe (issue #286 phase 2): the app copilot's
  // `register: 'ask'` turns ride the vault register when the app is
  // vault-backed — its data lives in the vault, so the app-silo trio
  // could only stare at an empty file. Resolved per turn off the live
  // `main` manifest so a publish that adds/drops the vault block lands
  // without a restart.
  const askAppMeta = async (
    appId: string,
  ): Promise<{ vaultBacked: boolean; name?: string; description?: string }> => {
    try {
      const host = await activeHost();
      const dir = await host.store.resolveActiveAppDir(appId);
      if (!dir) return { vaultBacked: false };
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'app.json'), 'utf8')) as {
        name?: unknown;
        description?: unknown;
        vault?: unknown;
      };
      return {
        vaultBacked: !!raw.vault && typeof raw.vault === 'object',
        ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
        ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
      };
    } catch {
      return { vaultBacked: false };
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
      const plane = vaultRegistry.active();
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
    // The assistant's `_turn`/`resolve` surface — mounted BEFORE the
    // generic `_vault` handler, which answers 404 for any sub-route it
    // doesn't know (same prefix family).
    makeAssistantRouteHandler({
      vaults: vaultRegistry,
      conversationStore: conversationHistoryStore,
      runner: assistantRunner,
      conversationLocks: new Map(),
    }),
    // Owner consent surface for the vault plane (grants, parked
    // confirmations, vault lifecycle). Its `_vault` prefix
    // is disjoint from every other route family.
    makeVaultRouteHandler(vaultRegistry),
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
    // The ACTIVE vault's store-backed handlers (apps-store / lifecycle /
    // automations), resolved per request so a vault switch re-roots them.
    async (req, res) => {
      const host = await activeHost();
      for (const handler of host.handlers) {
        if (await handler(req, res)) return true;
      }
      return false;
    },
  ];

  // `composedHandler` replays the chain `startRuntimeHttpServer` runs —
  // chat-history → prefs → extra handlers → `runtime.handle` — but WITHOUT
  // the bearer check, for hosts that own auth (OpenClaw's `auth: 'gateway'`).
  // CORS is the host's job too: a fronting gateway emits its own.
  const conversationHandler = makeConversationRouteHandler(() => conversationHistoryStore);
  const userStoreHandler = makeUserStoreRouteHandler(
    () => prefs,
    () => activeWorkspace().ownerPartyId,
  );
  const composedHandler: RouteHandler = async (req, res) => {
    const url = req.url ?? '';
    if (url.startsWith(CONVERSATIONS_PREFIX) && (await conversationHandler(req, res))) return true;
    if (url.startsWith(USER_STORE_PREFIX) && (await userStoreHandler(req, res))) return true;
    for (const handler of extraHandlers) {
      if (await handler(req, res)) return true;
    }
    await runtime.handle(req, res);
    return true;
  };

  // ── Workspace activation (#280) ───────────────────────────────────────
  // Mount the ACTIVE vault's workspace: build (or reuse) its host bundle,
  // load its registry, sync every app on its `main` into the registry +
  // enroll it in the vault, then settle the cron scheduler. Runs at boot
  // and after every vault switch (the vault-routes PATCH awaits it).
  const activateWorkspace = async (): Promise<void> => {
    const host = await activeHost();
    currentHost = host;
    await runtime.bootstrap();
    for (const appId of await host.store.listApps()) {
      await runtime.registry.ensureUploaded(appId);
      vaultRegistry.enrollApp(appId);
    }
    reconcileScheduler();
  };
  vaultRegistry.setActivationHook(activateWorkspace);

  const start = async (publicBaseUrl: string): Promise<void> => {
    // Publish the live origin to the unified chat runner so post-turn
    // webhook minting can build absolute `_centraid-hook` URLs.
    serverUrl = publicBaseUrl;
    await activateWorkspace();

    // Start the in-process cron scheduler and settle it with disk. Under
    // n8n semantics it only fires while running — downtime is not
    // backfilled (issue #149).
    scheduler?.start();
    reconcileScheduler();

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
    await scheduler?.stop();
    // Sweep clock down, WAL checkpoint, files closed. Idempotent.
    vaultRegistry.stop();
  };

  return {
    runtime,
    prefs,
    analyticsStore,
    conversationHistoryStore,
    vaults: vaultRegistry,
    activeAppsStore: async () => (await activeHost()).store,
    codeAppsDir: () => requireHost().codeAppsDir(),
    extraHandlers,
    composedHandler,
    start,
    stop,
  } satisfies BuiltGateway;
}
