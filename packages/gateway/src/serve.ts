/*
 * `serve()` — boot a centraid gateway against injected paths + secrets.
 *
 * This is the host-agnostic lift of what `apps/desktop/src/main/local-
 * runtime.ts` used to do inline. Three callers plug in their own
 * `GatewayPaths` + `SecretsProvider`:
 *
 *   - Electron embed: paths derived from `gateway-paths.ts`, secrets
 *     read from `safeStorage`.
 *   - `centraid-gateway` daemon: paths derived from a `--data-dir`
 *     config, secrets from a sealed file on disk.
 *   - Tests: paths under a tempdir, secrets stubbed to "no key".
 *
 * What `serve()` does, in order:
 *   1. mkdir `appsDir`
 *   2. Construct the gateway DB / analytics / user / chat-history stores
 *      (lazy file open underneath).
 *   3. Build a prefs loader closure that re-reads user_prefs per turn.
 *   4. Construct `makeChatRunner` against the loader and a runtimeRef
 *      cycle-break (the chat runner needs the dispatcher, the dispatcher
 *      lives on the Runtime, the Runtime needs the chat runner — the
 *      ref-holder breaks the cycle).
 *   5. Construct `Runtime` and pass it the runner + stores.
 *   6. Start an HTTP server in front of it via
 *      `startRuntimeHttpServer`.
 *   7. Call `runtime.bootstrap()` to load the registry and recover any
 *      torn version metadata.
 *   8. Start the in-process cron scheduler and reconcile it with the
 *      automations currently on disk (issue #149).
 *
 * The only thing the caller injects is paths + secrets (+ an optional
 * scheduler, for tests).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ChatHistoryStore,
  Runtime,
  UserStore,
  cleanupDeregisteredApp,
  makeGatewayDbProvider,
  startRuntimeHttpServer,
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
  type OpenAICompatProvider,
  type RunnerPrefs,
} from '@centraid/agent-runtime';
import { WorktreeStore } from '@centraid/worktree-store';
import { makeAppsStoreRouteHandler } from './apps-store-routes.js';
import { makeDraftCodeDirResolver } from './draft-data.js';
import { makeAutomationsRouteHandler } from './automations-routes.js';
import { makeLifecycleRouteHandler } from './lifecycle-routes.js';
import { makeUnifiedChatRunner } from './unified-chat-runner.js';
import { makeTemplatesRouteHandler } from './templates-routes.js';
import type { GatewayPaths } from './paths.js';
import type { SecretsProvider } from './secrets.js';
import { parseProviderPrefs } from './provider-prefs.js';

export interface ServeOptions {
  /** On-disk slots the runtime reads/writes. Caller-derived. */
  paths: GatewayPaths;
  /** Pluggable secret reader for the OpenAI-compatible provider API key. */
  secrets: SecretsProvider;
  /** HTTP bind host. Defaults to `127.0.0.1` (loopback). */
  host?: string;
  /** HTTP port. `0` (default) asks the OS for an ephemeral port. */
  port?: number;
  /**
   * Pre-shared bearer token. When omitted, `startRuntimeHttpServer` mints
   * a random 32-byte hex token. The Electron embed lets this be random
   * per-launch; the daemon persists one across restarts.
   */
  token?: string;
  /**
   * On boot, `serve()` starts the cron scheduler and reconciles it with the
   * automations currently on disk.
   *
   * The scheduler (issue #149) is gateway-owned and in-process: while
   * `serve()` runs, a single minute-boundary timer fires enabled cron
   * automations through the same `runAutomationLocal` path as "run now".
   * There is no OS scheduler; missed minutes during downtime are skipped
   * (n8n semantics — no backfill). Defaults to a fresh `InProcessScheduler`;
   * inject one (e.g. a spy) only for tests.
   */
  scheduler?: LocalScheduler;
  /** Logger forwarded to `Runtime`. Defaults to a `console.*` wrapper. */
  logger?: RuntimeLogger;
  /**
   * Tag prepended to log lines emitted by `serve()`'s own bootstrap
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

export interface GatewayServeHandle {
  /** Bound base URL — `http://<host>:<port>`. */
  url: string;
  /** Bearer token the renderer must send on every request. */
  token: string;
  /** Stop the HTTP server. Idempotent in callers. */
  close(): Promise<void>;
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
}

export async function serve(options: ServeOptions): Promise<GatewayServeHandle> {
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

  // Per-turn prefs loader. Reads the gateway user_prefs row on every
  // chat turn so a settings change is picked up without a restart. The
  // API key is spliced in from the injected `secrets` provider so the
  // Electron and daemon callers each plug their own backend (safeStorage
  // vs. sealed file).
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

  const serverOptions: Parameters<typeof startRuntimeHttpServer>[0] = { runtime };
  if (options.host !== undefined) serverOptions.host = options.host;
  if (options.port !== undefined) serverOptions.port = options.port;
  if (options.token !== undefined) serverOptions.token = options.token;
  // Mount the git-store publish/session/files surface ahead of the
  // runtime's own routes when a store backend is active (issue #137).
  // onAppLive registers a freshly-published app in the registry so its
  // data dir exists + `registry.get` resolves on the first request.
  //
  // Code (automation manifests) resolves from the git-store materialized
  // `main`; data (run ledgers + analytics) from the stable `appsDir`.
  // Template catalog (issue #141): the gateway owns it now, so the
  // renderer reads `GET /centraid/_templates` directly. Mounted regardless
  // of the code backend — templates are bundle/cache-resolved, independent
  // of the git store.
  const extraHandlers: Array<
    (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ) => Promise<boolean>
  > = [
    makeTemplatesRouteHandler({
      ...(paths.templatesCacheDir ? { cacheDir: paths.templatesCacheDir } : {}),
      ...(paths.remoteTemplatesUrl ? { remoteTemplatesUrl: paths.remoteTemplatesUrl } : {}),
    }),
  ];

  if (appsStore) {
    const store = appsStore;
    const codeAppsDir = (): string => path.join(store.getActiveMainLink(), 'apps');
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
      void (async () => {
        const prefs = await prefsLoader();
        await runAutomationLocal({
          automationRef,
          ...(opts.runId ? { runId: opts.runId } : {}),
          appsDir: paths.appsDir,
          codeAppsDir: codeAppsDir(),
          analytics: analyticsStore,
          runner: prefs?.kind ?? 'codex',
          triggerKind: opts.triggerKind,
          triggerOrigin: opts.triggerOrigin,
        });
      })().catch((err) =>
        logger.warn(
          `${opts.triggerKind} ${automationRef} failed: ` +
            (err instanceof Error ? err.message : String(err)),
        ),
      );
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
      }),
    );
  }
  serverOptions.extraHandlers = extraHandlers;
  const server = await startRuntimeHttpServer(serverOptions);
  // Publish the live origin to the unified chat runner so post-turn webhook
  // minting can build absolute `_centraid-hook` URLs.
  serverUrl = server.url;
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

  // Start the in-process cron scheduler and settle it with whatever is on
  // disk. Under n8n semantics the scheduler only fires while running, so
  // anything toggled during downtime is picked up here but past missed
  // fires are not backfilled (issue #149).
  scheduler?.start();
  reconcileScheduler();

  return {
    url: server.url,
    token: server.token,
    // Stop the cron timer before the HTTP server so no fire is dispatched
    // mid-teardown.
    close: async () => {
      await scheduler?.stop();
      await server.close();
    },
    runtime,
    userStore,
    analyticsStore,
    chatHistoryStore,
    ...(appsStore ? { appsStore } : {}),
  } satisfies GatewayServeHandle;
}

async function resolveProvider(
  prefs: Record<string, unknown>,
  secrets: SecretsProvider,
): Promise<OpenAICompatProvider | undefined> {
  const base = parseProviderPrefs(prefs);
  if (!base) return undefined;
  if (!base.envKey) return base;
  const apiKey = await secrets.getProviderApiKey();
  return apiKey ? { ...base, apiKey } : base;
}

function defaultLogger(tag?: string): RuntimeLogger {
  const prefix = tag ? `[${tag}] ` : '';
  return {
    info: (m) => console.info(`${prefix}${m}`),
    warn: (m) => console.warn(`${prefix}${m}`),
    error: (m) => console.error(`${prefix}${m}`),
  };
}
