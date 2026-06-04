/*
 * HTTP route dispatcher for the conversation-history store.
 *
 * Mounted under `/_centraid-conversations` by both gateway hosts:
 *   - the OpenClaw plugin (remote gateway) via `api.registerHttpRoute`
 *   - `startRuntimeHttpServer` for the desktop's embedded local runtime
 *
 * The store itself lives in `history.ts`. This module is split
 * out purely for file-size reasons — keeping the store, its schema, and its
 * SQL prepared statements in one file (where the per-user scoping rules
 * are easier to audit at a glance) is the more important constraint.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConversationHistoryStore } from '../conversation/history.js';

const ROUTE_PREFIX = '/_centraid-conversations';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB per attachment.

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_UPLOAD_BYTES) throw new Error(`upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (raw.length === 0) return undefined;
  const text = raw.toString('utf8');
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text).toString(),
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * Build the conversation HTTP route handler. The store is resolved lazily
 * via `getStore()` so the SQLite connection only opens in the gateway
 * process (route handlers don't fire in agent-worker contexts), avoiding
 * stray DB handles in subprocesses that never touch chat history.
 *
 * Chat is app-scoped (issue #98): every route carries the owning `appId`,
 * which the store uses to resolve that app's `runtime.sqlite`. Per-user
 * scoping is still enforced inside the store via its `userIdProvider`.
 *
 * Dispatch map:
 *   GET    /_centraid-conversations/apps/<appId>/sessions        list (this app)
 *   POST   /_centraid-conversations/apps/<appId>/sessions        create  body: {mode?, title?}
 *   GET    /_centraid-conversations/apps/<appId>/sessions/<id>   load (with transcript)
 *   PATCH  /_centraid-conversations/apps/<appId>/sessions/<id>   rename  body: {title}
 *   DELETE /_centraid-conversations/apps/<appId>/sessions/<id>   delete
 *
 * The transcript is not appended over HTTP — a chat turn is recorded as a
 * `runs` row by the `/centraid/<id>/_turn` route's runner (issue #90 fold).
 */
export function makeConversationRouteHandler(getStore: () => ConversationHistoryStore) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!req.url || !req.url.startsWith(ROUTE_PREFIX)) return false;
    // Use a dummy host because IncomingMessage.url is path-only.
    const url = new URL(req.url, 'http://x');
    const sub = url.pathname.slice(ROUTE_PREFIX.length); // e.g. "/apps/foo/sessions/abc"
    const method = (req.method ?? 'GET').toUpperCase();
    const store = getStore();

    try {
      // Attachment blob CAS (issue #190):
      //   POST /apps/<appId>/blobs            upload bytes → { hash, sizeBytes, url }
      //   GET  /apps/<appId>/blobs/<hash>     download bytes
      const blobMatch = sub.match(/^\/apps\/([^/]+)\/blobs(?:\/([a-f0-9]{64}))?\/?$/);
      if (blobMatch && blobMatch[1]) {
        const appId = decodeURIComponent(blobMatch[1]);
        const hash = blobMatch[2];
        if (!hash && method === 'POST') {
          const bytes = await readRawBody(req);
          if (bytes.length === 0) {
            sendError(res, 400, 'empty upload');
            return true;
          }
          const put = await store.uploadBlob(appId, bytes);
          const mime = req.headers['content-type'] ?? 'application/octet-stream';
          sendJson(res, 200, {
            hash: put.hash,
            sizeBytes: put.sizeBytes,
            mime,
            url: `${ROUTE_PREFIX}/apps/${encodeURIComponent(appId)}/blobs/${put.hash}`,
          });
          return true;
        }
        if (hash && method === 'GET') {
          const bytes = await store.readBlob(appId, hash);
          if (!bytes) {
            sendError(res, 404, 'blob not found');
            return true;
          }
          const mime = url.searchParams.get('mime') ?? 'application/octet-stream';
          res.writeHead(200, {
            'content-type': mime,
            'content-length': bytes.byteLength.toString(),
            'cache-control': 'private, max-age=31536000, immutable',
          });
          res.end(bytes);
          return true;
        }
        sendError(res, 405, 'method not allowed');
        return true;
      }

      // /apps/<appId>/sessions  and  /apps/<appId>/sessions/<id>
      const m = sub.match(/^\/apps\/([^/]+)\/sessions(?:\/([^/]+))?\/?$/);
      if (!m || !m[1]) {
        sendError(res, 404, 'unknown conversation route');
        return true;
      }
      const appId = decodeURIComponent(m[1]);
      const id = m[2] ? decodeURIComponent(m[2]) : undefined;

      if (!id) {
        if (method === 'GET') {
          sendJson(res, 200, { sessions: store.listSessions(appId) });
          return true;
        }
        if (method === 'POST') {
          const body = (await readJsonBody(req)) as { title?: string } | undefined;
          sendJson(res, 200, store.createSession(appId, body?.title ?? ''));
          return true;
        }
        sendError(res, 405, 'method not allowed');
        return true;
      }

      if (method === 'GET') {
        const full = store.getSession(appId, id);
        if (!full) {
          sendError(res, 404, 'session not found');
          return true;
        }
        sendJson(res, 200, full);
        return true;
      }
      if (method === 'PATCH') {
        const body = (await readJsonBody(req)) as { title?: string } | undefined;
        const title = typeof body?.title === 'string' ? body.title : '';
        const updated = store.renameSession(appId, id, title);
        if (!updated) {
          sendError(res, 404, 'session not found');
          return true;
        }
        sendJson(res, 200, updated);
        return true;
      }
      if (method === 'DELETE') {
        const ok = store.deleteSession(appId, id);
        sendJson(res, ok ? 200 : 404, { ok });
        return true;
      }
      sendError(res, 405, 'method not allowed');
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendError(res, 500, msg);
      return true;
    }
  };
}
