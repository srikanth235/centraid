/*
 * Gateway control plane (issue #555).
 *
 * `gateway.db` is both the complete gateway-level state store and the
 * single-process lock. Vault existence is deliberately absent from this
 * schema: the filesystem registry remains authoritative, so no second
 * catalog can disagree with it.
 */

import { chmodSync, mkdirSync, statfsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  /** Detection override for deterministic host-safety integration tests. */
  networkFileSystem?: boolean;
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
      // A `read-only` open against an EXCLUSIVE-locked database SUCCEEDS —
      // the constructor and the pragmas above never touch a page, so the
      // lock is not observed until the first real read. Probe here so the
      // caller's `GatewayLockError` handling gets its chance, instead of a
      // raw `ERR_SQLITE_ERROR: database is locked` escaping from whatever
      // SELECT happens to run first (issue #568 item H).
      if (lockMode === 'read-only') db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
      return new GatewayDatabase(
        file,
        db,
        lockMode,
        options.networkFileSystem ?? detectNetworkFileSystem(root),
      );
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
    /*
     * L2 — principals (issue #599). A member is a human on this household
     * gateway: a stable id the whole system keys on, plus an editable label.
     * People-as-principals live here; people-as-data live in the vault's
     * 'core_party'. There is deliberately no pointer between them.
     */
    CREATE TABLE IF NOT EXISTS members (
      member_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    /*
     * L3 — authorization. Authority is authored HERE and nowhere else: the
     * effective role of a device in a vault is its member's row in this
     * table, and an absent row means no access at all. Every vault keeps at
     * least one 'admin' member (the founding invariant, read as ownership).
     */
    CREATE TABLE IF NOT EXISTS member_roles (
      member_id TEXT NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'write', 'read')),
      PRIMARY KEY (member_id, vault_id)
    ) STRICT;
    /*
     * L1 — authentication. A device row is a pure BINDING of a proved iroh
     * EndpointId to a member; it carries no authored authority (no role
     * column, no per-vault fan-out). 'revoked' is the device-level tombstone
     * — "this phone was stolen" — and leaves the member untouched.
     */
    CREATE TABLE IF NOT EXISTS devices (
      enrollment_id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL UNIQUE,
      member_id TEXT NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      platform TEXT,
      remember_device INTEGER NOT NULL CHECK (remember_device IN (0, 1)),
      grant_profile_json TEXT,
      compute_json TEXT,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
      added_at TEXT NOT NULL
    ) STRICT;
    /*
     * Replica checkpoints are the one genuinely per-(device, vault) fact, so
     * they keep their own table now that 'devices' no longer fans out.
     */
    CREATE TABLE IF NOT EXISTS device_checkpoints (
      endpoint_id TEXT NOT NULL REFERENCES devices(endpoint_id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL,
      PRIMARY KEY (endpoint_id, vault_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      device_key TEXT REFERENCES devices(endpoint_id) ON DELETE CASCADE,
      shell_origin TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    ) STRICT;
    /*
     * A ticket is an INVITATION: which member the joining device binds to,
     * and the full grant list that member must hold once it redeems. One
     * scan, many vaults, atomically. There is only one kind of ticket since
     * #603 retired the founding ceremony — a gateway founds itself.
     */
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      member_id TEXT NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
      grants_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS erase_intents (
      vault_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    ) STRICT;
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

/** Remote filesystem names as BSD `statfs.f_fstypename` reports them. */
const DARWIN_NETWORK_FS_TYPES = new Set(['nfs', 'smbfs', 'afpfs', 'webdav', 'ftpfs']);

/**
 * macOS has no filesystem magic to read: `statfsSync().type` is a BSD
 * `f_type` index, not a Linux magic number. The filesystem NAME lives in
 * `statfs.f_fstypename`, which `/sbin/mount` prints per mount point.
 *
 * The previous attempt shelled out to `/usr/bin/stat -f '%T'` — but BSD
 * `stat -f` takes a FORMAT STRING and `%T` is the `ls -F` type indicator
 * (`@`, `/`, empty), never a filesystem type. It exited 0 with a value the
 * regex could not match, and that success also short-circuited the Linux
 * `statfsSync` fallback, so darwin detection was a guaranteed `false`
 * (issue #568 item I).
 */
export function parseDarwinFileSystemType(mountOutput: string, root: string): string | undefined {
  // `mount` lines read: `<source> on <mount point> (<fstype>, <opts…>)`.
  let best: { mountPoint: string; type: string } | undefined;
  for (const line of mountOutput.split('\n')) {
    const match = /^.* on (.+) \(([^,)]+)[,)]/.exec(line.trim());
    const mountPoint = match?.[1];
    const type = match?.[2];
    if (!mountPoint || !type) continue;
    const contains =
      root === mountPoint || root.startsWith(mountPoint === '/' ? '/' : `${mountPoint}${path.sep}`);
    if (!contains) continue;
    // Longest matching mount point wins — `/Volumes/share` beats `/`.
    if (!best || mountPoint.length > best.mountPoint.length) best = { mountPoint, type };
  }
  return best?.type.trim().toLowerCase();
}

/** True/false when the mount table answered; `undefined` when it could not. */
export function darwinNetworkFileSystem(
  root: string,
  readMountTable: () => string | undefined = defaultMountTable,
): boolean | undefined {
  const output = readMountTable();
  if (output === undefined) return undefined;
  const type = parseDarwinFileSystemType(output, root);
  return type === undefined ? undefined : DARWIN_NETWORK_FS_TYPES.has(type);
}

function defaultMountTable(): string | undefined {
  const result = spawnSync('/sbin/mount', [], { encoding: 'utf8', timeout: 2_000 });
  return result.status === 0 && typeof result.stdout === 'string' ? result.stdout : undefined;
}

function detectNetworkFileSystem(root: string): boolean {
  try {
    if (process.platform === 'darwin') {
      const remote = darwinNetworkFileSystem(root);
      // Fall through to `statfsSync` when the mount table is unreadable
      // rather than early-returning `false` — an undetected remote mount is
      // the failure mode this whole probe exists to prevent.
      if (remote !== undefined) return remote;
    }
    const type = Number(statfsSync(root).type);
    // Linux NFS, SMB/CIFS. ZFS is intentionally local: treating its magic as
    // remote permanently disabled orphan collection on ordinary local pools.
    return new Set([0x6969, 0x517b, 0xff534d42]).has(type);
  } catch {
    return false;
  }
}
