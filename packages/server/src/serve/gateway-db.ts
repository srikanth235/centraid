/*
 * Gateway control plane (#555).
 *
 * `gateway.db` is both the complete gateway-level state store and the
 * single-process lock. Vault existence is deliberately absent from this
 * schema: the filesystem registry remains authoritative, so no second
 * catalog can disagree with it.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, statfsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import { installGatewaySchema } from "./gateway-schema.js";
import { retireDeadShareEffects } from "./share-effects-retire.js";

export const GATEWAY_DB_FILE = "gateway.db";

export type GatewayDbLockMode = "exclusive" | "read-only" | "shared";

export class GatewayLockError extends Error {
  constructor(readonly file: string) {
    super(
      `another Centraid gateway holds ${file}; stop the running daemon before retrying this mutating command`
    );
    this.name = "GatewayLockError";
  }
}

export interface OpenGatewayDatabaseOptions {
  lock?: GatewayDbLockMode;
  /** Detection override for deterministic host-safety integration tests. */
  networkFileSystem?: boolean;
}

/* oxlint-disable max-classes-per-file -- the typed lock refusal and the database handle form one gateway.db boundary (#555) */
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
    networkFileSystem: boolean
  ) {
    this.file = file;
    this.db = db;
    this.lockMode = lockMode;
    this.networkFileSystem = networkFileSystem;
  }

  static open(
    dataDir: string,
    options: OpenGatewayDatabaseOptions = {}
  ): GatewayDatabase {
    const root = path.resolve(dataDir);
    const file = path.join(root, GATEWAY_DB_FILE);
    const lockMode = options.lock ?? "shared";
    if (lockMode !== "read-only") mkdirSync(root, { recursive: true });

    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, {
        readOnly: lockMode === "read-only",
        timeout: 0,
      });
    } catch (error) {
      if (isBusy(error)) throw new GatewayLockError(file);
      throw error;
    }

    try {
      db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;");
      if (lockMode !== "read-only") {
        db.exec("PRAGMA journal_mode = DELETE;");
        installGatewaySchema(db);
        chmodSync(file, 0o600);
      }
      if (lockMode === "exclusive") acquireExclusiveLifetimeLock(db, file);
      // A `read-only` open against an EXCLUSIVE-locked database SUCCEEDS —
      // the constructor and the pragmas above never touch a page, so the
      // lock is not observed until the first real read. Probe here so the
      // caller's `GatewayLockError` handling gets its chance, instead of a
      // raw `ERR_SQLITE_ERROR: database is locked` escaping from whatever
      // SELECT happens to run first (#568).
      if (lockMode === "read-only")
        db.prepare("SELECT 1 FROM sqlite_schema LIMIT 1").get();
      const opened = new GatewayDatabase(
        file,
        db,
        lockMode,
        options.networkFileSystem ?? detectNetworkFileSystem(root)
      );
      // Durable rows can outlive the transport that created them. A gateway
      // upgraded across #825's copy-as-share retirement still holds queued
      // obligations whose verb no longer exists; they are drained here, once,
      // at the same door the schema is installed at, so no drainer ever sees
      // one. A fresh gateway finds nothing and pays one indexed read.
      if (lockMode !== "read-only") retireDeadShareEffects(opened);
      return opened;
    } catch (error) {
      db.close();
      if (isBusy(error)) throw new GatewayLockError(file);
      throw error;
    }
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original error when SQLite already rolled back.
      }
      throw error;
    }
  }

  prefRows(): Array<{ key: string; value_json: string }> {
    return this.db
      .prepare("SELECT key, value_json FROM prefs ORDER BY key")
      .all() as Array<{
      key: string;
      value_json: string;
    }>;
  }

  setPref(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO prefs (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
      )
      .run(key, JSON.stringify(value));
  }

  deletePref(key: string): void {
    this.db.prepare("DELETE FROM prefs WHERE key = ?").run(key);
  }

  replacePrefs(prefs: Record<string, unknown>): void {
    this.transaction(() => {
      this.db.exec("DELETE FROM prefs");
      for (const [key, value] of Object.entries(prefs))
        this.setPref(key, value);
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
    const row = db.prepare("PRAGMA locking_mode = EXCLUSIVE").get() as
      | { locking_mode?: string }
      | undefined;
    if (row?.locking_mode?.toLowerCase() !== "exclusive") {
      throw new Error(`SQLite refused exclusive locking_mode for ${file}`);
    }
    // A completed write transaction makes EXCLUSIVE mode retain the OS lock
    // until this handle closes. No long-running transaction is needed.
    db.exec(
      `BEGIN EXCLUSIVE;
       INSERT INTO gateway_meta (key, value) VALUES ('schema', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;
       COMMIT;`
    );
  } catch (error) {
    if (isBusy(error)) throw new GatewayLockError(file);
    throw error;
  }
}

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return code === "ERR_SQLITE_ERROR" && /busy|locked/iu.test(error.message);
}

/** Remote filesystem names as BSD `statfs.f_fstypename` reports them. */
const DARWIN_NETWORK_FS_TYPES = new Set([
  "nfs",
  "smbfs",
  "afpfs",
  "webdav",
  "ftpfs",
]);

/**
 * macOS has no filesystem magic to read: `statfsSync().type` is a BSD
 * `f_type` index, not a Linux magic number. The filesystem NAME lives in
 * `statfs.f_fstypename`, which `/sbin/mount` prints per mount point.
 *
 * `/usr/bin/stat -f '%T'` is not an alternative: BSD `stat -f` takes a FORMAT
 * STRING and `%T` is the `ls -F` type indicator (`@`, `/`, empty), never a
 * filesystem type. It exits 0 with a value the regex cannot match, and that
 * success also short-circuits the Linux `statfsSync` fallback, making darwin
 * detection a guaranteed `false` (#568).
 */
export function parseDarwinFileSystemType(
  mountOutput: string,
  root: string
): string | undefined {
  // `mount` lines read: `<source> on <mount point> (<fstype>, <opts…>)`.
  let best: { mountPoint: string; type: string } | undefined;
  for (const line of mountOutput.split("\n")) {
    const match = /^.* on (?<mountPoint>.+) \((?<type>[^,)]+)[,)]/u.exec(
      line.trim()
    );
    const mountPoint = match?.groups?.mountPoint;
    const type = match?.groups?.type;
    if (!mountPoint || !type) continue;
    const contains =
      root === mountPoint ||
      root.startsWith(mountPoint === "/" ? "/" : `${mountPoint}${path.sep}`);
    if (!contains) continue;
    // Longest matching mount point wins — `/Volumes/share` beats `/`.
    if (!best || mountPoint.length > best.mountPoint.length)
      best = { mountPoint, type };
  }
  return best?.type.trim().toLowerCase();
}

/** True/false when the mount table answered; `undefined` when it could not. */
export function darwinNetworkFileSystem(
  root: string,
  readMountTable: () => string | undefined = defaultMountTable
): boolean | undefined {
  const output = readMountTable();
  if (output === undefined) return undefined;
  const type = parseDarwinFileSystemType(output, root);
  return type === undefined ? undefined : DARWIN_NETWORK_FS_TYPES.has(type);
}

function defaultMountTable(): string | undefined {
  const result = spawnSync("/sbin/mount", [], {
    encoding: "utf8",
    timeout: 2_000,
  });
  return result.status === 0 && typeof result.stdout === "string"
    ? result.stdout
    : undefined;
}

function detectNetworkFileSystem(root: string): boolean {
  try {
    if (process.platform === "darwin") {
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
