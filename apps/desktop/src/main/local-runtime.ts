import { promises as fs } from 'node:fs';
import {
  AnalyticsStore,
  ChatHistoryStore,
  Runtime,
  UserStore,
  listAutomations,
  makeGatewayDbProvider,
  makeAnalyticsDbProvider,
  startRuntimeHttpServer,
  type AutomationHost,
  type RuntimeHttpServerHandle,
} from '@centraid/runtime-core';
import {
  defaultCentraidCliDir,
  makeChatRunner,
  runPreflight,
  invalidatePreflightCache,
  OsSchedulerHost,
  type RunnerPrefs,
  type OpenAICompatProvider,
} from '@centraid/agent-runtime';
import path from 'node:path';
import { getProviderApiKey } from './provider-secrets.js';
import {
  gatewayAnalyticsDb,
  gatewayAppsDir,
  gatewayChatRunnerSessionsDir,
  gatewayCodexHomeBaseDir,
  gatewayIdentityDb,
  LOCAL_GATEWAY_ID,
} from './gateway-paths.js';
import { setLocalRuntimeInfoProvider } from './gateway-store.js';

/**
 * In-process runtime embedded inside the Electron main process. Spawned
 * lazily the first time someone asks for its URL; idempotent.
 *
 * Auth: a per-launch random bearer token is minted by runtime-core's HTTP
 * server. The token is handed back to the renderer as the effective
 * `gatewayToken` so the renderer's existing HTTP client uses it on every
 * request — same wire format as remote OpenClaw mode.
 *
 * Lifetime: stays up for the lifetime of the Electron main process. There
 * is no need to stop and restart on settings save — switching to remote
 * mode just changes which URL the renderer reads.
 */

let handle: RuntimeHttpServerHandle | undefined;
let starting: Promise<RuntimeHttpServerHandle> | undefined;

/**
 * Local gateway storage directory — `<userData>/gateways/local/apps/`
 * (versioned; the in-process gateway writes here when the desktop
 * publishes a workspace). The home shelf + preview protocol + dispatcher
 * all read from here. Per-gateway after #109 (workspace + apps namespace
 * by gateway so the same id can mean different artifacts on different
 * accounts).
 */
export async function localRuntimeAppsDir(): Promise<string> {
  return gatewayAppsDir(LOCAL_GATEWAY_ID);
}

/**
 * Parent directory under which provider-scoped `CODEX_HOME`s are
 * materialized when the user has configured a custom OpenAI-compatible
 * provider on the codex runner. Per-gateway because codex stores
 * thread state under `CODEX_HOME`, and conversations on different
 * gateways should not commingle.
 */
export function localRuntimeCodexHomeBaseDir(): string {
  return gatewayCodexHomeBaseDir(LOCAL_GATEWAY_ID);
}

/**
 * Identity SQLite for the local gateway (users + prefs). The remote
 * gateway has its own identity store server-side; we don't keep a
 * local mirror in v0. Per-gateway layout is consistent across
 * gateway kinds (the slot just stays empty for remote).
 */
export function localRuntimeGatewayDb(): string {
  return gatewayIdentityDb(LOCAL_GATEWAY_ID);
}

/**
 * Central run-summary DB for the local gateway — the source the
 * Insights screen reads. Remote gateways track their own analytics
 * server-side; a "show me runs across gateways" view is post-v0.
 */
export function localRuntimeAnalyticsDb(): string {
  return gatewayAnalyticsDb(LOCAL_GATEWAY_ID);
}

/**
 * Singleton OS-scheduler-backed AutomationHost for the local runtime.
 *
 * Lazy: built on first read so we don't shell out to the OS scheduler
 * before anyone actually toggled an automation. Model-B automations are
 * user-owned, not app-scoped — the job's working directory is just the
 * apps dir, and the CLI's `run-automation` loads the manifest from the
 * activity DB by UUID.
 *
 * `centraidBin` points at the bundled CLI script. The script ships
 * with the agent-runtime dist; we resolve via `defaultCentraidCliDir`
 * to stay agnostic to electron-builder unpacking layout. Caller is
 * expected to ensure the file is executable (see CLI install hooks).
 */
let _automationHost: AutomationHost | undefined;
export function localRuntimeAutomationHost(appsDir: string): AutomationHost {
  if (_automationHost) return _automationHost;
  _automationHost = new OsSchedulerHost({
    workdir: appsDir,
    centraidBin: path.join(defaultCentraidCliDir(), 'centraid-cli.js'),
    // Bake the desktop's analytics DB path + apps dir into every
    // scheduled job so an OS-scheduler-spawned `centraid run-automation`
    // resolves the automation + write-throughs its run summary against
    // the SAME paths the desktop UI uses — not the cwd-relative fallback.
    analyticsDbPath: localRuntimeAnalyticsDb(),
    appsDir,
    // Match the chat-runner default; toggling per-automation runner
    // isn't surfaced in the UI today.
    runner: 'codex',
  });
  return _automationHost;
}

export async function ensureLocalRuntime(): Promise<RuntimeHttpServerHandle> {
  if (handle) return handle;
  if (starting) return starting;
  starting = (async () => {
    const appsDir = await localRuntimeAppsDir();
    await fs.mkdir(appsDir, { recursive: true });

    // Gateway identity DB + the central analytics DB (one run-summary
    // row per run — issue #98). Each store wraps a lazy provider that
    // opens its file on first use. Chat sessions + chat runs live in
    // each app's `runtime.sqlite` under `appsDir`, so `ChatHistoryStore`
    // is constructed with `appsDir` and resolves the file per app.
    const gatewayDbProvider = makeGatewayDbProvider(localRuntimeGatewayDb());
    const analyticsStore = new AnalyticsStore(makeAnalyticsDbProvider(localRuntimeAnalyticsDb()));
    const userStore = new UserStore(gatewayDbProvider);
    const chatHistoryStore = new ChatHistoryStore(
      appsDir,
      () => userStore.getUserId(),
      analyticsStore,
    );

    // Resolve user prefs for the agent runtime — the desktop persists
    // the user's CLI choice (codex / claude-code) + optional override path
    // in the gateway user_prefs row. Loader runs per turn so a settings
    // flip is picked up without an Electron restart.
    const prefsLoader = async (): Promise<RunnerPrefs | undefined> => {
      const allPrefs = userStore.getAllPrefs();
      const kindRaw = allPrefs['agent.runner.kind'];
      // Codex is the preferred default when the user hasn't explicitly
      // picked a runner (the AI providers panel surfaces "Codex preferred
      // when both are present"). Falling back here means a fresh install
      // with imported codex creds Just Works without an extra settings hop.
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
      // Prefs come from the local gateway's identity DB; the matching
      // provider API key sits in the local gateway's keychain slot.
      const provider = await resolveProviderPrefs(allPrefs, LOCAL_GATEWAY_ID);
      return {
        kind,
        ...(binPath ? { binPath } : {}),
        ...(extraArgs ? { extraArgs } : {}),
        ...(provider ? { provider } : {}),
      };
    };
    // We need the runtime to construct the change emitter, but the chat
    // runner needs to be passed to the runtime constructor. Use a holder
    // that the chat-adapter resolves at call time so the cycle is broken.
    let runtimeRef: Runtime | undefined;
    const chatRunner = makeChatRunner({
      prefsLoader,
      getChangeEmitter: (appId) => {
        const rt = runtimeRef;
        if (!rt) return () => undefined;
        return rt.agentEmitForApp(appId);
      },
      codexHomeBaseDir: localRuntimeCodexHomeBaseDir(),
    });

    const runtime = new Runtime({
      appsDir,
      userStore,
      chatHistoryStore,
      chatRunner,
      chatRunnerSessionDir: gatewayChatRunnerSessionsDir(LOCAL_GATEWAY_ID),
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
      logger: {
        info: (m) => console.info(`[local-runtime] ${m}`),
        warn: (m) => console.warn(`[local-runtime] ${m}`),
        error: (m) => console.error(`[local-runtime] ${m}`),
      },
    });

    runtimeRef = runtime;
    const server = await startRuntimeHttpServer({ runtime });
    await runtime.bootstrap();

    // Startup reconcile: catch up the OS scheduler on anything that
    // changed while the desktop was closed (a stale plist orphaned by
    // an uninstall, an automation toggled elsewhere, etc.).
    // Fire-and-forget so a slow scheduler shell-out doesn't block start.
    void (async () => {
      const dir = await localRuntimeAppsDir();
      const { rows } = await listAutomations(dir);
      return localRuntimeAutomationHost(dir).reconcile(rows);
    })()
      .then((diff) => {
        if (diff.added.length || diff.updated.length || diff.removed.length) {
          console.info(
            `[local-runtime] OS scheduler startup reconcile — ` +
              `added=${diff.added.length} updated=${diff.updated.length} removed=${diff.removed.length}`,
          );
        }
      })
      .catch((err) =>
        console.warn(
          `[local-runtime] OS scheduler startup reconcile failed: ` +
            (err instanceof Error ? err.message : String(err)),
        ),
      );

    handle = server;
    // Publish the local gateway's effective URL+token to the
    // gateway-store so `resolveGateway('local')` returns them. The
    // store snapshots through this getter on every call rather than
    // caching, so a future restart cleanly invalidates.
    setLocalRuntimeInfoProvider(() =>
      handle ? { url: handle.url, token: handle.token } : undefined,
    );
    return handle;
  })().finally(() => {
    starting = undefined;
  });
  return starting;
}

export async function shutdownLocalRuntime(): Promise<void> {
  if (!handle) return;
  const h = handle;
  handle = undefined;
  await h.close().catch(() => undefined);
}

/**
 * Called by the settings-save IPC handler when the user's `agent.runner.*`
 * prefs may have changed. The preflight result is cached in-memory by
 * `@centraid/agent-runtime`; invalidating forces the next status
 * read to re-probe `--version`.
 */
export function noteRunnerPrefsChanged(): void {
  invalidatePreflightCache();
}

/**
 * Parse `agent.runner.provider.*` keys out of the user_prefs blob.
 * Does NOT include the API key — that lives in `safeStorage` and is
 * spliced in by `resolveProviderPrefs` (the async wrapper).
 *
 * Exported so the builder-side IPC handler in `ipc.ts` can share the
 * same parsing logic.
 */
export function parseProviderPrefs(
  prefs: Record<string, unknown>,
): Omit<OpenAICompatProvider, 'apiKey'> | undefined {
  const id = readStringPref(prefs, 'agent.runner.provider.id');
  const baseUrl = readStringPref(prefs, 'agent.runner.provider.baseUrl');
  if (!id || !baseUrl) return undefined;
  const name = readStringPref(prefs, 'agent.runner.provider.name') ?? id;
  const wireRaw = readStringPref(prefs, 'agent.runner.provider.wireApi');
  const wireApi: 'chat' | 'responses' | undefined =
    wireRaw === 'chat' || wireRaw === 'responses' ? wireRaw : undefined;
  const envKey = readStringPref(prefs, 'agent.runner.provider.envKey');
  return {
    id,
    name,
    baseUrl,
    ...(wireApi ? { wireApi } : {}),
    ...(envKey ? { envKey } : {}),
  };
}

/**
 * Build a complete `OpenAICompatProvider` by combining the user_prefs-side
 * config with the safeStorage-side API key. Used by the prefs loader on
 * every turn; the safeStorage read is cheap (a single file decrypt).
 *
 * `gatewayId` scopes both halves of the provider — the prefs the
 * caller passes in already came from that gateway's identity DB (or
 * its remote `/_centraid-user/*` equivalent), and the key here is
 * read from `<userData>/gateways/<id>/provider-key.bin`. Together
 * they keep "provider config and its API key" matched per-gateway
 * even when the user has different providers configured on different
 * gateways.
 *
 * If the user configured `envKey` but the safeStorage slot is empty,
 * the returned provider has no `apiKey`. The codex adapter will still
 * launch — and the first model call will surface a 401 from the
 * provider, which the chat panel renders as a normal error.
 */
export async function resolveProviderPrefs(
  prefs: Record<string, unknown>,
  gatewayId: string,
): Promise<OpenAICompatProvider | undefined> {
  const base = parseProviderPrefs(prefs);
  if (!base) return undefined;
  if (!base.envKey) return base;
  const apiKey = await getProviderApiKey(gatewayId);
  return apiKey ? { ...base, apiKey } : base;
}

function readStringPref(prefs: Record<string, unknown>, key: string): string | undefined {
  const v = prefs[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
