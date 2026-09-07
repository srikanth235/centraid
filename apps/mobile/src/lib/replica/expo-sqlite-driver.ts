import { openDatabaseSync } from "expo-sqlite";
import type { SQLiteBindValue, SQLiteDatabase } from "expo-sqlite";

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

// The phone's engine is expo-sqlite built against SQLCipher (#996 wave 3), and
// it differs from every other seat's in one way that reaches this file: there
// is NO key open option. `SQLiteOpenOptions` has none, and `PRAGMA key` is not
// issued anywhere in the module's Swift or Kotlin — so the FIRST statement on
// every handle this file returns has to be the key, before the store core's
// own PRAGMA block (which is a write, and a write against an unkeyed handle on
// an encrypted file is `SQLITE_NOTADB`).
//
// The key itself is the locker's (#996 wave 6). Absent, the handle opens a
// plaintext file — which is what a build that has not been through the locker
// yet, and every suite here, actually has.
const BUSY_TIMEOUT_MS = 5000;

/**
 * expo caches connections BY DATABASE NAME. Two handles on one file — the
 * foreground writer and the background task's — are the same object unless the
 * second asks for its own, and then a `close()` on either closes both.
 */
export interface ExpoSqliteOpenOptions {
  name: string;
  location?: string;
  /** SQLCipher passphrase; `PRAGMA key` runs before anything else. */
  key?: string;
  /** Ask expo for a connection of its own rather than the cached one. */
  useNewConnection?: boolean;
}

export class ExpoSqliteDriver implements ReplicaSqliteDriver {
  private constructor(private readonly db: SQLiteDatabase) {}

  /**
   * WAL, now that the mount plane is gone (#996 wave 3).
   *
   * The rollback journal was here because a per-vault writer and a
   * gateway-scoped multi-ATTACH reader shared one file and the reader's SHARED
   * lock had to interact with the writer's RESERVED lock the way the busy
   * timeout below assumes. That reader is deleted; what remains is one writer
   * and the background task, and WAL is the mode in which those two do not
   * stall each other. The busy timeout stays: WAL still serialises writers.
   */
  readonly journalMode = "WAL" as const;

  static open(options: ExpoSqliteOpenOptions): ExpoSqliteDriver {
    try {
      const db = openDatabaseSync(
        options.name,
        options.useNewConnection === true ? { useNewConnection: true } : {},
        options.location
      );
      // THE KEY IS FIRST, or nothing else on this handle can run.
      if (options.key !== undefined) db.execSync(keyPragma(options.key));
      db.execSync(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
      return new ExpoSqliteDriver(db);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    try {
      this.db.runSync(sql, bind as SQLiteBindValue[]);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  all<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): T[] {
    try {
      return this.db.getAllSync<T>(sql, bind as SQLiteBindValue[]);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  /**
   * A whole write batch off the JS thread, in one transaction (#922 E1).
   *
   * op-sqlite did this in ONE native round trip (`executeBatch`); expo has no
   * such call, so this is N round trips inside one `withTransactionAsync`. The
   * property #922 E1 actually bought — the JS thread is free while the
   * statements land, so a first-launch bootstrap page does not freeze the app —
   * survives that; the constant does not, and the bootstrap statement budget
   * (`bootstrap-statement-budget.test.ts`) is what keeps N honest.
   */
  async runBatchAsync(
    statements: readonly { sql: string; bind: readonly ReplicaBindValue[] }[]
  ): Promise<void> {
    try {
      await this.db.withTransactionAsync(async () => {
        for (const statement of statements)
          // oxlint-disable-next-line no-await-in-loop -- (#996) ORDER IS THE CONTRACT: these statements are one transaction and a later one overwrites an earlier one; Promise.all would interleave them
          await this.db.runAsync(
            statement.sql,
            statement.bind as SQLiteBindValue[]
          );
      });
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
      return await this.db.getAllAsync<T>(sql, bind as SQLiteBindValue[]);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  exec(sql: string): void {
    try {
      this.db.execSync(sql);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  close(): void {
    this.db.closeSync();
  }

  assertCapabilities(): void {
    try {
      this.db.execSync(
        "CREATE VIRTUAL TABLE IF NOT EXISTS temp.__fts5_probe USING fts5(x)"
      );
      this.db.execSync("DROP TABLE IF EXISTS temp.__fts5_probe");
    } catch (error) {
      if (isReplicaStorageFullError(error)) throw asReplicaStorageError(error);
      throw new ReplicaFts5UnavailableError();
    }
  }

  /** NOT wired into `open()`/`assertCapabilities()`: a build without sqlite-vec
   *  must still open. Probe right before needing a vector table (#721). On iOS
   *  there is no bundled `vec.xcframework` at all, so this is the gate that
   *  says so rather than a crash inside a vector query. */
  probeSqliteVec(): void {
    try {
      this.db.execSync(
        "CREATE VIRTUAL TABLE IF NOT EXISTS temp.__sqlite_vec_probe USING vec0(x float[1])"
      );
      this.db.execSync("DROP TABLE IF EXISTS temp.__sqlite_vec_probe");
    } catch (error) {
      if (isReplicaStorageFullError(error)) throw asReplicaStorageError(error);
      throw new ReplicaSqliteVecUnavailableError();
    }
  }
}

/**
 * `PRAGMA key` takes no bound parameter — it is parsed before the statement is
 * prepared — so the passphrase is a single-quoted literal and the only escape
 * SQLite has inside one is doubling the quote.
 */
export function keyPragma(key: string): string {
  return `PRAGMA key = '${key.replaceAll("'", "''")}'`;
}

export async function openNativeReplicaDriver(
  identity: ReplicaIdentity,
  digest?: ReplicaDigest,
  location?: string
): Promise<ExpoSqliteDriver> {
  const name = await nativeReplicaDatabaseName(identity, digest);
  return ExpoSqliteDriver.open({ name, ...(location ? { location } : {}) });
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
): Promise<ExpoSqliteDriver> {
  const name = await nativeReplicaDatabaseName(
    { gatewayId, vaultId: "__mounted__" },
    digest
  );
  return ExpoSqliteDriver.open({
    name,
    ...(location ? { location } : {}),
    useNewConnection: true,
  });
}
