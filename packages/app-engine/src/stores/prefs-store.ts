/*
 * Centraid gateway prefs store (issue #280).
 *
 * Replaces the old `identity.sqlite` `users` + `user_prefs` pair. The
 * parallel gateway-side user identity is GONE — the vault owner IS the
 * user (`core_vault.owner_party_id`), so the only thing left at the
 * gateway is device-level configuration: which coding agent to run, its
 * binary path, UI theme/density for this host, etc. Those are a handful
 * of keys written from one process — a plain JSON file, not a database.
 *
 * Exposed over HTTP at the `/_centraid-user` prefix (wire surface
 * unchanged so the desktop client keeps working):
 *   GET /_centraid-user/id     → { id }   — the ACTIVE vault's owner party
 *                                 id, via the host-injected provider
 *   GET /_centraid-user/prefs  → { prefs }
 *   PUT /_centraid-user/prefs  body {patch} → { prefs }
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export class PrefsStore {
  private readonly file: string;
  private cache: Record<string, unknown> | undefined;

  /** `file` is the JSON path (e.g. `<dataDir>/prefs.json`). Created lazily. */
  constructor(file: string) {
    this.file = file;
  }

  private load(): Record<string, unknown> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown;
      this.cache =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
    } catch {
      // Missing or unreadable — a fresh host starts empty.
      this.cache = {};
    }
    return this.cache;
  }

  private persist(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.cache ?? {}, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** Every pref as a `Record<string, unknown>` (a defensive copy). */
  getAllPrefs(): Record<string, unknown> {
    return { ...this.load() };
  }

  /**
   * Merge a patch into the store. `undefined` and `null` values are
   * treated as deletions so callers can clear a key by sending
   * `{ foo: null }`. Written atomically (tmp + rename).
   */
  setPrefs(patch: Record<string, unknown>): Record<string, unknown> {
    const keys = Object.keys(patch);
    if (keys.length === 0) return this.getAllPrefs();
    const prefs = this.load();
    for (const k of keys) {
      const v = patch[k];
      if (v === undefined || v === null) delete prefs[k];
      else prefs[k] = v;
    }
    this.persist();
    return this.getAllPrefs();
  }
}

/* ---------- HTTP route handler ---------- */

const ROUTE_PREFIX = '/_centraid-user';

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
 * Build the prefs HTTP route handler (wire prefix `/_centraid-user`, kept
 * for client compatibility). `getOwnerId` backs the `/id` sub-route with
 * the ACTIVE vault's owner party id — the one user identity that exists
 * (#280); without a provider the route 404s.
 */
export function makeUserStoreRouteHandler(getStore: () => PrefsStore, getOwnerId?: () => string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!req.url || !req.url.startsWith(ROUTE_PREFIX)) return false;
    const url = new URL(req.url, 'http://x');
    const sub = url.pathname.slice(ROUTE_PREFIX.length);
    const method = (req.method ?? 'GET').toUpperCase();
    const store = getStore();

    try {
      if (sub === '/id' || sub === '/id/') {
        if (method !== 'GET') {
          sendError(res, 405, 'method not allowed');
          return true;
        }
        if (!getOwnerId) {
          sendError(res, 404, 'no vault mounted — there is no owner identity');
          return true;
        }
        sendJson(res, 200, { id: getOwnerId() });
        return true;
      }
      if (sub === '/prefs' || sub === '/prefs/') {
        if (method === 'GET') {
          sendJson(res, 200, { prefs: store.getAllPrefs() });
          return true;
        }
        if (method === 'PUT') {
          const body = (await readJsonBody(req)) as { patch?: Record<string, unknown> } | undefined;
          const patch = body?.patch;
          if (!patch || typeof patch !== 'object') {
            sendError(res, 400, 'patch object is required');
            return true;
          }
          sendJson(res, 200, { prefs: store.setPrefs(patch) });
          return true;
        }
        sendError(res, 405, 'method not allowed');
        return true;
      }
      sendError(res, 404, 'unknown user-store route');
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendError(res, 500, msg);
      return true;
    }
  };
}
