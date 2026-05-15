/*
 * Centraid user store.
 *
 * Wraps the shared gateway SQLite (see `gateway-db.ts`) to read/write the
 * `users` and `user_prefs` tables. Holds:
 *
 *   1. The single user identity UUID, generated on first `getUserId()`
 *      call. The "users" row is the install-hook moment for the gateway —
 *      a fresh DB picks up its identity here, and the same UUID is handed
 *      out for the lifetime of the file.
 *   2. Global user preferences (theme, density, accent, …) keyed by
 *      `(user_id, key)` with JSON-encoded values.
 *
 * Single-user model today: `getUserId()` always returns the lone row's
 * id and `getAllPrefs()`/`setPrefs()` always operate on that user. The
 * schema is multi-user-ready so a future shift doesn't need a
 * column-add migration.
 *
 * Exposed over HTTP at the `/_centraid-user` prefix. Mounted in two
 * places with identical surface area:
 *   - the OpenClaw plugin (remote gateway) via `api.registerHttpRoute`
 *   - `startRuntimeHttpServer` for the desktop's embedded local runtime
 *
 * The desktop main process is the only HTTP client; auth is the same
 * bearer token the surrounding gateway already enforces.
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseProvider } from './gateway-db.js';

interface PreparedStatements {
  getAnyUser: StatementSync;
  insertUser: StatementSync;
  listPrefs: StatementSync;
  setPref: StatementSync;
  deletePref: StatementSync;
}

export class UserStore {
  private readonly dbProvider: DatabaseProvider;
  // Both `db` and `stmts` are populated lazily on the first method call.
  // The plugin shim is constructed in every OpenClaw worker subprocess —
  // the lazy open keeps stray DB handles out of workers that never read
  // or write user state.
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;

  constructor(dbProvider: DatabaseProvider) {
    this.dbProvider = dbProvider;
  }

  private ensureReady(): { db: DatabaseSync; stmts: PreparedStatements } {
    if (this.db && this.stmts) return { db: this.db, stmts: this.stmts };
    const db = this.dbProvider();
    const stmts: PreparedStatements = {
      // Single-user model — there's exactly one row in `users`. We just
      // grab it; ordering doesn't matter because there's only ever one.
      getAnyUser: db.prepare(`SELECT id FROM users LIMIT 1`),
      insertUser: db.prepare(`INSERT INTO users (id, created_at) VALUES (?, ?)`),
      listPrefs: db.prepare(`SELECT key, value FROM user_prefs WHERE user_id = ?`),
      setPref: db.prepare(
        `INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`,
      ),
      deletePref: db.prepare(`DELETE FROM user_prefs WHERE user_id = ? AND key = ?`),
    };
    this.db = db;
    this.stmts = stmts;
    return { db, stmts };
  }

  /**
   * Return the user UUID, generating + persisting one on first call. This
   * is the install-hook moment for the gateway: a fresh DB picks up its
   * identity here, and the same UUID is handed out for the lifetime of
   * the file.
   */
  getUserId(): string {
    const { stmts } = this.ensureReady();
    const row = stmts.getAnyUser.get() as { id: string } | undefined;
    if (row && typeof row.id === 'string' && row.id.length > 0) return row.id;
    const id = randomUUID();
    stmts.insertUser.run(id, Date.now());
    return id;
  }

  /**
   * Read every pref for the current user as a `Record<string, unknown>`.
   * Values are JSON-decoded; any row that fails to parse is skipped
   * (defensive — should not happen because we always write through
   * `setPrefs`).
   */
  getAllPrefs(): Record<string, unknown> {
    const { stmts } = this.ensureReady();
    const userId = this.getUserId();
    const rows = stmts.listPrefs.all(userId) as Array<{ key: string; value: string }>;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value) as unknown;
      } catch {
        /* skip malformed row */
      }
    }
    return out;
  }

  /**
   * Merge a patch into the prefs store for the current user. `undefined`
   * and `null` values are treated as deletions so callers can clear a key
   * by sending `{ foo: null }`. The merge is transactional so half-applied
   * patches never appear.
   */
  setPrefs(patch: Record<string, unknown>): Record<string, unknown> {
    const keys = Object.keys(patch);
    if (keys.length === 0) return this.getAllPrefs();
    const { db, stmts } = this.ensureReady();
    const userId = this.getUserId();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const k of keys) {
        const v = patch[k];
        if (v === undefined || v === null) {
          stmts.deletePref.run(userId, k);
        } else {
          stmts.setPref.run(userId, k, JSON.stringify(v));
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
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
 * Build the user-store HTTP route handler. Store is resolved lazily so the
 * sqlite file only opens when the desktop first asks for an id or prefs.
 *
 * Dispatch map:
 *   GET  /_centraid-user/id     → { id }
 *   GET  /_centraid-user/prefs  → { prefs: Record<string, unknown> }
 *   PUT  /_centraid-user/prefs  body: { patch: Record<string, unknown> }
 *                                → { prefs: Record<string, unknown> }
 */
export function makeUserStoreRouteHandler(getStore: () => UserStore) {
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
        sendJson(res, 200, { id: store.getUserId() });
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
