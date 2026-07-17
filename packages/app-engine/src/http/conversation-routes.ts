/*
 * HTTP route dispatcher for the conversation-history store.
 *
 * Mounted under `/_centraid-conversations` by both gateway hosts:
 *   - the standalone daemon's `composedHandler`
 *   - `startRuntimeHttpServer` for the desktop's embedded local runtime
 *
 * The store itself lives in `history.ts`. This module is split
 * out purely for file-size reasons — keeping the store, its schema, and its
 * SQL prepared statements in one file (where the per-user scoping rules
 * are easier to audit at a glance) is the more important constraint.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConversationHistoryStore, ConversationSummary } from '../conversation/history.js';

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
 *   GET    /_centraid-conversations/apps/<appId>/sessions/search?q=  FTS search
 *   POST   /_centraid-conversations/apps/<appId>/sessions        create  body: {mode?, title?}
 *   GET    /_centraid-conversations/apps/<appId>/sessions/<id>   load (with transcript)
 *   PATCH  /_centraid-conversations/apps/<appId>/sessions/<id>   update  body: {title?, pinned?, archived?}
 *   DELETE /_centraid-conversations/apps/<appId>/sessions/<id>   delete
 *   PATCH  /_centraid-conversations/apps/<appId>/sessions/<id>/turns/<turnId>/feedback
 *                                                              set 👍/👎  body: {feedback: 'up'|'down'|null}
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

      // Per-turn message feedback (issue #420):
      //   PATCH /apps/<appId>/sessions/<id>/turns/<turnId>/feedback  body {feedback}
      const fb = sub.match(/^\/apps\/([^/]+)\/sessions\/([^/]+)\/turns\/([^/]+)\/feedback\/?$/);
      if (fb && fb[1] && fb[2] && fb[3]) {
        if (method !== 'PATCH') {
          sendError(res, 405, 'method not allowed');
          return true;
        }
        const fbAppId = decodeURIComponent(fb[1]);
        const fbSessionId = decodeURIComponent(fb[2]);
        const fbTurnId = decodeURIComponent(fb[3]);
        const body = (await readJsonBody(req)) as { feedback?: unknown } | undefined;
        const raw = body?.feedback;
        const feedback = raw === 'up' || raw === 'down' ? raw : null;
        const ok = store.setTurnFeedback(fbAppId, fbSessionId, fbTurnId, feedback);
        if (!ok) {
          sendError(res, 404, 'turn not found');
          return true;
        }
        sendJson(res, 200, { ok: true, feedback });
        return true;
      }

      // Lightweight turn-settle poll (issue #420, Wave 6): the client's
      // reconnect catch-up path polls this after a mid-stream drop to learn
      // whether the turn finished server-side (its `turnCount` climbed) before
      // reloading the full transcript. Cheap — one conversations-row read, no
      // item reconstruction. Matched BEFORE the generic sessions/<id> route.
      const statusMatch = sub.match(/^\/apps\/([^/]+)\/sessions\/([^/]+)\/status\/?$/);
      if (statusMatch && statusMatch[1] && statusMatch[2]) {
        if (method !== 'GET') {
          sendError(res, 405, 'method not allowed');
          return true;
        }
        const stAppId = decodeURIComponent(statusMatch[1]);
        const stId = decodeURIComponent(statusMatch[2]);
        const meta = store.getSessionMeta(stAppId, stId);
        if (!meta) {
          sendError(res, 404, 'session not found');
          return true;
        }
        sendJson(res, 200, { turnCount: meta.turnCount, updatedAt: meta.updatedAt });
        return true;
      }

      // Conversation FTS search (issue #420) — matched BEFORE the generic
      // sessions/<id> route so "search" isn't read as a session id:
      //   GET /apps/<appId>/sessions/search?q=<query>&limit=<n>  → { results }
      const searchMatch = sub.match(/^\/apps\/([^/]+)\/sessions\/search\/?$/);
      if (searchMatch && searchMatch[1]) {
        if (method !== 'GET') {
          sendError(res, 405, 'method not allowed');
          return true;
        }
        const searchAppId = decodeURIComponent(searchMatch[1]);
        const q = url.searchParams.get('q') ?? '';
        const limitParam = Number(url.searchParams.get('limit'));
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20;
        sendJson(res, 200, { results: store.searchSessions(searchAppId, q, limit) });
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
        // Archive-aware read (issue #438 wave 3): serves live rows and merges
        // any custody-gated-pruned history back from the CAS, read-only.
        const full = await store.getSessionRehydrated(appId, id);
        if (!full) {
          sendError(res, 404, 'session not found');
          return true;
        }
        sendJson(res, 200, full);
        return true;
      }
      if (method === 'PATCH') {
        const body = (await readJsonBody(req)) as
          | { title?: unknown; pinned?: unknown; archived?: unknown }
          | undefined;
        // One PATCH surface for rename + pin + archive (issue #420). Any subset
        // of fields may be present; each provided field is applied in turn and
        // the last successful update's fresh summary is returned.
        let updated: ConversationSummary | undefined;
        let touched = false;
        if (typeof body?.title === 'string') {
          touched = true;
          updated = store.renameSession(appId, id, body.title);
          if (!updated) {
            sendError(res, 404, 'session not found');
            return true;
          }
        }
        if (typeof body?.pinned === 'boolean') {
          touched = true;
          updated = store.setSessionPinned(appId, id, body.pinned);
          if (!updated) {
            sendError(res, 404, 'session not found');
            return true;
          }
        }
        if (typeof body?.archived === 'boolean') {
          touched = true;
          updated = store.setSessionArchived(appId, id, body.archived);
          if (!updated) {
            sendError(res, 404, 'session not found');
            return true;
          }
        }
        if (!touched) {
          // Back-compat: a bare PATCH with no recognized field is a rename to ''.
          updated = store.renameSession(appId, id, '');
        }
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
