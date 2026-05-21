import path from 'node:path';
import { promises as fs } from 'node:fs';
import { app } from 'electron';
import {
  ChatHistoryStore,
  Runtime,
  UserStore,
  listAutomationProjects,
  makeGatewayDbProvider,
  makeActivityDbProvider,
  startRuntimeHttpServer,
  type AutomationHost,
  type RuntimeHttpServerHandle,
} from '@centraid/runtime-core';
import { loadPersistedSettings } from './settings.js';
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
 * Paths of the two domain SQLite files — identity (users + prefs) and
 * the activity ledger (automations, chat_sessions, runs, run_nodes).
 * They live next to (not inside) the appsDir so they stay out of every
 * individual app's data and are never reachable from the centraid_sql_*
 * tools. Mirrors the OpenClaw plugin's placement.
 */
export function localRuntimeGatewayDb(): string {
  return path.join(app.getPath('userData'), 'local-runtime', 'centraid-gateway.sqlite');
}

export function localRuntimeAutomationDb(): string {
  return path.join(app.getPath('userData'), 'local-runtime', 'centraid-activity.sqlite');
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
export function localRuntimeAutomationHost(automationsDir: string): AutomationHost {
  if (_automationHost) return _automationHost;
  _automationHost = new OsSchedulerHost({
    workdir: localRuntimeAppsDir(),
    centraidBin: path.join(defaultCentraidCliDir(), 'centraid-cli.js'),
    // Bake the desktop's activity DB path + automations dir into every
    // scheduled job so an OS-scheduler-spawned `centraid run-automation`
    // resolves the project + writes its run record against the SAME
    // paths the desktop UI uses — not the cwd-relative fallback.
    automationDbPath: localRuntimeAutomationDb(),
    automationsDir,
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

    // Two domain SQLite files — identity and the activity ledger. Each
    // store wraps the lazy provider for its file; the provider opens the
    // file on first use (lazy because nothing here touches the DB until
    // a request hits the HTTP server). The chat-history store and the
    // automation stores all share the activity provider.
    const gatewayDbProvider = makeGatewayDbProvider(localRuntimeGatewayDb());
    const automationDbProvider = makeActivityDbProvider(localRuntimeAutomationDb());
    const userStore = new UserStore(gatewayDbProvider);
    const chatHistoryStore = new ChatHistoryStore(automationDbProvider, () =>
      userStore.getUserId(),
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

    const runtime = new Runtime({
      appsDir,
      userStore,
      chatHistoryStore,
      chatRunner,
      chatRunnerSessionDir: path.join(
        app.getPath('userData'),
        'local-runtime',
        'chat-runner-sessions',
      ),
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
      const { projectsDir } = await loadPersistedSettings();
      const automationsDir = path.join(projectsDir, 'automations');
      const { rows } = await listAutomationProjects(automationsDir);
      return localRuntimeAutomationHost(automationsDir).reconcile(rows);
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
