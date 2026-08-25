import { open } from "@op-engineering/op-sqlite";
import type { DB } from "@op-engineering/op-sqlite";

import { replicaDatabaseName } from "@centraid/client/replica/native";
import type {
  ReplicaBindValue,
  ReplicaDigest,
  ReplicaIdentity,
  ReplicaSqliteDriver,
} from "@centraid/client/replica/native";

import { ReplicaFts5UnavailableError } from "./replica-fts5-error";
import { ReplicaSqliteVecUnavailableError } from "./replica-sqlite-vec-error";
import {
  asReplicaStorageError,
  isReplicaStorageFullError,
} from "./replica-storage-error";

/**
 * How long a native connection waits for a conflicting lock before giving up.
 *
 * WHY THIS EXISTS AT ALL: the phone keeps TWO live handles on every vault file
 * — the per-vault write handle each replica session owns, and the one
 * gateway-scoped reader that `ATTACH`es all of them for cross-vault reads
 * (`MultiVaultReplicaReader`). The shared store core runs
 * `journal_mode=DELETE`, and under a rollback journal a writer needs an
 * EXCLUSIVE lock that any reader's SHARED lock blocks. SQLite's default busy
 * timeout is ZERO, so the writer does not wait — it fails instantly with
 * SQLITE_BUSY, which surfaces to the member as "database is locked" when they
 * tap Favourite while the grid happens to be reading (the reader's `allAsync`
 * runs off-thread, so the two genuinely overlap).
 *
 * Five seconds is the wait, not the expectation: replica reads are short, so
 * the realistic contention is milliseconds. A member's edit waiting out a scan
 * is correct; refusing it is not.
 */
const BUSY_TIMEOUT_MS = 5000;

/** Drives the shared replica store core against an in-process op-sqlite handle. */
export class OpSqliteDriver implements ReplicaSqliteDriver {
  private constructor(private readonly db: DB) {}

  /**
   * Open (or create) the replica database. `location` defaults to op-sqlite's
   * per-app documents directory; pass one to override for tests or scoping.
   */
  static open(options: { name: string; location?: string }): OpSqliteDriver {
    try {
      const db = open({
        name: options.name,
        ...(options.location === undefined
          ? {}
          : { location: options.location }),
      });
      // Before anything else touches the file: the store core's own PRAGMA
      // block is a write, so a handle opened during a live read would fail at
      // construction without this.
      db.executeSync(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
      return new OpSqliteDriver(db);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    try {
      this.db.executeSync(sql, bind as ReplicaBindValue[]);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  all<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): T[] {
    try {
      return this.db.executeSync(sql, bind as ReplicaBindValue[]).rows as T[];
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  /**
   * Off-thread read. `executeSync` runs the whole scan on the JS thread, so a
   * mounted read of a ten-year library blocks every frame until it lands;
   * op-sqlite's promise API runs the same statement on its own thread and only
   * the result crosses back. Reads only — the store core's write path is
   * synchronous by contract and must stay ordered against it.
   */
  async allAsync<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): Promise<T[]> {
    try {
      const result = await this.db.execute(sql, bind as ReplicaBindValue[]);
      return result.rows as T[];
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  exec(sql: string): void {
    // op-sqlite's synchronous path runs one statement per call; the store core
    // only passes multi-statement scripts to `exec` (DDL, PRAGMA blocks, tx
    // control), so split on `;` and skip blank fragments.
    try {
      for (const statement of splitStatements(sql))
        this.db.executeSync(statement);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  close(): void {
    this.db.close();
  }

  assertCapabilities(): void {
    try {
      this.db.executeSync(
        "CREATE VIRTUAL TABLE IF NOT EXISTS temp.__fts5_probe USING fts5(x)"
      );
      this.db.executeSync("DROP TABLE IF EXISTS temp.__fts5_probe");
    } catch (error) {
      if (isReplicaStorageFullError(error)) throw asReplicaStorageError(error);
      throw new ReplicaFts5UnavailableError();
    }
  }

  /**
   * Whether this build was compiled with sqlite-vec (#721's B4
   * follow-on — vector search over photo embeddings), the same shape
   * `assertCapabilities` uses to probe FTS5 above.
   *
   * EXPORTED BUT NOT CALLED FROM `open()`/`assertCapabilities()` — and that
   * omission is deliberate, not an oversight. FTS5 gates the replica's own
   * bootstrap because every replica needs it from the first read; a build
   * compiled before pods/gradle picked up `"sqliteVec": true` must still
   * open and serve every feature that does not touch vectors. Folding this
   * probe into `assertCapabilities` would brick the WHOLE replica open for a
   * capability nothing has asked for yet, which is its own defect (§12
   * territory) — the exact failure mode `ReplicaFts5UnavailableError`'s own
   * header argues against for the capability that DOES gate today. The
   * future semantic-search consumer calls this once, right before it needs a
   * vector table, and surfaces `ReplicaSqliteVecUnavailableError` the same
   * way a missing FTS5 build surfaces `ReplicaFts5UnavailableError` now.
   */
  probeSqliteVec(): void {
    try {
      this.db.executeSync(
        "CREATE VIRTUAL TABLE IF NOT EXISTS temp.__sqlite_vec_probe USING vec0(x float[1])"
      );
      this.db.executeSync("DROP TABLE IF EXISTS temp.__sqlite_vec_probe");
    } catch (error) {
      if (isReplicaStorageFullError(error)) throw asReplicaStorageError(error);
      throw new ReplicaSqliteVecUnavailableError();
    }
  }
}

/**
 * Open the replica database for one gateway/vault under op-sqlite's per-app
 * documents directory. The filename reuses `@centraid/client`'s storage-key
 * derivation (minus the SAH-pool leading slash, which is web-virtual-FS only),
 * with an injected digest because Hermes has no `crypto.subtle`.
 */
export async function openNativeReplicaDriver(
  identity: ReplicaIdentity,
  digest?: ReplicaDigest,
  location?: string
): Promise<OpSqliteDriver> {
  const name = await nativeReplicaDatabaseName(identity, digest);
  return OpSqliteDriver.open({ name, ...(location ? { location } : {}) });
}

export async function nativeReplicaDatabaseName(
  identity: ReplicaIdentity,
  digest?: ReplicaDigest
): Promise<string> {
  return (await replicaDatabaseName(identity, digest)).replace(/^\/+/u, "");
}

/** Absolute path used by SQLite ATTACH when a durable native location exists. */
export async function nativeReplicaDatabasePath(
  identity: ReplicaIdentity,
  digest?: ReplicaDigest,
  location?: string
): Promise<string> {
  const name = await nativeReplicaDatabaseName(identity, digest);
  return location ? `${location.replace(/\/+$/u, "")}/${name}` : name;
}

/** The gateway-scoped database that owns the one multi-ATTACH read handle. */
export async function openMountedReplicaReaderDriver(
  gatewayId: string,
  digest?: ReplicaDigest,
  location?: string
): Promise<OpSqliteDriver> {
  const name = await nativeReplicaDatabaseName(
    { gatewayId, vaultId: "__mounted__" },
    digest
  );
  return OpSqliteDriver.open({ name, ...(location ? { location } : {}) });
}

/** Split a SQL script into executable statements, ignoring blank fragments. */
function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
