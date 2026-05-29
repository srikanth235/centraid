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
 *   8. Fire-and-forget OS-scheduler reconcile, if the caller passed a
 *      `schedulerHostFactory`.
 *
 * Behavior matches the previous Electron path exactly. The only thing
 * the caller injects is paths + secrets + an optional scheduler factory.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AnalyticsStore,
  ChatHistoryStore,
  InsightsStore,
  Runtime,
  UserStore,
  listAutomations,
  makeGatewayDbProvider,
  makeAnalyticsDbProvider,
  startRuntimeHttpServer,
  type AutomationHost,
  type RuntimeLogger,
} from '@centraid/runtime-core';
import {
  makeChatRunner,
  runAutomationLocal,
  runPreflight,
  type OpenAICompatProvider,
  type RunnerPrefs,
} from '@centraid/agent-runtime';
import { AppsStore } from '@centraid/apps-store';
import { makeAppsStoreRouteHandler } from './apps-store-routes.js';
import { makeAutomationsRouteHandler } from './automations-routes.js';
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
   * When provided, `serve()` kicks off a fire-and-forget OS-scheduler
   * reconcile on boot — catches up the host scheduler with any
   * automations toggled while the runtime was down. The factory is
   * invoked once with the resolved code + data dirs: `codeAppsDir` is
   * where automation manifests/handlers live (the git-store `active-main`
   * symlink when `appsStoreRoot` is set, else `paths.appsDir`), and
   * `dataAppsDir` is `paths.appsDir` (run ledgers). Omit for tests and
   * the daemon's v0 PoC (no scheduler).
   */
  schedulerHostFactory?: (dirs: { codeAppsDir: string; dataAppsDir: string }) => AutomationHost;
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
  appsStore?: AppsStore;
}

export async function serve(options: ServeOptions): Promise<GatewayServeHandle> {
  const { paths, secrets, schedulerHostFactory } = options;
  const logger = options.logger ?? defaultLogger(options.logTag);

  await fs.mkdir(paths.appsDir, { recursive: true });

  // Git-store backend (issue #137). When a root is given, the gateway
  // owns app code as a bare git repo + worktrees; the runtime serves
  // handlers from the live `main` worktree. Constructed + initialized
  // here so the code-dir override is available at Runtime construction.
  let appsStore: AppsStore | undefined;
  if (options.appsStoreRoot !== undefined) {
    appsStore = new AppsStore({ root: options.appsStoreRoot });
    await appsStore.init();
  }
  const codeDirOverride = appsStore
    ? (appId: string) => appsStore!.resolveActiveAppDir(appId)
    : undefined;
  // Draft preview (issue #141): resolve an app's code dir to its OPEN
  // session worktree (`worktrees/sessions/<id>/apps/<app>/`) so the
  // runtime can serve the staged draft — static + handlers — before it's
  // published. Data still binds to the registry entry's dir, so the draft
  // reads/writes the live `data.sqlite`. Returns `undefined` for an
  // unknown/closed session (→ 503), so the live path is unaffected.
  const draftCodeDir = appsStore
    ? async (appId: string, sessionId: string): Promise<string | undefined> => {
        try {
          return await appsStore!.snapshotSessionAppDir(sessionId, appId);
        } catch {
          return undefined;
        }
      }
    : undefined;

  // OS-scheduler reconcile (issue #141). Automation *code* lives under
  // the git-store materialized `main` (`active-main/apps`), or `appsDir`
  // for the flat/legacy layout. We re-scan + reconcile the whole desired
  // set (idempotent) rather than register single rows, so a publish /
  // delete / rollback over HTTP keeps the scheduler in sync for BOTH the
  // local embedded gateway and a remote one. Fire-and-forget — a publish
  // response must not block on a launchd/systemd shell-out — with a
  // coalescing guard so concurrent publishes don't thrash the scheduler.
  const schedulerCodeAppsDir = (): string =>
    appsStore ? path.join(appsStore.getActiveMainLink(), 'apps') : paths.appsDir;
  let reconcileInFlight = false;
  let reconcileDirty = false;
  const reconcileScheduler = (): void => {
    if (!schedulerHostFactory) return;
    if (reconcileInFlight) {
      reconcileDirty = true;
      return;
    }
    reconcileInFlight = true;
    void (async () => {
      do {
        reconcileDirty = false;
        const codeAppsDir = schedulerCodeAppsDir();
        const { rows } = await listAutomations(codeAppsDir);
        const diff = await schedulerHostFactory({
          codeAppsDir,
          dataAppsDir: paths.appsDir,
        }).reconcile(rows);
        if (diff.added.length || diff.updated.length || diff.removed.length) {
          logger.info(
            `OS scheduler reconcile — ` +
              `added=${diff.added.length} updated=${diff.updated.length} removed=${diff.removed.length}`,
          );
        }
      } while (reconcileDirty);
    })()
      .catch((err) =>
        logger.warn(
          `OS scheduler reconcile failed: ` + (err instanceof Error ? err.message : String(err)),
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
  const chatRunner = makeChatRunner({
    prefsLoader,
    getDispatcher: () => {
      const rt = runtimeRef;
      if (!rt) throw new Error('chat runner invoked before runtime was constructed');
      return rt.dispatcher;
    },
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
  if (appsStore) {
    const store = appsStore;
    const codeAppsDir = (): string => path.join(store.getActiveMainLink(), 'apps');
    serverOptions.extraHandlers = [
      makeAppsStoreRouteHandler(store, {
        onAppLive: async (appId) => {
          await runtime.registry.ensureUploaded(appId);
          // A publish/rollback may have added/removed/toggled an
          // automation — resync the OS scheduler off the new `main`.
          reconcileScheduler();
        },
        onAppDeleted: async (appId) => {
          await runtime.registry.deregister(appId);
          reconcileScheduler();
        },
      }),
      // Automation runtime ops over HTTP (issue #141): list/read/run-now,
      // the run feed + per-run detail, and insights. Run-now fires on
      // THIS host with the gateway's own runner config.
      makeAutomationsRouteHandler({
        store,
        dataAppsDir: paths.appsDir,
        analytics: analyticsStore,
        insights: new InsightsStore(analyticsProvider),
        runAutomation: ({ automationRef, runId }) => {
          void (async () => {
            const prefs = await prefsLoader();
            await runAutomationLocal({
              automationRef,
              runId,
              appsDir: paths.appsDir,
              codeAppsDir: codeAppsDir(),
              analytics: analyticsStore,
              runner: prefs?.kind ?? 'codex',
              triggerKind: 'manual',
              triggerOrigin: 'manual',
            });
          })().catch((err) =>
            logger.warn(
              `run-now ${automationRef} failed: ` +
                (err instanceof Error ? err.message : String(err)),
            ),
          );
        },
      }),
    ];
  }
  const server = await startRuntimeHttpServer(serverOptions);
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

  // Startup reconcile: catch up the OS scheduler on anything that
  // changed while the runtime was down (it's also the backstop for any
  // publish that landed while a local gateway was shut down). Uses the
  // same coalesced, fire-and-forget reconcile the publish path triggers.
  reconcileScheduler();

  return {
    url: server.url,
    token: server.token,
    close: server.close,
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
