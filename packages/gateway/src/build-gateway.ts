/*
 * `buildGateway()` — construct the host-agnostic centraid gateway core.
 *
 * The gateway is the host-agnostic lift of what `apps/desktop/src/main/
 * local-runtime.ts` used to do inline. `buildGateway()` constructs the
 * WHOLE object graph (stores, chat runner, `Runtime`, the in-process
 * scheduler, every route handler) and returns it — *without* binding a
 * socket. It also exposes a `composedHandler` that replays the gateway's
 * route chain (`chatHistory → userStore → extraHandlers[] →
 * runtime.handle`) minus the bearer check, for hosts that own auth
 * themselves. The listener-and-bearer wrapper lives in `serve.ts`.
 *
 * Three hosts mount the same core:
 *
 *   - Electron embed: `buildGateway()` (or `serve()`) in the main
 *     process, paths derived from `gateway-paths.ts`, secrets read from
 *     `safeStorage`.
 *   - `centraid-gateway` daemon: `serve()`, paths derived from a
 *     `--data-dir` config, secrets from a sealed file on disk.
 *   - `@centraid/openclaw-plugin`: `buildGateway()` + mount
 *     `composedHandler` on the OpenClaw HTTP server (which owns auth),
 *     driving `start()`/`stop()` from `gateway_start`/shutdown.
 *
 * Construction (stores → prefs loader → chat runner → `Runtime` → route
 * handlers) runs in `buildGateway()`; the per-step rationale lives in the
 * inline comments below. The returned `start(publicBaseUrl)` then runs the
 * post-listener lifecycle (bootstrap, git-store registry sync, scheduler
 * start + reconcile — issue #149). The only thing the caller injects is
 * paths + secrets (+ an optional scheduler, for tests).
 */

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ChatHistoryStore,
  Runtime,
  UserStore,
  cleanupDeregisteredApp,
  makeChatHistoryRouteHandler,
  makeGatewayDbProvider,
  makeUserStoreRouteHandler,
  type RuntimeLogger,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
} from '@centraid/app-engine';
import { AnalyticsStore, InsightsStore, makeAnalyticsDbProvider } from '@centraid/analytics';
import { listAutomations, InProcessScheduler, type LocalScheduler } from '@centraid/automation';
import {
  makeChatRunner,
  runAutomationLocal,
  runPreflight,
  type RunnerPrefs,
} from '@centraid/agent-runtime';
import { WorktreeStore } from '@centraid/worktree-store';
import { makeAppsStoreRouteHandler } from './apps-store-routes.js';
import { makeDraftCodeDirResolver } from './draft-data.js';
import { makeAutomationsRouteHandler } from './automations-routes.js';
import { RunEventBus } from './run-event-bus.js';
import { defaultLogger } from './default-logger.js';
import { makeLifecycleRouteHandler } from './lifecycle-routes.js';
import { makeUnifiedChatRunner } from './unified-chat-runner.js';
import { makeTemplatesRouteHandler } from './templates-routes.js';
import type { GatewayPaths } from './paths.js';
import type { SecretsProvider } from './secrets.js';
import { resolveProvider } from './provider-prefs.js';

export interface BuildGatewayOptions {
  /** On-disk slots the runtime reads/writes. Caller-derived. */
  paths: GatewayPaths;
  /** Pluggable secret reader for the OpenAI-compatible provider API key. */
  secrets: SecretsProvider;
  /**
   * The cron scheduler `start()` runs (issue #149) is gateway-owned and
   * in-process: a single minute-boundary timer fires enabled cron
   * automations through the same `runAutomationLocal` path as "run now".
   * There is no OS scheduler; missed minutes during downtime are skipped
   * (n8n semantics — no backfill). Defaults to a fresh `InProcessScheduler`;
   * inject one (e.g. a spy) only for tests.
   */
  scheduler?: LocalScheduler;
  /** Logger forwarded to `Runtime`. Defaults to a `console.*` wrapper. */
  logger?: RuntimeLogger;
  /**
   * Tag prepended to log lines emitted by the gateway's own bootstrap
   * paths (currently just the scheduler-reconcile log). Hosts use this
   * to disambiguate multiple gateways in one process.
   */
  logTag?: string;
  /**
   * When provided, the gateway owns app *code* as a git store rooted
   * here (issue #137): `<appsStoreRoot>/apps.git` + `worktrees/`. The
   * runtime then serves handlers + static from the live `main`
   * worktree instead of `<appsDir>/<id>/versions/<active>/`. App
   * *data* (`data.sqlite`) still lives under `paths.appsDir`, so the
   * two stores stay cleanly separated. Omit for the legacy
   * tarball-upload backend (OpenClaw, pre-#137 setups).
   */
  appsStoreRoot?: string;
}

/** A route handler in the gateway chain: `true` when it owned the response. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

// Prefixes the chat-history + user-store routes answer to, mirrored from
// app-engine's http-server.ts so `composedHandler` matches the same URLs
// `startRuntimeHttpServer` does.
const CHAT_HISTORY_PREFIX = '/_centraid-chat';
const USER_STORE_PREFIX = '/_centraid-user';

export interface BuiltGateway {
  /** The constructed runtime (handles, dispatcher, change bus). */
  runtime: Runtime;
  /** Stores exposed so callers can read directly without reconstructing. */
  userStore: UserStore;
  analyticsStore: AnalyticsStore;
  chatHistoryStore: ChatHistoryStore;
  /**
   * The git-store backend, when `appsStoreRoot` was supplied. Callers
   * (the publish endpoint, export/import, the desktop's file IPC) drive
   * sessions + publishes through this. `undefined` on the legacy backend.
   */
  appsStore?: WorktreeStore;
  /**
   * Route handlers run after auth, before `runtime.handle` (templates
   * always; apps-store / lifecycle / automations on the git-store
   * backend). Passed straight to `startRuntimeHttpServer` by `serve()`.
   */
  extraHandlers: RouteHandler[];
  /**
   * One handler replaying the full chain — `chatHistory → userStore →
   * extraHandlers[] → runtime.handle` — MINUS the bearer check (cf.
   * `app-engine` http-server.ts:135-147). Hosts that own auth (the
   * OpenClaw plugin's `auth: 'gateway'`) mount this on a single prefix
   * route. Always resolves the response, so it returns `true`.
   */
  composedHandler: RouteHandler;
  /**
   * Post-listener lifecycle. Call once the host has bound a socket,
   * passing the live origin so post-turn webhook minting can build
   * absolute `_centraid-hook` URLs. Runs `runtime.bootstrap()`, syncs the
   * registry off the git-store `main`, then starts + reconciles the cron
   * scheduler.
   */
  start(publicBaseUrl: string): Promise<void>;
  /** Stop the cron scheduler. Idempotent. */
  stop(): Promise<void>;
}

export async function buildGateway(options: BuildGatewayOptions): Promise<BuiltGateway> {
  const { paths, secrets } = options;
  const logger = options.logger ?? defaultLogger(options.logTag);

  await fs.mkdir(paths.appsDir, { recursive: true });

  // Git-store backend (issue #137). When a root is given, the gateway
  // owns app code as a bare git repo + worktrees; the runtime serves
  // handlers from the live `main` worktree. Constructed + initialized
  // here so the code-dir override is available at Runtime construction.
  let appsStore: WorktreeStore | undefined;
  if (options.appsStoreRoot !== undefined) {
    appsStore = new WorktreeStore({ root: options.appsStoreRoot });
    await appsStore.init();
  }
  const codeDirOverride = appsStore
    ? (appId: string) => appsStore!.resolveActiveAppDir(appId)
    : undefined;
  // Stable live data file — injected so a publish migrates live data and a
  // draft seeds from it (issue #144).
  const liveDataFile = (appId: string): string => path.join(paths.appsDir, appId, 'data.sqlite');
  // Draft preview (#141 + #144): resolve an app's code dir to its OPEN
  // session worktree (serving the staged draft before publish) and lazily
  // seed the worktree's branched `data.sqlite` from live there — data dir =
  // code dir in draft mode, so one resolver primes both planes.
  const draftCodeDir = appsStore ? makeDraftCodeDirResolver(appsStore, liveDataFile) : undefined;

  // Cron-scheduler reconcile (issue #149). Automation *code* lives under
  // the git-store materialized `main` (`active-main/apps`), or `appsDir`
  // for the flat/legacy layout. We re-scan + reconcile the whole desired
  // set (idempotent) rather than register single rows, so a publish /
  // delete / rollback keeps the in-process cron scheduler in sync. Coalesced
  // so concurrent publishes don't thrash it. `scheduler` is the single
  // persistent instance, assigned once the fire surface is wired below.
  const schedulerCodeAppsDir = (): string =>
    appsStore ? path.join(appsStore.getActiveMainLink(), 'apps') : paths.appsDir;
  let scheduler: LocalScheduler | undefined;
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
        const { rows } = await listAutomations(schedulerCodeAppsDir());
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

  // Gateway identity DB + the central analytics DB. Each store wraps a
  // lazy provider that opens its file on first use. Chat sessions + chat
  // runs live in each app's `runtime.sqlite` under `appsDir`, so
  // `ChatHistoryStore` is constructed with `appsDir` and resolves the
  // file per app.
  const gatewayDbProvider = makeGatewayDbProvider(paths.identityDb);
  const analyticsProvider = makeAnalyticsDbProvider(paths.analyticsDb);
  const analyticsStore = new AnalyticsStore(analyticsProvider);
  const userStore = new UserStore(gatewayDbProvider);
  const chatHistoryStore = new ChatHistoryStore(
    paths.appsDir,
    () => userStore.getUserId(),
    analyticsStore,
  );

  // Per-turn prefs loader. Re-reads the gateway user_prefs row every chat
  // turn so a settings change lands without a restart. The API key is
  // spliced in from the injected `secrets` provider (safeStorage vs.
  // sealed file, per host).
  const prefsLoader = async (): Promise<RunnerPrefs | undefined> => {
    const allPrefs = userStore.getAllPrefs();
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
    const provider = await resolveProvider(allPrefs, secrets);
    return {
      kind,
      ...(binPath ? { binPath } : {}),
      ...(extraArgs ? { extraArgs } : {}),
      ...(provider ? { provider } : {}),
    };
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
  // Unified chat (issue #141, Phase 3): when a git store backs app code,
  // every chat turn runs in the app's draft worktree with the union of
  // native file tools + the `centraid_*` dispatcher — one surface that both
  // tweaks the app's code and operates its data. Without a store (no draft
  // worktree to edit) we fall back to the data-only chat adapter.
  const chatRunner = appsStore
    ? makeUnifiedChatRunner({
        store: appsStore,
        prefsLoader,
        getDispatcher,
        publicBaseUrl: () => serverUrl,
        codexHomeBaseDir: paths.codexHomeBaseDir,
        liveDataFile,
      })
    : makeChatRunner({
        prefsLoader,
        getDispatcher,
        codexHomeBaseDir: paths.codexHomeBaseDir,
      });

  const runtime = new Runtime({
    appsDir: paths.appsDir,
    userStore,
    chatHistoryStore,
    chatRunner,
    chatRunnerSessionDir: paths.chatRunnerSessionDir,
    runnerStatus: async () => {
      const prefs = await prefsLoader();
      if (!prefs) {
        return {
          kind: 'none' as const,
          ok: false,
          reason: 'No coding agent configured.',
          hint: 'Open Settings → AI providers and pick Codex or Claude Code.',
        };
      }
      return runPreflight(prefs);
    },
    logger,
    ...(codeDirOverride ? { codeDirOverride } : {}),
    ...(draftCodeDir ? { draftCodeDir } : {}),
  });

  runtimeRef = runtime;

  // Template catalog (issue #141): the gateway owns it, so the renderer
  // reads `GET /centraid/_templates` directly. Mounted regardless of the
  // code backend — templates are bundle/cache-resolved, independent of the
  // git store. The git-store publish/session/files surface (issue #137) is
  // appended below when a store backend is active.
  const extraHandlers: RouteHandler[] = [
    makeTemplatesRouteHandler({
      ...(paths.templatesCacheDir ? { cacheDir: paths.templatesCacheDir } : {}),
      ...(paths.remoteTemplatesUrl ? { remoteTemplatesUrl: paths.remoteTemplatesUrl } : {}),
    }),
  ];

  if (appsStore) {
    const store = appsStore;
    const codeAppsDir = (): string => path.join(store.getActiveMainLink(), 'apps');
    // In-process bus for live run streaming (issue #158): a fire publishes via
    // `onRunEvent`; the `run/events` SSE endpoint subscribes by runId.
    const runEventBus = new RunEventBus();
    // The one fire path, shared by "run now" (manual) and the cron
    // scheduler (scheduled). Both run on THIS host with the gateway's own
    // runner pref, against the live `main` code + the stable data tree.
    const fireAutomation = (
      automationRef: string,
      opts: {
        runId?: string;
        triggerKind: AutomationTriggerKind;
        triggerOrigin: AutomationTriggerOrigin;
      },
    ): void => {
      // Mint the runId here so every fire (cron included) has a bus channel.
      const runId =
        opts.runId ?? `${automationRef}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;
      void (async () => {
        const prefs = await prefsLoader();
        await runAutomationLocal({
          automationRef,
          runId,
          appsDir: paths.appsDir,
          codeAppsDir: codeAppsDir(),
          analytics: analyticsStore,
          runner: prefs?.kind ?? 'codex',
          triggerKind: opts.triggerKind,
          triggerOrigin: opts.triggerOrigin,
          onRunEvent: (ev) => runEventBus.publish(runId, ev),
        });
      })().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        // Failed before the ledger opened: close off the bus or the viewer hangs.
        runEventBus.publish(runId, { type: 'run.end', ok: false, error: message });
        logger.warn(`${opts.triggerKind} ${automationRef} failed: ` + message);
      });
    };
    // One persistent in-process cron scheduler for the gateway's lifetime
    // (issue #149). `reconcileScheduler()` (boot + every publish/delete)
    // settles its in-memory registry; it fires cron automations through the
    // same `fireAutomation` path as run-now. Injectable for tests.
    scheduler =
      options.scheduler ??
      new InProcessScheduler({
        fire: (ref) => fireAutomation(ref, { triggerKind: 'scheduled', triggerOrigin: 'cron' }),
        onError: (err, ref) =>
          logger.warn(
            `scheduled ${ref} failed: ` + (err instanceof Error ? err.message : String(err)),
          ),
      });
    // Drop an app from the registry AND delete its wrapper dir
    // (`<appsDir>/<id>/` — data.sqlite + run ledgers). Mirrors the legacy
    // `registry-deregister` route so deleting an app over the git-store
    // surface doesn't strand per-app data that a recreated id would inherit.
    // The code on `main` is already gone (`store.deleteApp`).
    const deregisterAndCleanup = async (appId: string): Promise<void> => {
      const removed = await runtime.registry.deregister(appId);
      if (removed) await cleanupDeregisteredApp(paths.appsDir, removed, logger);
    };
    extraHandlers.push(
      makeAppsStoreRouteHandler(store, {
        onAppLive: async (appId) => {
          await runtime.registry.ensureUploaded(appId);
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
      // Stages into a session worktree (the draft); `publish:true` merges
      // onto `main` + reconciles the scheduler. Webhook secrets minted here.
      makeLifecycleRouteHandler({
        store,
        codeAppsDir,
        ...(paths.templatesCacheDir ? { templatesCacheDir: paths.templatesCacheDir } : {}),
        ensureRegistered: async (appId) => {
          await runtime.registry.ensureUploaded(appId);
        },
        deregister: deregisterAndCleanup,
        reconcile: reconcileScheduler,
        liveDataFile,
      }),
      // Automation runtime ops over HTTP (issue #141): list/read/run-now,
      // the run feed + per-run detail, and insights. Run-now fires on
      // THIS host with the gateway's own runner config.
      makeAutomationsRouteHandler({
        store,
        dataAppsDir: paths.appsDir,
        analytics: analyticsStore,
        insights: new InsightsStore(analyticsProvider),
        runAutomation: ({ automationRef, runId }) =>
          fireAutomation(automationRef, {
            runId,
            triggerKind: 'manual',
            triggerOrigin: 'manual',
          }),
        subscribeRunEvents: (runId, listener) => runEventBus.subscribe(runId, listener),
      }),
    );
  }

  // `composedHandler` replays the chain `startRuntimeHttpServer` runs
  // (app-engine http-server.ts:135-147) — chat-history → user-store →
  // extra handlers → `runtime.handle` — but WITHOUT the bearer check, for
  // hosts that own auth (OpenClaw's `auth: 'gateway'`). CORS is the host's
  // job too: a fronting gateway emits its own.
  const chatHistoryHandler = makeChatHistoryRouteHandler(() => chatHistoryStore);
  const userStoreHandler = makeUserStoreRouteHandler(() => userStore);
  const composedHandler: RouteHandler = async (req, res) => {
    const url = req.url ?? '';
    if (url.startsWith(CHAT_HISTORY_PREFIX) && (await chatHistoryHandler(req, res))) return true;
    if (url.startsWith(USER_STORE_PREFIX) && (await userStoreHandler(req, res))) return true;
    for (const handler of extraHandlers) {
      if (await handler(req, res)) return true;
    }
    await runtime.handle(req, res);
    return true;
  };

  const start = async (publicBaseUrl: string): Promise<void> => {
    // Publish the live origin to the unified chat runner so post-turn
    // webhook minting can build absolute `_centraid-hook` URLs.
    serverUrl = publicBaseUrl;
    await runtime.bootstrap();

    // Git-store sync: every app present on `main` gets a registry entry
    // so `registry.get(id)` resolves and its data dir (`<appsDir>/<id>/`,
    // where data.sqlite lives) exists. Code is served from the worktree
    // via the override; this only bookkeeps existence + the data dir.
    if (appsStore) {
      for (const appId of await appsStore.listApps()) {
        await runtime.registry.ensureUploaded(appId);
      }
    }

    // Start the in-process cron scheduler and settle it with disk. Under
    // n8n semantics it only fires while running — downtime is not
    // backfilled (issue #149).
    scheduler?.start();
    reconcileScheduler();
  };

  const stop = async (): Promise<void> => {
    await scheduler?.stop();
  };

  return {
    runtime,
    userStore,
    analyticsStore,
    chatHistoryStore,
    ...(appsStore ? { appsStore } : {}),
    extraHandlers,
    composedHandler,
    start,
    stop,
  } satisfies BuiltGateway;
}
