import path from 'node:path';
import { promises as fs } from 'node:fs';
import { app } from 'electron';
import {
  ChatHistoryStore,
  NullScheduler,
  Runtime,
  UserStore,
  makeGatewayDbProvider,
  startRuntimeHttpServer,
  TelemetryStore,
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

    // One SQLite file holds every per-user gateway record. Both stores
    // wrap the same lazy provider so they share one connection (real FK
    // from `chat_sessions.user_id` to `users.id`, single migration ladder,
    // single backup target). The provider opens the file on first use —
    // lazy because nothing here actually touches the DB until a request
    // hits the HTTP server.
    const gatewayDbProvider = makeGatewayDbProvider(localRuntimeGatewayDb());
    const userStore = new UserStore(gatewayDbProvider);
    const chatHistoryStore = new ChatHistoryStore(gatewayDbProvider, () => userStore.getUserId());

    // Telemetry: one SQLite file PER APP at
    // `<appsDir>/<appId>/telemetry.sqlite`. The store opens each app's
    // file lazily on first write, caches connections in an LRU (cap 16),
    // and applies a per-app token bucket so a runaway handler in one
    // app can only starve itself. Keeps spans/events out of each app's
    // user-facing `data.sqlite` and out of reach of the agent's
    // `centraid_sql_*` tools, mirroring the openclaw-plugin layout.
    const telemetry = new TelemetryStore(appsDir);

    // gatewayBaseUrl is filled in after the HTTP server binds and we learn
    // the ephemeral port; cron-sync uses it to construct webhook targets.
    const runtime = new Runtime({
      appsDir,
      gatewayBaseUrl: 'http://127.0.0.1:0',
      scheduler: effectiveScheduler,
      userStore,
      chatHistoryStore,
      logger: {
        info: (m) => console.info(`[local-runtime] ${m}`),
        warn: (m) => console.warn(`[local-runtime] ${m}`),
        error: (m) => console.error(`[local-runtime] ${m}`),
      },
      telemetry,
    });

    const server = await startRuntimeHttpServer({ runtime });
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
