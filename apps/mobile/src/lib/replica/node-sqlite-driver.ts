// Test-only stand-in for the op-sqlite driver. op-sqlite is a native module that
// cannot load under vitest on macOS/node, so the intent-store and session suites
// exercise the exact same SQLite code paths against Node's built-in `node:sqlite`
// (FTS5-enabled). Never imported by app code, so Metro never bundles it.
import { DatabaseSync } from "node:sqlite";

import type {
  ReplicaBindValue,
  ReplicaSqliteDriver,
} from "@centraid/client/replica/native";

export class NodeSqliteDriver implements ReplicaSqliteDriver {
  private readonly db: DatabaseSync;

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
  }

  run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    this.db.prepare(sql).run(...bind);
  }

  all<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): T[] {
    return this.db.prepare(sql).all(...bind) as T[];
  }

  /**
   * `node:sqlite` has no off-thread read, but exposing the method keeps the
   * mounted reader's async path — the one production takes — under test.
   */
  allAsync<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): Promise<T[]> {
    return Promise.resolve(this.all<T>(sql, bind));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
