import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { timingSafeEqual } from './security.js';
import { makeConversationRouteHandler } from './conversation-routes.js';
import { makeUserStoreRouteHandler } from '../stores/prefs-store.js';
import type { Runtime } from '../runtime.js';

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
   * Whether to mount `/_centraid-user/*` against `runtime.userStore`.
   * Defaults to true when `runtime.userStore` is set; explicit `false`
   * disables the route even if a store is attached (used by hosts that
   * mount their own equivalent route, e.g. the openclaw plugin).
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
   * `app-engine` (which OpenClaw + standalone setups share).
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
 * Permissive CORS for the desktop renderer (issue: thin-client). The
 * renderer calls the gateway HTTP API directly with `Authorization:
 * Bearer <token>`; because auth is a Bearer header (never a cookie) it
 * is safe to allow any origin — there are no ambient credentials to
 * leak, and `*` also covers the `Origin: null` a `file://` renderer
 * sends. Set on EVERY response (including the 401 and the SSE streams):
 * we call this at the top of `route()` before any handler runs, and
 * Node merges `setHeader` values into a later `writeHead`, so the SSE
 * writers in chat-routes/changes-sse inherit these without change.
 *
 * Remote gateways front by OpenClaw must emit their own CORS — this
 * only governs the local embedded server.
 */
function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/**
 * Spawn an HTTP server in front of a `Runtime`, suitable for use as the
 * in-process embedded runtime inside the Electron desktop app.
 *
 * Auth model:
 *   - Loopback bind by default (`127.0.0.1`).
 *   - All requests require `Authorization: Bearer <token>`.
 *   - The token is randomly minted on `start()` unless one is provided.
 *
 * When `conversationDbPath` is provided, the server also serves the
 * `/_centraid-conversations/*` HTTP surface (same shape the OpenClaw plugin exposes
 * on the remote gateway). The same bearer check applies.
 */
export async function startRuntimeHttpServer(
  opts: RuntimeHttpServerOptions,
): Promise<RuntimeHttpServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const token = opts.token ?? crypto.randomBytes(32).toString('hex');

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
    void route(req, res);
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setCorsHeaders(res);
    // Preflight carries no Authorization header — answer it before the
    // Bearer check, or the browser never sends the real request.
    if ((req.method ?? '').toUpperCase() === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    const isPublic =
      (opts.publicPaths ?? []).includes(pathname) ||
      (opts.publicPathPrefixes ?? []).some((prefix) => pathname.startsWith(prefix));
    const raw = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!isPublic && (!raw || !timingSafeEqual(raw, token))) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid bearer token.' }));
      return;
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
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
