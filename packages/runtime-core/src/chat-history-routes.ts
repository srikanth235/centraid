/*
 * HTTP route dispatcher for the chat-history store.
 *
 * Mounted under `/_centraid-chat` by both gateway hosts:
 *   - the OpenClaw plugin (remote gateway) via `api.registerHttpRoute`
 *   - `startRuntimeHttpServer` for the desktop's embedded local runtime
 *
 * The store itself lives in `chat-history.ts`. This module is split out
 * purely for file-size reasons — keeping the store, its schema, and its
 * SQL prepared statements in one file (where the per-user scoping rules
 * are easier to audit at a glance) is the more important constraint.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ChatHistoryStore } from './chat-history.js';

const ROUTE_PREFIX = '/_centraid-chat';

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
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
 * Build the chat-history HTTP route handler. The store is resolved lazily
 * via `getStore()` so the SQLite connection only opens in the gateway
 * process (route handlers don't fire in agent-worker contexts), avoiding
 * stray DB handles in subprocesses that never touch chat history.
 *
 * Per-user scoping is enforced inside the store, not here — the handler
 * never sees the user UUID because `ChatHistoryStore` resolves it itself
 * via the `userIdProvider` it was constructed with.
 *
 * Dispatch map:
 *   GET    /_centraid-chat/sessions?appId=...           list (appId = origin app)
 *   POST   /_centraid-chat/sessions                     create  body: {appId?, mode?, title?}
 *   GET    /_centraid-chat/sessions/<id>                load (with messages)
 *   PATCH  /_centraid-chat/sessions/<id>                rename  body: {title}
 *   DELETE /_centraid-chat/sessions/<id>                delete
 *   POST   /_centraid-chat/sessions/<id>/messages       batch append
 *                                                       body: {payloads: [...], appId?}
 */
export function makeChatHistoryRouteHandler(getStore: () => ChatHistoryStore) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!req.url || !req.url.startsWith(ROUTE_PREFIX)) return false;
    // Use a dummy host because IncomingMessage.url is path-only.
    const url = new URL(req.url, 'http://x');
    const sub = url.pathname.slice(ROUTE_PREFIX.length); // e.g. "/sessions/abc/messages"
    const method = (req.method ?? 'GET').toUpperCase();
    const store = getStore();

    try {
      if (sub === '/sessions' || sub === '/sessions/') {
        if (method === 'GET') {
          const appId = url.searchParams.get('appId');
          if (!appId) {
            sendError(res, 400, 'appId is required');
            return true;
          }
          sendJson(res, 200, { sessions: store.listSessions(appId) });
          return true;
        }
        if (method === 'POST') {
          const body = (await readJsonBody(req)) as
            | { appId?: string; mode?: string; title?: string }
            | undefined;
          const mode = body?.mode === 'data' ? 'data' : 'full';
          sendJson(res, 200, store.createSession(body?.appId ?? null, mode, body?.title ?? ''));
          return true;
        }
        sendError(res, 405, 'method not allowed');
        return true;
      }

      // /sessions/<id> or /sessions/<id>/messages
      const m = sub.match(/^\/sessions\/([^/]+)(?:\/(messages))?\/?$/);
      if (m && m[1]) {
        const id = decodeURIComponent(m[1]);
        const tail = m[2];
        if (tail === 'messages') {
          if (method !== 'POST') {
            sendError(res, 405, 'method not allowed');
            return true;
          }
          const body = (await readJsonBody(req)) as
            | { payloads?: unknown; appId?: string }
            | undefined;
          if (!Array.isArray(body?.payloads)) {
            sendError(res, 400, 'payloads must be an array');
            return true;
          }
          const result = store.appendMessages(id, body.payloads, body.appId ?? null);
          if (!result) {
            sendError(res, 404, 'session not found');
            return true;
          }
          sendJson(res, 200, result);
          return true;
        }
        if (method === 'GET') {
          const full = store.getSession(id);
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
          const updated = store.renameSession(id, title);
          if (!updated) {
            sendError(res, 404, 'session not found');
            return true;
          }
          sendJson(res, 200, updated);
          return true;
        }
        if (method === 'DELETE') {
          const ok = store.deleteSession(id);
          sendJson(res, ok ? 200 : 404, { ok });
          return true;
        }
      }

      sendError(res, 404, 'unknown chat-history route');
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendError(res, 500, msg);
      return true;
    }
  };
}
