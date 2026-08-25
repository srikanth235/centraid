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

// Two live handles per vault file (per-vault writer, gateway-scoped
// multi-ATTACH reader) under `journal_mode=DELETE`, where a reader's SHARED
// lock blocks the writer; SQLite's default busy timeout is zero.
const BUSY_TIMEOUT_MS = 5000;

export class OpSqliteDriver implements ReplicaSqliteDriver {
  private constructor(private readonly db: DB) {}

  static open(options: { name: string; location?: string }): OpSqliteDriver {
    try {
      const db = open({
        name: options.name,
        ...(options.location === undefined
          ? {}
          : { location: options.location }),
      });
      // The store core's own PRAGMA block is a write — set this first.
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

  /** Off-thread read. Reads only — the write path stays synchronous. */
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
    // op-sqlite's sync path runs one statement per call.
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

  /** NOT wired into `open()`/`assertCapabilities()`: a build without sqlite-vec
   *  must still open. Probe right before needing a vector table (#721). */
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

export async function nativeReplicaDatabasePath(
  identity: ReplicaIdentity,
  digest?: ReplicaDigest,
  location?: string
): Promise<string> {
  const name = await nativeReplicaDatabaseName(identity, digest);
  return location ? `${location.replace(/\/+$/u, "")}/${name}` : name;
}

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

function splitStatements(sql: string): string[] {
  return sql
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
