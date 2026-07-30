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
import {
  asReplicaStorageError,
  isReplicaStorageFullError,
} from "./replica-storage-error";

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
