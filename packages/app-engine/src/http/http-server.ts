import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { timingSafeEqual } from './security.js';
import { makeConversationRouteHandler } from './conversation-routes.js';
import { makeUserStoreRouteHandler } from '../stores/prefs-store.js';
import type { Runtime } from '../runtime.js';
import { GATEWAY_SHUTDOWN_GRACE_MS, tuneGatewayHttpServer } from './server-tuning.js';
import { COMPANION_GRANTS_HEADER } from './internal-headers.js';
import {
  decideCors,
  hasBearerAuthIntent,
  hostnameFromHostHeader,
  isAllowedHostHeader,
} from './request-boundary.js';

export interface RuntimeHttpServerOptions {
  runtime: Runtime;
  /** Host to bind. Defaults to `127.0.0.1` — loopback only. */
  host?: string;
  /** Port. `0` (default) asks the OS for an ephemeral port. */
  port?: number;
  /**
   * Pre-shared bearer token required on every request.
   * If omitted, a 32-byte random hex token is generated.
   */
  token?: string;
  /**
   * Extra hostnames accepted in the Host header beyond the built-in
   * loopback set (localhost / 127.0.0.1 / ::1). The bind `host` is added
   * automatically. Used when a deployment configures non-loopback names
   * (issue #504); defaults leave only loopback forms allowed.
   */
  allowedHosts?: readonly string[];
  /**
   * Origins allowed for credentialed CORS (`Access-Control-Allow-Credentials`).
   * Typically the PWA shell origins bound on control/app sessions. May be a
   * getter so the host can reflect live session state without app-engine
   * knowing about sessions. Bearer-intent requests may also receive
   * credentialed CORS for their Origin (token is not ambient). See
   * `decideCors` / SECURITY.md control-plane subsection.
   */
  credentialedCorsOrigins?: readonly string[] | (() => readonly string[]);
  /**
   * Whether to mount `/_centraid-user/*` against `runtime.userStore`.
   * Defaults to true when `runtime.userStore` is set; explicit `false`
   * disables the route even if a store is attached (used by hosts that
   * mount their own equivalent route).
   */
  exposeUserStoreRoute?: boolean;
  /**
   * Backs `GET /_centraid-user/id` with the ACTIVE vault's owner party id —
   * the one user identity that exists (#280). Without it the sub-route 404s.
   */
  ownerIdProvider?: () => string;
  /**
   * Whether to mount `/_centraid-conversations/*` against `runtime.conversationHistoryStore`.
   * Defaults to true when `runtime.conversationHistoryStore` is set; same opt-out
   * pattern as `exposeUserStoreRoute`.
   */
  exposeConversationRoute?: boolean;
  /**
   * Host-supplied route handlers run after auth but before
   * `runtime.handle` (issue #137). Each returns `true` when it handled
   * the request (response already sent), `false` to fall through.
   * Tried in order. The gateway uses this to mount the apps-store
   * publish/session surface without baking a git backend into
   * `app-engine` (which the standalone daemon and desktop share).
   */
  extraHandlers?: Array<(req: IncomingMessage, res: ServerResponse) => Promise<boolean>>;
  /**
   * Exact pathnames served WITHOUT the bearer check (issue #304). The one
   * intended tenant is the OAuth consent callback — a provider redirects
   * the owner's BROWSER here, which cannot carry the bearer; the request
   * instead authenticates by its single-use unguessable `state` capability,
   * minted by an authenticated authorize call and checked by the route
   * handler. Match is on the exact pathname (query string free), never a
   * prefix — a public path must never accidentally widen.
   */
  publicPaths?: readonly string[];
  /**
   * Path PREFIXES served WITHOUT the bearer check (issue #96). The
   * intended tenant is the webhook-trigger route (`/_centraid-hook/<id>`,
   * variable per automation) — the shared secret carried in the request
   * itself IS the auth, checked by the route handler; requiring the
   * gateway owner's bearer too would defeat the point of a webhook (the
   * caller is a third-party service, not the owner). Unlike `publicPaths`
   * this is a `startsWith` match, so a prefix here bypasses auth for its
   * whole subtree — reserve it for routes whose handler enforces its own
   * credential on every request.
   */
  publicPathPrefixes?: readonly string[];
  /**
   * Pluggable bearer authorization (issue #376). When set, it REPLACES the
   * single-shared-token equality check: called with the raw bearer string
   * (Authorization header, `Bearer ` prefix stripped), it returns
   * `{plane:'admin'}` for the landlord token, `{plane:'device',
   * deviceKey}` for a per-device tenant token, or `undefined` to refuse
   * the request with 401. On a `'device'` match, the caller's resolved
   * `deviceKey` is stamped onto `AUTHED_DEVICE_HEADER` for downstream
   * handlers to read — comparisons should be timing-safe, same
   * expectation as the default `token` check. Absent → the original
   * single-shared-token behavior (`opts.token`).
   */
  authorizeBearer?: (bearer: string) => BearerAuthorization | undefined;
  /** Optional cookie/request authorizer used by gateway-scoped browser app sessions. */
  authorizeRequest?: (req: IncomingMessage) => BearerAuthorization | undefined;
}

export interface RuntimeHttpServerHandle {
  /** `http://<host>:<port>` — the base URL the renderer should target. */
  url: string;
  /** Bearer token the renderer must send as `Authorization: Bearer <token>`. */
  token: string;
  /** Stop the server. Resolves once the listener is closed. */
  close(): Promise<void>;
}

const CONVERSATIONS_PREFIX = '/_centraid-conversations';
const USER_STORE_PREFIX = '/_centraid-user';

/**
 * Internal, server-stamped device-identity header (issue #376). Set ONLY
 * by `route()` below, ONLY after `authorizeBearer` resolves a presented
 * bearer to a device-plane token — never trust a client-supplied value:
 * every request has it deleted first, so a bearer-holder can never forge
 * an identity for a downstream handler (the gateway's `composedHandler`)
 * to trust.
 */
export const AUTHED_DEVICE_HEADER = 'x-centraid-authed-device';
const WEB_APP_HEADER = 'x-centraid-web-app';
const WEB_SHELL_ORIGIN_HEADER = 'x-centraid-web-shell-origin';

/** What a presented bearer resolved to — the shared landlord token, or one tenant's device. */
export type BearerAuthorization = { plane: 'admin' } | { plane: 'device'; deviceKey: string };

/**
 * CORS for the loopback control plane (issue #504 batch 0).
 *
 * Bearer-only clients (desktop thin client, device tokens) have no ambient
 * credentials: reflecting their Origin with credentials is fine when the
 * request signals Bearer intent, and `Origin: null` / missing Origin still
 * get `*` for `file://` renderers.
 *
 * Cookie/session clients (PWA) must never receive
 * `Access-Control-Allow-Origin: <attacker>` paired with
 * `Access-Control-Allow-Credentials: true`. Credentialed CORS is limited to
 * `credentialedCorsOrigins` (session-bound shell origins) or Bearer intent.
 * Foreign cookie-only origins get `*` without credentials so the browser
 * cannot expose the body under `credentials: 'include'`.
 *
 * Set on EVERY response (including 401 and SSE): called at the top of
 * `route()` before handlers; Node merges `setHeader` into later `writeHead`.
 *
 * Preflight (OPTIONS) stays before auth: browsers omit Authorization on the
 * preflight itself; we detect Bearer intent via
 * Access-Control-Request-Headers. Auth still gates the real request.
 */
function setCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  credentialedCorsOrigins: readonly string[] | (() => readonly string[]) | undefined,
): void {
  const origins =
    typeof credentialedCorsOrigins === 'function'
      ? credentialedCorsOrigins()
      : (credentialedCorsOrigins ?? []);
  const decision = decideCors({
    origin: req.headers.origin,
    credentialedOrigins: origins,
    bearerAuthIntent: hasBearerAuthIntent(
      req.headers.authorization,
      req.headers['access-control-request-headers'],
    ),
  });
  if (decision.allowOrigin !== null) {
    res.setHeader('Access-Control-Allow-Origin', decision.allowOrigin);
  }
  if (decision.credentials) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'authorization, content-type, x-centraid-vault, x-centraid-client-session',
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function resolveAllowedHosts(opts: RuntimeHttpServerOptions, bindHost: string): string[] {
  const extra: string[] = [];
  const bindHostname = hostnameFromHostHeader(bindHost) ?? bindHost.trim().toLowerCase();
  if (bindHostname) extra.push(bindHostname);
  for (const h of opts.allowedHosts ?? []) {
    const normalized = h.trim().toLowerCase();
    if (normalized) extra.push(normalized);
  }
  return extra;
}

/**
 * Spawn an HTTP server in front of a `Runtime`, suitable for use as the
 * in-process embedded runtime inside the Electron desktop app.
 *
 * Auth model:
 *   - Loopback bind by default (`127.0.0.1`).
 *   - Host header allowlisted (loopback forms + configured names) — DNS
 *     rebinding is refused before auth/handlers (issue #504).
 *   - All requests require `Authorization: Bearer <token>` (or a host-supplied
 *     cookie authorizer via `authorizeRequest`).
 *   - The token is randomly minted on `start()` unless one is provided.
 *
 * When `conversationDbPath` is provided, the server also serves the
 * `/_centraid-conversations/*` HTTP surface (same shape the standalone
 * daemon exposes on the remote gateway). The same bearer check applies.
 */
export async function startRuntimeHttpServer(
  opts: RuntimeHttpServerOptions,
): Promise<RuntimeHttpServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const token = opts.token ?? crypto.randomBytes(32).toString('hex');
  const allowedHosts = resolveAllowedHosts(opts, host);

  // Both stores are owned by the caller (a single shared gateway DB
  // provider underneath). We mount the routes only if the corresponding
  // store is attached AND the host hasn't disabled it. The handlers
  // resolve the stores lazily through getters so a future runtime that
  // lazy-creates them still works.
  const userStore = opts.runtime.userStore;
  const exposeUserStore = opts.exposeUserStoreRoute !== false && userStore !== undefined;
  const userStoreHandler = exposeUserStore
    ? makeUserStoreRouteHandler(() => userStore!, opts.ownerIdProvider)
    : undefined;

  const conversationHistoryStore = opts.runtime.conversationHistoryStore;
  const exposeConversation =
    opts.exposeConversationRoute !== false && conversationHistoryStore !== undefined;
  const conversationHandler = exposeConversation
    ? makeConversationRouteHandler(() => conversationHistoryStore!)
    : undefined;

  const server = http.createServer((req, res) => {
    void route(req, res).catch(() => {
      // Route handlers normally translate their own domain errors. This is the
      // final transport boundary: never leave a rejected async handler as an
      // unhandled rejection, and never try to serialize JSON after bytes have
      // already been sent.
      if (res.destroyed) return;
      if (res.headersSent) {
        // Do not pass the handler error to destroy(): that re-emits it on the
        // response and can turn containment into an uncaught transport error.
        res.destroy();
        return;
      }
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Connection', 'close');
      res.end(JSON.stringify({ error: 'internal_server_error' }));
    });
  });
  tuneGatewayHttpServer(server);

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Host check first — refuse DNS-rebinding before CORS, auth, or handlers.
    if (!isAllowedHostHeader(req.headers.host, allowedHosts)) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Connection', 'close');
      res.end(JSON.stringify({ error: 'invalid_host', message: 'Host header is not allowed.' }));
      return;
    }

    setCorsHeaders(req, res, opts.credentialedCorsOrigins);
    // Preflight carries no Authorization header — answer it before the
    // Bearer check, or the browser never sends the real request. CORS
    // headers above already distinguish credentialed allowlist / Bearer
    // intent from foreign cookie-only origins (#504).
    if ((req.method ?? '').toUpperCase() === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    const isPublic =
      (opts.publicPaths ?? []).includes(pathname) ||
      (opts.publicPathPrefixes ?? []).some((prefix) => pathname.startsWith(prefix));
    // Never trust a client-supplied device header — deleted unconditionally
    // before auth runs; only the `authorizeBearer` branch below re-sets it,
    // and only after verifying the bearer names a device token (#376).
    delete req.headers[AUTHED_DEVICE_HEADER];
    delete req.headers[COMPANION_GRANTS_HEADER];
    delete req.headers[WEB_APP_HEADER];
    delete req.headers[WEB_SHELL_ORIGIN_HEADER];
    const raw = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!isPublic) {
      if (opts.authorizeBearer || opts.authorizeRequest) {
        const authz = raw
          ? opts.authorizeBearer
            ? opts.authorizeBearer(raw)
            : timingSafeEqual(raw, token)
              ? { plane: 'admin' as const }
              : undefined
          : opts.authorizeRequest?.(req);
        if (!authz) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid bearer token.' }));
          return;
        }
        if (authz.plane === 'device') {
          req.headers[AUTHED_DEVICE_HEADER] = authz.deviceKey;
        }
      } else if (!raw || !timingSafeEqual(raw, token)) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid bearer token.' }));
        return;
      }
    }
    if (conversationHandler && (req.url ?? '').startsWith(CONVERSATIONS_PREFIX)) {
      const handled = await conversationHandler(req, res);
      if (handled) return;
    }
    if (userStoreHandler && (req.url ?? '').startsWith(USER_STORE_PREFIX)) {
      const handled = await userStoreHandler(req, res);
      if (handled) return;
    }
    for (const handler of opts.extraHandlers ?? []) {
      const handled = await handler(req, res);
      if (handled) return;
    }
    await opts.runtime.handle(req, res);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr === 'string') {
    server.close();
    throw new Error('runtime http server: failed to read bound address');
  }
  const url = `http://${host}:${addr.port}`;

  return {
    url,
    token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // `server.close()` alone waits for EVERY connection to end. Node drops
        // idle keep-alive sockets itself, but an open SSE response is an
        // *active* request that never ends, so a subscribed client would pin
        // the listener open forever. Stop accepting, hurry the idle sockets
        // along, then destroy whatever is left after the grace window — see
        // GATEWAY_SHUTDOWN_GRACE_MS.
        let force: ReturnType<typeof setTimeout> | undefined;
        server.close((err) => {
          if (force) clearTimeout(force);
          if (err) reject(err);
          else resolve();
        });
        server.closeIdleConnections();
        force = setTimeout(() => server.closeAllConnections(), GATEWAY_SHUTDOWN_GRACE_MS);
      }),
  };
}
