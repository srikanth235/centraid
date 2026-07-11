/*
 * `serve()` — boot a gateway and front it with an HTTP listener.
 *
 * A thin wrapper over `buildGateway()` (which constructs the whole
 * host-agnostic graph without a socket — see `build-gateway.ts`). `serve()`
 * adds the loopback bind + bearer auth via `startRuntimeHttpServer` and
 * mounts the gateway's `composedHandler` — which resolves the vault every
 * request is addressed to (issue #289) before the chain runs — then drives
 * the post-listener lifecycle. Two callers ship today:
 *
 *   - `apps/desktop` embeds it in the Electron main process (paths under
 *     `<userData>/gateways/<id>/`).
 *   - The `centraid-gateway` CLI in this package runs it as a standalone
 *     daemon (paths under a config-file `dataDir`).
 *
 * A third host (the OpenClaw plugin) mounts `buildGateway()`'s
 * `composedHandler` directly instead, owning auth itself.
 */

import { startRuntimeHttpServer } from '@centraid/app-engine';
import { WEBHOOK_ROUTE_PREFIX } from '@centraid/automation';
import { OAUTH_CALLBACK_PATH } from '../routes/connections-routes.js';
import { buildGateway, type BuildGatewayOptions, type BuiltGateway } from './build-gateway.js';

export interface ServeOptions extends BuildGatewayOptions {
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
}

export interface GatewayServeHandle extends Omit<
  BuiltGateway,
  'extraHandlers' | 'composedHandler' | 'webhookHandler' | 'start' | 'stop'
> {
  /** Bound base URL — `http://<host>:<port>`. */
  url: string;
  /** Bearer token the renderer must send on every request. */
  token: string;
  /** Stop the HTTP server. Idempotent in callers. */
  close(): Promise<void>;
}

export async function serve(options: ServeOptions): Promise<GatewayServeHandle> {
  const gateway = await buildGateway(options);

  // The composed handler owns the whole post-auth chain — including the
  // conversation/prefs routes `startRuntimeHttpServer` would otherwise
  // mount itself — because the request's vault scope (#289) must wrap
  // every one of them. The webhook handler is tried FIRST and stands
  // outside that per-request vault scope (it resolves its own owning
  // vault across all of them); it falls through (`false`) for any other
  // URL, so `composedHandler` still sees everything else.
  const serverOptions: Parameters<typeof startRuntimeHttpServer>[0] = {
    runtime: gateway.runtime,
    extraHandlers: [gateway.webhookHandler, gateway.composedHandler],
    exposeUserStoreRoute: false,
    exposeConversationRoute: false,
    // The OAuth consent callback (issue #304) is the one bearer-free path:
    // a provider redirects the owner's browser here; the route authenticates
    // by its single-use `state` capability instead. The webhook route
    // (issue #96) is bearer-free too — the shared secret in the request IS
    // the auth, checked by `webhookHandler` itself; requiring the gateway
    // owner's bearer as well would defeat the point of a webhook (the
    // caller is a third-party service, not the owner).
    publicPaths: [OAUTH_CALLBACK_PATH],
    publicPathPrefixes: [WEBHOOK_ROUTE_PREFIX],
  };
  if (options.host !== undefined) serverOptions.host = options.host;
  if (options.port !== undefined) serverOptions.port = options.port;
  if (options.token !== undefined) serverOptions.token = options.token;
  const server = await startRuntimeHttpServer(serverOptions);
  await gateway.start(server.url);

  return {
    url: server.url,
    token: server.token,
    // Stop the cron timers before the HTTP server so no fire is dispatched
    // mid-teardown.
    close: async () => {
      await gateway.stop();
      await server.close();
    },
    runtime: gateway.runtime,
    health: gateway.health,
    ...(gateway.backup ? { backup: gateway.backup } : {}),
    prefs: gateway.prefs,
    analyticsStore: gateway.analyticsStore,
    conversationHistoryStore: gateway.conversationHistoryStore,
    vaults: gateway.vaults,
    appsStore: gateway.appsStore,
    syncApps: gateway.syncApps,
    codeAppsDir: gateway.codeAppsDir,
    logs: gateway.logs,
  } satisfies GatewayServeHandle;
}
