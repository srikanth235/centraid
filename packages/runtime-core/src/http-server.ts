import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { AddressInfo } from 'node:net';
import { timingSafeEqual } from './security.js';
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
}

export interface RuntimeHttpServerHandle {
  /** `http://<host>:<port>` — the base URL the renderer should target. */
  url: string;
  /** Bearer token the renderer must send as `Authorization: Bearer <token>`. */
  token: string;
  /** Stop the server. Resolves once the listener is closed. */
  close(): Promise<void>;
}

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
 */
export async function startRuntimeHttpServer(
  opts: RuntimeHttpServerOptions,
): Promise<RuntimeHttpServerHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const token = opts.token ?? crypto.randomBytes(32).toString('hex');

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
