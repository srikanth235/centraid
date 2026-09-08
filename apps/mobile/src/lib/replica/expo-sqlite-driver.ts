import { openDatabaseSync } from "expo-sqlite";
import type { SQLiteBindValue, SQLiteDatabase } from "expo-sqlite";

import { ReplicaFts5UnavailableError } from "./replica-fts5-error";
import { ReplicaSqliteVecUnavailableError } from "./replica-sqlite-vec-error";
import {
  asReplicaStorageError,
  isReplicaStorageFullError,
} from "./replica-storage-error";

/**
 * WHAT IS LEFT OF THIS FILE AFTER #996 W5.
 *
 * It opened the phone's REPLICA STORE — a projection of the vault into
 * `replica_row` blobs — and that store is deleted. What survives is the driver
 * itself, because the UPLOAD QUEUE is a second, unrelated SQLite database on
 * this phone (`lib/upload/native-queue.ts`) and it needs the same expo-sqlite
 * seam: the key pragma, the busy timeout, the error taxonomy.
 *
 * The seat has its OWN driver (`expo-seat-driver.ts`): its bind union carries
 * `Uint8Array` and `bigint`, which a projection of JSON never needed.
 */

/** The three types the upload queue binds. */
export type ExpoBindValue = string | number | null;

/**
 * The synchronous SQLite surface the upload queue is written over.
 *
 * It was `ReplicaSqliteDriver`, borrowed from the replica store because the two
 * happened to need the same three methods. The store is gone; the queue's
 * database is its own, and so is its seam.
 */
export interface UploadSqliteDriver {
  run: (sql: string, bind?: readonly ExpoBindValue[]) => void;
  all: <T extends object>(sql: string, bind?: readonly ExpoBindValue[]) => T[];
  exec: (sql: string) => void;
  close: () => void;
}

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

export class ExpoSqliteDriver implements UploadSqliteDriver {
  private constructor(private readonly db: SQLiteDatabase) {}

  /**
   * WAL, AND IT DEPENDS ON THERE BEING NO SECOND READER ON THE FILE.
   *
   * The rollback journal was here because a per-vault writer and a
   * gateway-scoped multi-ATTACH reader shared one file and the reader's SHARED
   * lock had to interact with the writer's RESERVED lock the way the busy
   * timeout below assumes. That reader is deleted (#996 wave 3): what remains
   * is one writer and the background task, and WAL is the mode in which those
   * two do not stall each other. The busy timeout stays — WAL still serialises
   * writers.
   *
   * THE DEPENDENCY IS STRUCTURAL, NOT A COMMENT. This module no longer exports
   * a way to open a second handle on a seat file at all; the one caller that
   * did (`openMountedReplicaReaderDriver`) went with the plane. A driver that
   * declares WAL while something else attaches the same database is the pair
   * this declaration must never be half of, and the way to keep it out is to
   * leave no opener for the other half.
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

  run(sql: string, bind: readonly ExpoBindValue[] = []): void {
    try {
      this.db.runSync(sql, bind as SQLiteBindValue[]);
    } catch (error) {
      throw asReplicaStorageError(error);
    }
  }

  all<T extends object>(sql: string, bind: readonly ExpoBindValue[] = []): T[] {
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
    statements: readonly { sql: string; bind: readonly ExpoBindValue[] }[]
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
    bind: readonly ExpoBindValue[] = []
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
   *  must still open. Probe right before needing a vector table (#721). Both
   *  platforms carry the extension now — iOS's `vec.xcframework` is built by
   *  `scripts/build-sqlite-vec-ios.sh` rather than shipped by expo-sqlite —
   *  which is exactly why the probe stays: a shell built before that script ran
   *  opens fine and has no `vec0`, and this is the gate that says so rather
   *  than a crash inside a vector query. */
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
