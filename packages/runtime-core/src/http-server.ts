import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { timingSafeEqual } from './security.js';
import { makeChatHistoryRouteHandler } from './chat-history-routes.js';
import { makeUserStoreRouteHandler } from './user-store.js';
import type { Runtime } from './runtime.js';

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
   * Whether to mount `/_centraid-chat/*` against `runtime.chatHistoryStore`.
   * Defaults to true when `runtime.chatHistoryStore` is set; same opt-out
   * pattern as `exposeUserStoreRoute`.
   */
  exposeChatHistoryRoute?: boolean;
}

export interface RuntimeHttpServerHandle {
  /** `http://<host>:<port>` — the base URL the renderer should target. */
  url: string;
  /** Bearer token the renderer must send as `Authorization: Bearer <token>`. */
  token: string;
  /** Stop the server. Resolves once the listener is closed. */
  close(): Promise<void>;
}

const CHAT_HISTORY_PREFIX = '/_centraid-chat';
const USER_STORE_PREFIX = '/_centraid-user';

/**
 * Spawn an HTTP server in front of a `Runtime`, suitable for use as the
 * in-process embedded runtime inside the Electron desktop app.
 *
 * Auth model:
 *   - Loopback bind by default (`127.0.0.1`).
 *   - All requests require `Authorization: Bearer <token>`.
 *   - The token is randomly minted on `start()` unless one is provided.
 *
 * When `chatHistoryDbPath` is provided, the server also serves the
 * `/_centraid-chat/*` HTTP surface (same shape the OpenClaw plugin exposes
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
    ? makeUserStoreRouteHandler(() => userStore!)
    : undefined;

  const chatHistoryStore = opts.runtime.chatHistoryStore;
  const exposeChatHistory = opts.exposeChatHistoryRoute !== false && chatHistoryStore !== undefined;
  const chatHistoryHandler = exposeChatHistory
    ? makeChatHistoryRouteHandler(() => chatHistoryStore!)
    : undefined;

  const server = http.createServer((req, res) => {
    void route(req, res);
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!raw || !timingSafeEqual(raw, token)) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid bearer token.' }));
      return;
    }
    if (chatHistoryHandler && (req.url ?? '').startsWith(CHAT_HISTORY_PREFIX)) {
      const handled = await chatHistoryHandler(req, res);
      if (handled) return;
    }
    if (userStoreHandler && (req.url ?? '').startsWith(USER_STORE_PREFIX)) {
      const handled = await userStoreHandler(req, res);
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
