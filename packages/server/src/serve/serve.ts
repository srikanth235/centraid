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

import { ROUTES } from "@centraid/core/protocol";
import { WEBHOOK_ROUTE_PREFIX } from "@centraid/server/automation";
import { startRuntimeHttpServer } from "@centraid/server/engine";

import { OAUTH_CALLBACK_PATH } from "../routes/connections-routes.js";
import { buildGateway } from "./build-gateway.js";
import type { BuildGatewayOptions, BuiltGateway } from "./build-gateway.js";
import { startWebUiServer } from "./web-ui-server.js";

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
  /** Optional dedicated-origin PWA listener. Generated apps remain on the API origin. */
  web?: { rootDir: string; host?: string; port?: number };
}

export interface GatewayServeHandle extends Omit<
  BuiltGateway,
  | "extraHandlers"
  | "composedHandler"
  | "webhookHandler"
  | "webControlSessions"
  | "start"
  | "stop"
> {
  /** Bound base URL — `http://<host>:<port>`. */
  url: string;
  /** Bearer token the renderer must send on every request. */
  token: string;
  /** Dedicated PWA origin when web hosting is enabled. */
  webUrl?: string;
  /** Stop the HTTP server. Idempotent in callers. */
  close: () => Promise<void>;
}

export async function serve(
  options: ServeOptions
): Promise<GatewayServeHandle> {
  const gateway = await buildGateway(options);

  // The composed handler owns the whole post-auth chain — including the
  // conversation/prefs routes `startRuntimeHttpServer` would otherwise
  // mount itself — because the request's vault scope (#289) must wrap
  // every one of them. The webhook handler is tried FIRST and stands
  // outside that per-request vault scope (it resolves its own owning
  // vault across all of them); it falls through (`false`) for any other
  // URL, so `composedHandler` still sees everything else. No wildcard bearer
  // recovery/admin mount exists.
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
    // There is deliberately NO public pairing-redemption path here: issue
    // #555 removed HTTP ticket redemption entirely. A ticket redeems only
    // over the iroh `centraid/gw-pair/1` ceremony, where the joining device
    // proves the EndpointId that gets persisted in its enrollment. Minting
    // (`_gateway/devices/ticket`) is NOT public either — it sits behind the
    // bearer, and behind host custody or a proved vault owner on top.
    publicPaths: [OAUTH_CALLBACK_PATH, ROUTES.gatewayInfo],
    publicPathPrefixes: [WEBHOOK_ROUTE_PREFIX],
  };
  if (options.host !== undefined) serverOptions.host = options.host;
  if (options.port !== undefined) serverOptions.port = options.port;
  if (options.allowedHosts !== undefined && options.allowedHosts.length > 0) {
    serverOptions.allowedHosts = options.allowedHosts;
  }
  if (options.token !== undefined) serverOptions.token = options.token;
  serverOptions.authorizeRequest = (req) =>
    gateway.webControlSessions.authorize(req);
  // Session-bound shell origins for credentialed CORS (#504). Bearer-only
  // desktop embeds leave this empty and still get non-credentialed `*`.
  serverOptions.credentialedCorsOrigins = () =>
    gateway.webControlSessions.knownShellOrigins();
  const server = await startRuntimeHttpServer(serverOptions);
  await gateway.start(server.url);
  const web = options.web
    ? await startWebUiServer({
        rootDir: options.web.rootDir,
        apiUrl: server.url,
        ...(options.web.host ? { host: options.web.host } : {}),
        ...(options.web.port === undefined ? {} : { port: options.web.port }),
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
