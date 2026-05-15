/*
 * Centraid user store.
 *
 * A single shared SQLite database — `<stateDir>/centraid-user.sqlite` —
 * that holds:
 *   1. The single user identity UUID (generated on first open).
 *   2. Global user preferences (theme, density, accent, …) keyed by
 *      string keys, with arbitrary JSON-serialisable values.
 *
 * The "user" here is the single user of this Claude Code installation —
 * there is no multi-user model. Prefs sync naturally across devices to
 * whichever gateway the desktop is pointed at; identity comes from the
 * gateway, not the OS user.
 *
 * Exposed over HTTP at the `/_centraid-user` prefix. Mounted in two places
 * with identical surface area:
 *   - the OpenClaw plugin (remote gateway) via `api.registerHttpRoute`
 *   - `startRuntimeHttpServer` for the desktop's embedded local runtime
 *
 * The desktop main process is the only HTTP client; auth is the same
 * bearer token the surrounding gateway already enforces.
 *
 * Schema layout:
 *   user_meta(key, value)   — one row keyed by `id`, value is the UUID
 *   user_prefs(key, value)  — value is a JSON-encoded scalar/object
 *
 * Schema changes flow through the `MIGRATIONS` ladder, same pattern as
 * `chat-history.ts` — append, never edit shipped slots, tracked via
 * `PRAGMA user_version`.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const MIGRATIONS: readonly string[] = [
  // 0 → 1: baseline schema. Two tiny key/value tables; the identity row
  // lives alongside prefs so a single sqlite file is all the user-scope
  // state we keep next to the chat-history db.
  `
    CREATE TABLE IF NOT EXISTS user_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_prefs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `,
];

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `user store DB is at version ${current} but this build only supports up to ${MIGRATIONS.length}. ` +
        `Please update centraid before opening this database.`,
    );
  }
  if (current === MIGRATIONS.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
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
}

interface PreparedStatements {
  getMeta: StatementSync;
  setMeta: StatementSync;
  listPrefs: StatementSync;
  setPref: StatementSync;
  deletePref: StatementSync;
}

export class UserStore {
  private readonly dbPath: string;
  // Both `db` and `stmts` are populated lazily on first access. The plugin
  // shim is constructed in every OpenClaw worker subprocess, but only the
  // gateway worker actually serves the routes that touch this store —
  // deferring the sqlite open keeps stray DB handles out of workers that
  // never read or write user state.
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private ensureOpen(): { db: DatabaseSync; stmts: PreparedStatements } {
    if (this.db && this.stmts) return { db: this.db, stmts: this.stmts };
    const db = new DatabaseSync(this.dbPath);
    db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
    `);
    migrate(db);
    const stmts: PreparedStatements = {
      getMeta: db.prepare(`SELECT value FROM user_meta WHERE key = ?`),
      setMeta: db.prepare(
        `INSERT INTO user_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ),
      listPrefs: db.prepare(`SELECT key, value FROM user_prefs`),
      setPref: db.prepare(
        `INSERT INTO user_prefs (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ),
      deletePref: db.prepare(`DELETE FROM user_prefs WHERE key = ?`),
    };
    this.db = db;
    this.stmts = stmts;
    return { db, stmts };
  }

  /**
   * Return the user UUID, generating + persisting one on first call. This
   * is the install-hook moment for the gateway: a fresh sqlite file picks
   * up its identity here, and the same UUID is handed out for the lifetime
   * of the file.
   */
  getUserId(): string {
    const { stmts } = this.ensureOpen();
    const row = stmts.getMeta.get('id') as { value: string } | undefined;
    if (row && typeof row.value === 'string' && row.value.length > 0) return row.value;
    const id = randomUUID();
    stmts.setMeta.run('id', id);
    return id;
  }

  /**
   * Read every pref as a `Record<string, unknown>`. Values are JSON-decoded;
   * any row that fails to parse is skipped (defensive — should not happen
   * because we always write through `setPrefs`).
   */
  getAllPrefs(): Record<string, unknown> {
    const { stmts } = this.ensureOpen();
    const rows = stmts.listPrefs.all() as Array<{ key: string; value: string }>;
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
   * Merge a patch into the prefs store. `undefined` and `null` values are
   * treated as deletions so callers can clear a key by sending `{ foo: null }`.
   * The merge is transactional so half-applied patches never appear.
   */
  setPrefs(patch: Record<string, unknown>): Record<string, unknown> {
    const keys = Object.keys(patch);
    if (keys.length === 0) return this.getAllPrefs();
    const { db, stmts } = this.ensureOpen();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const k of keys) {
        const v = patch[k];
        if (v === undefined || v === null) {
          stmts.deletePref.run(k);
        } else {
          stmts.setPref.run(k, JSON.stringify(v));
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
