import crypto from "node:crypto";
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Runtime } from "../runtime.js";
import { makeUserStoreRouteHandler } from "../stores/prefs-store.js";
import { makeConversationRouteHandler } from "./conversation-routes.js";
import { COMPANION_GRANTS_HEADER } from "./internal-headers.js";
import {
  decideCors,
  hasBearerAuthIntent,
  hostnameFromHostHeader,
  isAllowedHostHeader,
} from "./request-boundary.js";
import { timingSafeEqual } from "./security.js";
import {
  GATEWAY_SHUTDOWN_GRACE_MS,
  tuneGatewayHttpServer,
} from "./server-tuning.js";

export interface RuntimeHttpServerOptions {
  runtime: Runtime;
  host?: string;
  port?: number;
  token?: string;
  allowedHosts?: readonly string[];
  credentialedCorsOrigins?: readonly string[] | (() => readonly string[]);
  exposeUserStoreRoute?: boolean;
  ownerIdProvider?: () => string;
  exposeConversationRoute?: boolean;
  extraHandlers?: Array<
    (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
  >;
  /** WITHOUT the bearer check (#304). EXACT match, never a prefix. */
  publicPaths?: readonly string[];
  /** A `startsWith` match (#96): a prefix bypasses auth for its WHOLE subtree,
   *  so its handler must enforce its own credential on every request. */
  publicPathPrefixes?: readonly string[];
  /** REPLACES the shared-token check; comparisons must be timing-safe. */
  authorizeBearer?: (bearer: string) => BearerAuthorization | undefined;
  authorizeRequest?: (req: IncomingMessage) => BearerAuthorization | undefined;
}

export interface RuntimeHttpServerHandle {
  url: string;
  token: string;
  close: () => Promise<void>;
}

const CONVERSATIONS_PREFIX = "/_centraid-conversations";
const USER_STORE_PREFIX = "/_centraid-user";

/** Server-stamped, never client-supplied: deleted from every request before
 *  auth, so a bearer-holder cannot forge a downstream identity (#376). */
export const AUTHED_DEVICE_HEADER = "x-centraid-authed-device";
export const AUTHED_PLANE_HEADER = "x-centraid-authed-plane";
const WEB_APP_HEADER = "x-centraid-web-app";

export type BearerAuthorization =
  | { plane: "admin" }
  | { plane: "device"; deviceKey: string };

/** Cookie/session clients must never get `Allow-Origin: <attacker>` with
 *  `Allow-Credentials: true` (#504). Set on EVERY response. */
function setCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  credentialedCorsOrigins:
    | readonly string[]
    | (() => readonly string[])
    | undefined
): void {
  const origins =
    typeof credentialedCorsOrigins === "function"
      ? credentialedCorsOrigins()
      : (credentialedCorsOrigins ?? []);
  const decision = decideCors({
    origin: req.headers.origin,
    credentialedOrigins: origins,
    bearerAuthIntent: hasBearerAuthIntent(
      req.headers.authorization,
      req.headers["access-control-request-headers"]
    ),
  });
  if (decision.allowOrigin !== null) {
    res.setHeader("Access-Control-Allow-Origin", decision.allowOrigin);
  }
  if (decision.credentials) {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, PATCH, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, x-centraid-vault, x-centraid-client-session, x-content-sha256"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
}

function resolveAllowedHosts(
  opts: RuntimeHttpServerOptions,
  bindHost: string
): string[] {
  const extra: string[] = [];
  const bindHostname =
    hostnameFromHostHeader(bindHost) ?? bindHost.trim().toLowerCase();
  if (bindHostname) extra.push(bindHostname);
  for (const h of opts.allowedHosts ?? []) {
    const normalized = h.trim().toLowerCase();
    if (normalized) extra.push(normalized);
  }
  return extra;
}

/** Written before or instead of any handler, so they cannot reach `sendJson`
 *  and its `nosniff` (#846 P10). `close` is wrong for a 401. */
function endTransportJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  close = false
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (close) res.setHeader("Connection", "close");
  res.end(JSON.stringify(body));
}

/** Loopback bind, an allowlisted Host header (DNS rebinding refused before
 *  auth or handlers, #504), a bearer unless a public path says otherwise. */
export async function startRuntimeHttpServer(
  opts: RuntimeHttpServerOptions
): Promise<RuntimeHttpServerHandle> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;
  const token = opts.token ?? crypto.randomBytes(32).toString("hex");
  const allowedHosts = resolveAllowedHosts(opts, host);

  const userStore = opts.runtime.userStore;
  const exposeUserStore =
    opts.exposeUserStoreRoute !== false && userStore !== undefined;
  const userStoreHandler = exposeUserStore
    ? makeUserStoreRouteHandler(() => userStore!, opts.ownerIdProvider)
    : undefined;

  const conversationHistoryStore = opts.runtime.conversationHistoryStore;
  const exposeConversation =
    opts.exposeConversationRoute !== false &&
    conversationHistoryStore !== undefined;
  const conversationHandler = exposeConversation
    ? makeConversationRouteHandler(() => conversationHistoryStore!)
    : undefined;

  const server = http.createServer((req, res) => {
    void route(req, res).catch(() => {
      if (res.destroyed) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      endTransportJson(res, 500, { error: "internal_server_error" }, true);
    });
  });
  tuneGatewayHttpServer(server);

  async function route(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    if (!isAllowedHostHeader(req.headers.host, allowedHosts)) {
      endTransportJson(
        res,
        400,
        { error: "invalid_host", message: "Host header is not allowed." },
        true
      );
      return;
    }

    setCorsHeaders(req, res, opts.credentialedCorsOrigins);
    // Preflight carries no Authorization header: answer it before the gate.
    if ((req.method ?? "").toUpperCase() === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    const isPublic =
      (opts.publicPaths ?? []).includes(pathname) ||
      (opts.publicPathPrefixes ?? []).some((prefix) =>
        pathname.startsWith(prefix)
      );
    // Deleted UNCONDITIONALLY before auth: only the verified branch below may
    // re-set these (#376).
    delete req.headers[AUTHED_DEVICE_HEADER];
    delete req.headers[AUTHED_PLANE_HEADER];
    delete req.headers[COMPANION_GRANTS_HEADER];
    delete req.headers[WEB_APP_HEADER];
    const raw = (req.headers.authorization ?? "").replace(/^Bearer\s+/iu, "");
    const resolveAuthorization = (): BearerAuthorization | undefined => {
      if (opts.authorizeBearer || opts.authorizeRequest) {
        return raw
          ? opts.authorizeBearer
            ? opts.authorizeBearer(raw)
            : timingSafeEqual(raw, token)
              ? { plane: "admin" as const }
              : undefined
          : opts.authorizeRequest?.(req);
      }
      return raw && timingSafeEqual(raw, token)
        ? { plane: "admin" as const }
        : undefined;
    };
    const authz = resolveAuthorization();
    if (!isPublic && !authz) {
      endTransportJson(res, 401, {
        error: "unauthorized",
        message: "Invalid bearer token.",
      });
      return;
    }
    if (authz) {
      req.headers[AUTHED_PLANE_HEADER] = authz.plane;
      if (authz.plane === "device")
        req.headers[AUTHED_DEVICE_HEADER] = authz.deviceKey;
    }
    if (
      conversationHandler &&
      (req.url ?? "").startsWith(CONVERSATIONS_PREFIX)
    ) {
      const handled = await conversationHandler(req, res);
      if (handled) return;
    }
    if (userStoreHandler && (req.url ?? "").startsWith(USER_STORE_PREFIX)) {
      const handled = await userStoreHandler(req, res);
      if (handled) return;
    }
    const tryExtraHandler = async (index: number): Promise<boolean> => {
      const handler = opts.extraHandlers?.[index];
      if (!handler) return false;
      if (await handler(req, res)) return true;
      return tryExtraHandler(index + 1);
    };
    if (await tryExtraHandler(0)) return;
    await opts.runtime.handle(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr === "string") {
    server.close();
    throw new Error("runtime http server: failed to read bound address");
  }
  const url = `http://${host}:${addr.port}`;

  return {
    url,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // `server.close()` waits for EVERY connection and an SSE response
        // never ends, so idle sockets drop and the rest are forced.
        let force: ReturnType<typeof setTimeout> | undefined = undefined;
        server.close((err) => {
          if (force) clearTimeout(force);
          if (err) reject(err);
          else resolve();
        });
        server.closeIdleConnections();
        force = setTimeout(
          () => server.closeAllConnections(),
          GATEWAY_SHUTDOWN_GRACE_MS
        );
      }),
  };
}
