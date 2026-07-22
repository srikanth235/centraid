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
 */

import { startRuntimeHttpServer, type RuntimeHttpServerOptions } from '@centraid/app-engine';
import { WEBHOOK_ROUTE_PREFIX } from '@centraid/automation';
import { OAUTH_CALLBACK_PATH } from '../routes/connections-routes.js';
import { PAIR_ROUTE_PATH } from '../routes/pair-routes.js';
import { WEB_SESSION_REDEEM_PATH } from './web-app-sessions.js';
import { startWebUiServer } from './web-ui-server.js';
import { buildGateway, type BuildGatewayOptions, type BuiltGateway } from './build-gateway.js';

export interface ServeOptions extends BuildGatewayOptions {
  /** HTTP bind host. Defaults to `127.0.0.1` (loopback). */
  host?: string;
  /** HTTP port. `0` (default) asks the OS for an ephemeral port. */
  port?: number;
  /**
   * Extra Host header names accepted beyond loopback forms (issue #504).
   * Required for non-loopback operator hostnames when clients send a
   * non-loopback `Host` (Docker / reverse-proxy). Loopback is always allowed.
   */
  allowedHosts?: readonly string[];
  /**
   * Pre-shared bearer token. When omitted, `startRuntimeHttpServer` mints
   * a random 32-byte hex token. The Electron embed lets this be random
   * per-launch; the daemon persists one across restarts.
   */
  token?: string;
  /**
   * Pluggable bearer authorization (issue #376), forwarded verbatim to
   * `startRuntimeHttpServer`. When set, it replaces the shared-token
   * equality check with (shared token → admin plane) + (per-device HTTP
   * token → device plane). Absent → the original single-shared-token
   * behavior (the desktop embed keeps this).
   */
  authorizeBearer?: RuntimeHttpServerOptions['authorizeBearer'];
  /** Optional dedicated-origin PWA listener. Generated apps remain on the API origin. */
  web?: { rootDir: string; host?: string; port?: number };
}

export interface GatewayServeHandle extends Omit<
  BuiltGateway,
  | 'extraHandlers'
  | 'composedHandler'
  | 'webhookHandler'
  | 'recoverHandler'
  | 'webAppSessions'
  | 'start'
  | 'stop'
> {
  /** Bound base URL — `http://<host>:<port>`. */
  url: string;
  /** Bearer token the renderer must send on every request. */
  token: string;
  /** Dedicated PWA origin when web hosting is enabled. */
  webUrl?: string;
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
  // URL, so `composedHandler` still sees everything else. The recover
  // handler (issue #439) sits between them for the same reason — it is a
  // pre-vault landlord act (it stands up and adopts the home vault), so it
  // must run outside `composedHandler`'s per-request vault scope; it is
  // bearer-gated (not public) and falls through for any non-recover URL.
  const serverOptions: Parameters<typeof startRuntimeHttpServer>[0] = {
    runtime: gateway.runtime,
    extraHandlers: [gateway.webhookHandler, gateway.recoverHandler, gateway.composedHandler],
    exposeUserStoreRoute: false,
    exposeConversationRoute: false,
    // The OAuth consent callback (issue #304) is the one bearer-free path:
    // a provider redirects the owner's browser here; the route authenticates
    // by its single-use `state` capability instead. The webhook route
    // (issue #96) is bearer-free too — the shared secret in the request IS
    // the auth, checked by `webhookHandler` itself; requiring the gateway
    // owner's bearer as well would defeat the point of a webhook (the
    // caller is a third-party service, not the owner).
    // The pairing-redemption route (issue #376) is public for the same
    // reason: its own one-time ticket secret IS the auth, checked by
    // `makePairRouteHandler` itself. Only present when the daemon wired
    // `devicePairing` — the desktop embed never adds this path.
    publicPaths: [
      OAUTH_CALLBACK_PATH,
      WEB_SESSION_REDEEM_PATH,
      ...(options.devicePairing ? [PAIR_ROUTE_PATH] : []),
    ],
    publicPathPrefixes: [WEBHOOK_ROUTE_PREFIX],
  };
  if (options.host !== undefined) serverOptions.host = options.host;
  if (options.port !== undefined) serverOptions.port = options.port;
  if (options.allowedHosts !== undefined && options.allowedHosts.length > 0) {
    serverOptions.allowedHosts = options.allowedHosts;
  }
  if (options.token !== undefined) serverOptions.token = options.token;
  if (options.authorizeBearer !== undefined)
    serverOptions.authorizeBearer = options.authorizeBearer;
  serverOptions.authorizeRequest = (req) => gateway.webAppSessions.authorize(req);
  // Session-bound shell origins for credentialed CORS (#504). Bearer-only
  // desktop embeds leave this empty and still get non-credentialed `*`.
  serverOptions.credentialedCorsOrigins = () => gateway.webAppSessions.knownShellOrigins();
  const server = await startRuntimeHttpServer(serverOptions);
  await gateway.start(server.url);
  const web = options.web
    ? await startWebUiServer({
        rootDir: options.web.rootDir,
        apiUrl: server.url,
        ...(options.web.host ? { host: options.web.host } : {}),
        ...(options.web.port !== undefined ? { port: options.web.port } : {}),
      })
    : undefined;

  return {
    url: server.url,
    token: server.token,
    ...(web ? { webUrl: web.url } : {}),
    // Stop the cron timers before the HTTP server so no fire is dispatched
    // mid-teardown.
    close: async () => {
      await gateway.stop();
      await web?.close();
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
