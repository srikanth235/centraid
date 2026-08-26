// Socket-free construction stays in `build-gateway.ts`; bind/auth/lifecycle here.

import { ROUTES } from "@centraid/core/protocol";
import { WEBHOOK_ROUTE_PREFIX } from "@centraid/server/automation";
import { startRuntimeHttpServer } from "@centraid/server/engine";

import { OAUTH_CALLBACK_PATH } from "../routes/connections-routes.js";
import { buildGateway } from "./build-gateway.js";
import type { BuildGatewayOptions, BuiltGateway } from "./build-gateway.js";
import { startWebUiServer } from "./web-ui-server.js";

export interface ServeOptions extends BuildGatewayOptions {
  host?: string;
  port?: number;
  allowedHosts?: readonly string[];
  token?: string;
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
  url: string;
  token: string;
  webUrl?: string;
  close: () => Promise<void>;
}

export async function serve(
  options: ServeOptions
): Promise<GatewayServeHandle> {
  const gateway = await buildGateway(options);

  // Composed handler owns the post-auth chain: the vault scope (#289) wraps all.
  const serverOptions: Parameters<typeof startRuntimeHttpServer>[0] = {
    runtime: gateway.runtime,
    extraHandlers: [gateway.webhookHandler, gateway.composedHandler],
    exposeUserStoreRoute: false,
    exposeConversationRoute: false,
    // Bearer-free by exception only: `state` (#304), webhook secret (#96). Never
    // add a pairing-redemption path — tickets redeem over iroh (#555).
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
  // Session-bound only (#504); empty yields plain `*`.
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
    // Cron stops first: no fire may dispatch mid-teardown.
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
