import path from 'node:path';
import { promises as fs } from 'node:fs';
import { app } from 'electron';
import {
  AutomationStore,
  ChatHistoryStore,
  Runtime,
  UserStore,
  makeGatewayDbProvider,
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
import { getProviderApiKey } from './provider-secrets.js';

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

export function localRuntimeAppsDir(): string {
  return path.join(app.getPath('userData'), 'local-runtime', 'apps');
}

/**
 * Parent directory under which provider-scoped `CODEX_HOME`s are
 * materialized when the user has configured a custom OpenAI-compatible
 * provider on the codex runner. Stable across launches so codex thread
 * state survives. Sibling to `apps/` and the gateway DB so all
 * local-runtime-generated state lives under one tree.
 */
export function localRuntimeCodexHomeBaseDir(): string {
  return path.join(app.getPath('userData'), 'local-runtime');
}

/**
 * Path of the single SQLite file that holds every per-user gateway record
 * (identity, prefs, chat sessions, chat messages). Lives next to (not
 * inside) the appsDir so it stays out of every individual app's data and
 * is never reachable from the centraid_sql_* tools. Mirrors the OpenClaw
 * plugin's placement.
 */
export function localRuntimeGatewayDb(): string {
  return path.join(app.getPath('userData'), 'local-runtime', 'centraid-gateway.sqlite');
}

/**
 * Singleton OS-scheduler-backed AutomationHost for the local runtime.
 *
 * Lazy: built on first read so we don't shell out to the OS scheduler
 * before anyone actually toggled an automation. The host writes
 * launchd plists / systemd timers / Task Scheduler tasks with
 * `cwd = localRuntimeAppsDir()/<appId>` (the persistent app root that
 * survives publishes — the CLI's `run-automation` re-resolves the
 * active version inside it on each fire).
 *
 * `centraidBin` points at the bundled CLI script. The script ships
 * with the agent-runtime dist; we resolve via `defaultCentraidCliDir`
 * to stay agnostic to electron-builder unpacking layout. Caller is
 * expected to ensure the file is executable (see CLI install hooks).
 */
let _automationHost: AutomationHost | undefined;
export function localRuntimeAutomationHost(): AutomationHost {
  if (_automationHost) return _automationHost;
  _automationHost = new OsSchedulerHost({
    resolveAppDir: (appId) => path.join(localRuntimeAppsDir(), appId),
    centraidBin: path.join(defaultCentraidCliDir(), 'centraid-cli.js'),
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
    const appsDir = localRuntimeAppsDir();
    await fs.mkdir(appsDir, { recursive: true });

    // One SQLite file holds every per-user gateway record. Both stores
    // wrap the same lazy provider so they share one connection (real FK
    // from `chat_sessions.user_id` to `users.id`, single migration ladder,
    // single backup target). The provider opens the file on first use —
    // lazy because nothing here actually touches the DB until a request
    // hits the HTTP server.
    const gatewayDbProvider = makeGatewayDbProvider(localRuntimeGatewayDb());
    const userStore = new UserStore(gatewayDbProvider);
    const chatHistoryStore = new ChatHistoryStore(gatewayDbProvider, () => userStore.getUserId());
    // Shared mirror for centraid automations (issue #70). The same
    // store backs the IPC handlers in `ipc.ts` and the upload-time
    // sync wired through `handleAppUpload` — every publish lands new
    // manifests here and the UI reads from this surface.
    const automationStore = new AutomationStore(gatewayDbProvider);

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
      const provider = await resolveProviderPrefs(allPrefs);
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

    // OS-scheduler host (launchd / systemd / Task Scheduler). Same
    // shape as openclaw's cron host in remote mode — see
    // `OsSchedulerHost` and `AutomationHost`. Built once, shared with
    // the IPC handlers via the `localRuntimeAutomationHost()` accessor.
    const automationHost = localRuntimeAutomationHost();

    const runtime = new Runtime({
      appsDir,
      userStore,
      chatHistoryStore,
      chatRunner,
      automationStore,
      // On every publish that lands new/changed/removed automation
      // manifests, reconcile the OS scheduler so its installed
      // entries match the just-synced mirror state. Scoped to this
      // app — without `scope.appId`, the host would diff against
      // every centraid-owned entry it knows and sweep every OTHER
      // app's jobs as "absent from desired."
      onAutomationsSynced: async (appId) => {
        try {
          await automationHost.reconcile(automationStore.listByApp(appId), {
            scope: { appId },
          });
        } catch (err) {
          console.warn(
            `[local-runtime] OS scheduler reconcile failed for "${appId}": ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      },
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
    // changed while the desktop was closed (publishes from elsewhere,
    // a stale plist orphaned by an uninstall, etc.). Fire-and-forget
    // so a slow scheduler shell-out doesn't block runtime start.
    void automationHost
      .reconcile(automationStore.listAll())
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
 * If the user configured `envKey` but the safeStorage slot is empty,
 * the returned provider has no `apiKey`. The codex adapter will still
 * launch — and the first model call will surface a 401 from the
 * provider, which the chat panel renders as a normal error.
 */
export async function resolveProviderPrefs(
  prefs: Record<string, unknown>,
): Promise<OpenAICompatProvider | undefined> {
  const base = parseProviderPrefs(prefs);
  if (!base) return undefined;
  if (!base.envKey) return base;
  const apiKey = await getProviderApiKey();
  return apiKey ? { ...base, apiKey } : base;
}

function readStringPref(prefs: Record<string, unknown>, key: string): string | undefined {
  const v = prefs[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
