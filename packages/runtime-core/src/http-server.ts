import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { timingSafeEqual } from './security.js';
import { ChatHistoryStore, makeChatHistoryRouteHandler } from './chat-history.js';
import type { Runtime } from './runtime.js';

export interface RuntimeHttpServerOptions {
  runtime: Runtime;
  /** Host to bind. Defaults to `127.0.0.1` — loopback only. */
  host?: string;
  /** Port. `0` (default) asks the OS for an ephemeral port. */
  port?: number;
  /**
   * Pre-shared bearer token required on every non-loopback-ingest request.
   * If omitted, a 32-byte random hex token is generated.
   */
  token?: string;
  /**
   * Absolute path to the chat-history SQLite file. When provided, the server
   * mounts the `/_centraid-chat/*` HTTP surface backed by this database. The
   * file is opened lazily on the first matching request, so callers can pass
   * a path even if the chat panel is never opened.
   *
   * Omit to disable the chat-history surface entirely — requests hitting the
   * prefix then 404 through the normal `Runtime.handle` path.
   */
  chatHistoryDbPath?: string;
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

/**
 * Spawn an HTTP server in front of a `Runtime`, suitable for use as the
 * in-process embedded runtime inside the Electron desktop app.
 *
 * Auth model:
 *   - Loopback bind by default (`127.0.0.1`).
 *   - All requests except `/centraid/<id>/_ingest/<cron>` (already gated on
 *     loopback + per-cron token by the runtime) require
 *     `Authorization: Bearer <token>`.
 *   - The token is randomly minted on `start()` unless one is provided.
 *
 * The ingest endpoint is intentionally not gated by the server-level
 * bearer — it uses its own per-cron token enforced by `Runtime.handle`.
 * That lets a local scheduler POST results without knowing the server-level
 * bearer.
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

  // Lazy-init the chat-history store so callers that pass a path but never
  // open the chat panel don't pay the SQLite-open cost. Mirrors the openclaw
  // plugin's lazy pattern.
  let chatHistoryStore: ChatHistoryStore | undefined;
  const chatHistoryHandler = opts.chatHistoryDbPath
    ? makeChatHistoryRouteHandler(() => {
        if (!chatHistoryStore) {
          chatHistoryStore = new ChatHistoryStore(opts.chatHistoryDbPath!);
        }
        return chatHistoryStore;
      })
    : undefined;

  const server = http.createServer((req, res) => {
    void route(req, res);
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isIngestRequest(req)) {
      const raw = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (!raw || !timingSafeEqual(raw, token)) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid bearer token.' }));
        return;
      }
    }
    if (chatHistoryHandler && (req.url ?? '').startsWith(CHAT_HISTORY_PREFIX)) {
      const handled = await chatHistoryHandler(req, res);
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

function isIngestRequest(req: IncomingMessage): boolean {
  if (req.method !== 'POST') return false;
  const url = req.url ?? '';
  return /^\/centraid\/[^/]+\/_ingest\/[^/]+(\?|$)/.test(url);
}
