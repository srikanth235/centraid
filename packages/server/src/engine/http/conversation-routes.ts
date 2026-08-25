/*
 * Route dispatcher for the conversation-history store. Schema, SQL, and
 * per-user scoping stay in `history.ts` so they audit in one place.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  ConversationHistoryStore,
  ConversationSummary,
  TranscriptWindow,
} from "../conversation/history.js";
import { sendJsonNegotiated } from "./compression.js";

/**
 * Absent ⇒ whole transcript. Malformed is REJECTED, never ignored: a dropped
 * `beforeSeq` reads to the client as "the conversation ends here" (#659).
 */
function parseTranscriptWindow(url: URL): TranscriptWindow | "invalid" {
  const window: TranscriptWindow = {};
  for (const [param, key] of [
    ["turns", "limit"],
    ["beforeSeq", "beforeSeq"],
  ] as const) {
    const raw = url.searchParams.get(param);
    if (raw === null) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) return "invalid";
    window[key] = value;
  }
  return window;
}

const ROUTE_PREFIX = "/_centraid-conversations";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.byteLength;
    if (total > MAX_UPLOAD_BYTES)
      throw new Error(`upload exceeds ${MAX_UPLOAD_BYTES} bytes`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  if (raw.length === 0) return undefined;
  const text = raw.toString("utf8");
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text).toString(),
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * Keep the store behind `getStore()`: SQLite must open only in the gateway
 * process, never in harness workers. Every route carries the owning `appId`
 * (#98); per-user scoping stays in the store's `userIdProvider`. Transcripts
 * are never appended over HTTP — a turn is a `runs` row from `_turn`.
 */
export function makeConversationRouteHandler(
  getStore: () => ConversationHistoryStore
) {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    if (!req.url || !req.url.startsWith(ROUTE_PREFIX)) return false;
    // Dummy host: IncomingMessage.url is path-only.
    const url = new URL(req.url, "http://x");
    const sub = url.pathname.slice(ROUTE_PREFIX.length);
    const method = (req.method ?? "GET").toUpperCase();
    const store = getStore();

    try {
      const blobMatch = sub.match(
        /^\/apps\/(?<appId>[^/]+)\/blobs(?:\/(?<hash>[a-f0-9]{64}))?\/?$/u
      );
      const blobAppId = blobMatch?.groups?.appId;
      if (blobAppId) {
        const appId = decodeURIComponent(blobAppId);
        const hash = blobMatch?.groups?.hash;
        if (!hash && method === "POST") {
          const bytes = await readRawBody(req);
          if (bytes.length === 0) {
            sendError(res, 400, "empty upload");
            return true;
          }
          const put = await store.uploadBlob(appId, bytes);
          const mime =
            req.headers["content-type"] ?? "application/octet-stream";
          sendJson(res, 200, {
            hash: put.hash,
            sizeBytes: put.sizeBytes,
            mime,
            url: `${ROUTE_PREFIX}/apps/${encodeURIComponent(appId)}/blobs/${put.hash}`,
          });
          return true;
        }
        if (hash && method === "GET") {
          const bytes = await store.readBlob(appId, hash);
          if (!bytes) {
            sendError(res, 404, "blob not found");
            return true;
          }
          const mime =
            url.searchParams.get("mime") ?? "application/octet-stream";
          res.writeHead(200, {
            "content-type": mime,
            "content-length": bytes.byteLength.toString(),
            "cache-control": "private, max-age=31536000, immutable",
          });
          res.end(bytes);
          return true;
        }
        sendError(res, 405, "method not allowed");
        return true;
      }

      const fb = sub.match(
        /^\/apps\/(?<appId>[^/]+)\/sessions\/(?<sessionId>[^/]+)\/turns\/(?<turnId>[^/]+)\/feedback\/?$/u
      );
      const fbGroups = fb?.groups;
      if (fbGroups?.appId && fbGroups.sessionId && fbGroups.turnId) {
        if (method !== "PATCH") {
          sendError(res, 405, "method not allowed");
          return true;
        }
        const fbAppId = decodeURIComponent(fbGroups.appId);
        const fbSessionId = decodeURIComponent(fbGroups.sessionId);
        const fbTurnId = decodeURIComponent(fbGroups.turnId);
        const body = (await readJsonBody(req)) as
          | { feedback?: unknown }
          | undefined;
        const raw = body?.feedback;
        const feedback = raw === "up" || raw === "down" ? raw : null;
        const ok = store.setTurnFeedback(
          fbAppId,
          fbSessionId,
          fbTurnId,
          feedback
        );
        if (!ok) {
          sendError(res, 404, "turn not found");
          return true;
        }
        sendJson(res, 200, { ok: true, feedback });
        return true;
      }

      // Turn-settle poll (#420). Must match BEFORE sessions/<id>.
      const statusMatch = sub.match(
        /^\/apps\/(?<appId>[^/]+)\/sessions\/(?<sessionId>[^/]+)\/status\/?$/u
      );
      const statusGroups = statusMatch?.groups;
      if (statusGroups?.appId && statusGroups.sessionId) {
        if (method !== "GET") {
          sendError(res, 405, "method not allowed");
          return true;
        }
        const stAppId = decodeURIComponent(statusGroups.appId);
        const stId = decodeURIComponent(statusGroups.sessionId);
        const meta = store.getSessionMeta(stAppId, stId);
        if (!meta) {
          sendError(res, 404, "session not found");
          return true;
        }
        sendJson(res, 200, {
          turnCount: meta.turnCount,
          updatedAt: meta.updatedAt,
        });
        return true;
      }

      // Must match BEFORE sessions/<id> so "search" isn't read as a session id.
      const searchMatch = sub.match(
        /^\/apps\/(?<appId>[^/]+)\/sessions\/search\/?$/u
      );
      const searchAppIdRaw = searchMatch?.groups?.appId;
      if (searchAppIdRaw) {
        if (method !== "GET") {
          sendError(res, 405, "method not allowed");
          return true;
        }
        const searchAppId = decodeURIComponent(searchAppIdRaw);
        const q = url.searchParams.get("q") ?? "";
        const limitParam = Number(url.searchParams.get("limit"));
        const limit =
          Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20;
        sendJson(res, 200, {
          results: store.searchSessions(searchAppId, q, limit),
        });
        return true;
      }

      const m = sub.match(
        /^\/apps\/(?<appId>[^/]+)\/sessions(?:\/(?<sessionId>[^/]+))?\/?$/u
      );
      const rawAppId = m?.groups?.appId;
      if (!rawAppId) {
        sendError(res, 404, "unknown conversation route");
        return true;
      }
      const appId = decodeURIComponent(rawAppId);
      const rawSessionId = m?.groups?.sessionId;
      const id = rawSessionId ? decodeURIComponent(rawSessionId) : undefined;

      if (!id) {
        if (method === "GET") {
          sendJson(res, 200, { sessions: store.listSessions(appId) });
          return true;
        }
        if (method === "POST") {
          const body = (await readJsonBody(req)) as
            | { title?: string }
            | undefined;
          sendJson(res, 200, store.createSession(appId, body?.title ?? ""));
          return true;
        }
        sendError(res, 405, "method not allowed");
        return true;
      }

      if (method === "GET") {
        // Archive-aware (#438): merges pruned history from the CAS, read-only.
        // A paged response carries ONLY that page's messages (#659).
        const window = parseTranscriptWindow(url);
        if (window === "invalid") {
          sendError(res, 400, "turns and beforeSeq must be positive integers");
          return true;
        }
        const full = await store.getSessionRehydrated(appId, id, window);
        if (!full) {
          sendError(res, 404, "session not found");
          return true;
        }
        // Whole transcripts are the one large response here; negotiate (#659).
        await sendJsonNegotiated(req, res, 200, full);
        return true;
      }
      if (method === "PATCH") {
        const body = (await readJsonBody(req)) as
          | { title?: unknown; pinned?: unknown; archived?: unknown }
          | undefined;
        // Any subset may be present; the last update's summary wins (#420).
        let updated: ConversationSummary | undefined;
        let touched = false;
        if (typeof body?.title === "string") {
          touched = true;
          updated = store.renameSession(appId, id, body.title);
          if (!updated) {
            sendError(res, 404, "session not found");
            return true;
          }
        }
        if (typeof body?.pinned === "boolean") {
          touched = true;
          updated = store.setSessionPinned(appId, id, body.pinned);
          if (!updated) {
            sendError(res, 404, "session not found");
            return true;
          }
        }
        if (typeof body?.archived === "boolean") {
          touched = true;
          updated = store.setSessionArchived(appId, id, body.archived);
          if (!updated) {
            sendError(res, 404, "session not found");
            return true;
          }
        }
        if (!touched) {
          // A bare PATCH with no recognized field is a rename to ''.
          updated = store.renameSession(appId, id, "");
        }
        if (!updated) {
          sendError(res, 404, "session not found");
          return true;
        }
        sendJson(res, 200, updated);
        return true;
      }
      if (method === "DELETE") {
        const ok = store.deleteSession(appId, id);
        sendJson(res, ok ? 200 : 404, { ok });
        return true;
      }
      sendError(res, 405, "method not allowed");
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      sendError(res, 500, msg);
      return true;
    }
  };
}
