import path from 'node:path';
import { promises as fs } from 'node:fs';
import { app } from 'electron';
import {
  ChatHistoryStore,
  Runtime,
  UserStore,
  makeGatewayDbProvider,
  startRuntimeHttpServer,
  type RuntimeHttpServerHandle,
} from '@centraid/runtime-core';
import {
  makeChatRunner,
  runPreflight,
  invalidatePreflightCache,
  type RunnerPrefs,
} from '@centraid/agent-runtime';

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
 * Path of the single SQLite file that holds every per-user gateway record
 * (identity, prefs, chat sessions, chat messages). Lives next to (not
 * inside) the appsDir so it stays out of every individual app's data and
 * is never reachable from the centraid_sql_* tools. Mirrors the OpenClaw
 * plugin's placement.
 */
export function localRuntimeGatewayDb(): string {
  return path.join(app.getPath('userData'), 'local-runtime', 'centraid-gateway.sqlite');
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
      return {
        kind,
        ...(binPath ? { binPath } : {}),
        ...(extraArgs ? { extraArgs } : {}),
      };
    };
    const chatRunner = makeChatRunner({ prefsLoader });

    const runtime = new Runtime({
      appsDir,
      userStore,
      chatHistoryStore,
      chatRunner,
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

    const server = await startRuntimeHttpServer({ runtime });
    await runtime.bootstrap();

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
