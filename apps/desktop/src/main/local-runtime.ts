import path from 'node:path';
import { promises as fs } from 'node:fs';
import { app } from 'electron';
import {
  NullScheduler,
  Runtime,
  UserStore,
  startRuntimeHttpServer,
  type RuntimeHttpServerHandle,
  type Scheduler,
} from '@centraid/runtime-core';

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
let scheduler: Scheduler | undefined;

export function localRuntimeAppsDir(): string {
  return path.join(app.getPath('userData'), 'local-runtime', 'apps');
}

/**
 * Path of the single shared chat-history SQLite. Lives next to (not inside)
 * the appsDir so it stays out of every individual app's data and is never
 * reachable from the centraid_sql_* tools. Mirrors the OpenClaw plugin's
 * placement (`<stateDir>/centraid-chat-history.sqlite`).
 */
export function localRuntimeChatHistoryDb(): string {
  return path.join(app.getPath('userData'), 'local-runtime', 'centraid-chat-history.sqlite');
}

/**
 * Path of the single shared user-prefs / user-id SQLite. Sibling of the
 * chat-history db so all gateway-side per-user state lives in one place.
 */
export function localRuntimeUserStoreDb(): string {
  return path.join(app.getPath('userData'), 'local-runtime', 'centraid-user.sqlite');
}

/**
 * Override the scheduler used by the embedded runtime. Must be called before
 * `ensureLocalRuntime()` to take effect; defaults to `NullScheduler` (cron
 * execution for the embedded runtime is on the backlog).
 */
export function setLocalScheduler(s: Scheduler): void {
  scheduler = s;
}

export async function ensureLocalRuntime(): Promise<RuntimeHttpServerHandle> {
  if (handle) return handle;
  if (starting) return starting;
  starting = (async () => {
    const appsDir = localRuntimeAppsDir();
    await fs.mkdir(appsDir, { recursive: true });

    const effectiveScheduler =
      scheduler ??
      new NullScheduler({
        warn: (m) => console.warn(`[local-runtime] ${m}`),
      });

    // gatewayBaseUrl is filled in after the HTTP server binds and we learn
    // the ephemeral port; cron-sync uses it to construct webhook targets.
    //
    // The user-store opens eagerly because both the runtime (for app-index
    // injection) and the HTTP server (for the /_centraid-user route) share
    // the same instance — lazy-init would race on first concurrent access.
    const userStore = new UserStore(localRuntimeUserStoreDb());
    const runtime = new Runtime({
      appsDir,
      gatewayBaseUrl: 'http://127.0.0.1:0',
      scheduler: effectiveScheduler,
      userStore,
      logger: {
        info: (m) => console.info(`[local-runtime] ${m}`),
        warn: (m) => console.warn(`[local-runtime] ${m}`),
        error: (m) => console.error(`[local-runtime] ${m}`),
      },
    });

    const server = await startRuntimeHttpServer({
      runtime,
      chatHistoryDbPath: localRuntimeChatHistoryDb(),
    });
    runtime.setGatewayBaseUrl(server.url);
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
