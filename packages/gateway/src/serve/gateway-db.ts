/*
 * Gateway control plane (issue #555).
 *
 * `gateway.db` is both the complete gateway-level state store and the
 * single-process lock. Vault existence is deliberately absent from this
 * schema: the filesystem registry remains authoritative, so the founding
 * gate cannot disagree with a second catalog.
 */

import { chmodSync, mkdirSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

export const GATEWAY_DB_FILE = 'gateway.db';

export type GatewayDbLockMode = 'exclusive' | 'read-only' | 'shared';

export class GatewayLockError extends Error {
  constructor(readonly file: string) {
    super(
      `another Centraid gateway holds ${file}; stop the running daemon before retrying this mutating command`,
    );
    this.name = 'GatewayLockError';
  }
}

export interface OpenGatewayDatabaseOptions {
  lock?: GatewayDbLockMode;
}

/* eslint-disable max-classes-per-file -- the typed lock refusal and the database handle form one gateway.db boundary (#555) */
export class GatewayDatabase {
  readonly file: string;
  readonly db: DatabaseSync;
  readonly lockMode: GatewayDbLockMode;
  readonly networkFileSystem: boolean;
  private closed = false;

  private constructor(
    file: string,
    db: DatabaseSync,
    lockMode: GatewayDbLockMode,
    networkFileSystem: boolean,
  ) {
    this.file = file;
    this.db = db;
    this.lockMode = lockMode;
    this.networkFileSystem = networkFileSystem;
  }

  static open(dataDir: string, options: OpenGatewayDatabaseOptions = {}): GatewayDatabase {
    const root = path.resolve(dataDir);
    const file = path.join(root, GATEWAY_DB_FILE);
    const lockMode = options.lock ?? 'shared';
    if (lockMode !== 'read-only') mkdirSync(root, { recursive: true });

    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, {
        readOnly: lockMode === 'read-only',
        timeout: 0,
      });
    } catch (error) {
      if (isBusy(error)) throw new GatewayLockError(file);
      throw error;
    }

    try {
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;');
      if (lockMode !== 'read-only') {
        db.exec('PRAGMA journal_mode = DELETE;');
        installGatewaySchema(db);
        chmodSync(file, 0o600);
      }
      if (lockMode === 'exclusive') acquireExclusiveLifetimeLock(db, file);
      return new GatewayDatabase(file, db, lockMode, detectNetworkFileSystem(root));
    } catch (error) {
      db.close();
      if (isBusy(error)) throw new GatewayLockError(file);
      throw error;
    }
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original error when SQLite already rolled back.
      }
      throw error;
    }
  }

  prefRows(): Array<{ key: string; value_json: string }> {
    return this.db.prepare('SELECT key, value_json FROM prefs ORDER BY key').all() as Array<{
      key: string;
      value_json: string;
    }>;
  }

  setPref(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO prefs (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(key, JSON.stringify(value));
  }

  deletePref(key: string): void {
    this.db.prepare('DELETE FROM prefs WHERE key = ?').run(key);
  }

  replacePrefs(prefs: Record<string, unknown>): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM prefs');
      for (const [key, value] of Object.entries(prefs)) this.setPref(key, value);
    });
  }

  run(sql: string, ...values: SQLInputValue[]): void {
    this.db.prepare(sql).run(...values);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function acquireExclusiveLifetimeLock(db: DatabaseSync, file: string): void {
  try {
    const row = db.prepare('PRAGMA locking_mode = EXCLUSIVE').get() as
      | { locking_mode?: string }
      | undefined;
    if (row?.locking_mode?.toLowerCase() !== 'exclusive') {
      throw new Error(`SQLite refused exclusive locking_mode for ${file}`);
    }
    // A completed write transaction makes EXCLUSIVE mode retain the OS lock
    // until this handle closes. No long-running transaction is needed.
    db.exec(
      `BEGIN EXCLUSIVE;
       INSERT INTO gateway_meta (key, value) VALUES ('schema', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;
       COMMIT;`,
    );
  } catch (error) {
    if (isBusy(error)) throw new GatewayLockError(file);
    throw error;
  }
}

function installGatewaySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS prefs (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS devices (
      enrollment_id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      label TEXT NOT NULL,
      platform TEXT,
      trust TEXT NOT NULL CHECK (trust IN ('owner', 'full', 'readonly', 'revoked')),
      remember_device INTEGER NOT NULL CHECK (remember_device IN (0, 1)),
      grant_profile_json TEXT,
      compute_json TEXT,
      checkpoint_json TEXT,
      added_at TEXT NOT NULL,
      UNIQUE (endpoint_id, vault_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      device_key TEXT,
      shell_origin TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      FOREIGN KEY (device_key, vault_id)
        REFERENCES devices(endpoint_id, vault_id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('found', 'enroll')),
      secret_hash TEXT NOT NULL,
      vault_id TEXT,
      trust TEXT,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      CHECK (
        (kind = 'found' AND vault_id IS NULL AND trust IS NULL) OR
        (kind = 'enroll' AND vault_id IS NOT NULL AND
          trust IN ('owner', 'full', 'readonly'))
      )
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_founding_ticket
      ON tickets(kind) WHERE kind = 'found';
    CREATE TABLE IF NOT EXISTS recovery_kit (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      confirmed_at INTEGER,
      kit_fingerprint TEXT,
      kit_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (kit_confirmed IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS backup_targets (
      target_id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS cas_reconciliations (
      vault_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS storage_connections (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind = 'provider'),
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      sealed_credentials TEXT NOT NULL,
      target_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS storage_limits (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      total_limit_bytes INTEGER,
      warn_at_percent REAL NOT NULL,
      journal_limit_bytes INTEGER
    ) STRICT;
  `);
}

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === 'ERR_SQLITE_ERROR' && /busy|locked/i.test(error.message);
}

function detectNetworkFileSystem(root: string): boolean {
  try {
    const type = Number(statfsSync(root).type);
    // Linux NFS, SMB/CIFS, and macOS SMBFS/NFS values. Unknown filesystems
    // remain local by default; callers surface a warning when this is true.
    return new Set([0x6969, 0x517b, 0xff534d42, 0x2fc12fc1]).has(type);
  } catch {
    return false;
  }
}
