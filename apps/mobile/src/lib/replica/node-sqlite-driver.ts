// Test-only stand-in for the op-sqlite driver. op-sqlite is a native module that
// cannot load under vitest on macOS/node, so the intent-store and session suites
// exercise the exact same SQLite code paths against Node's built-in `node:sqlite`
// (FTS5-enabled). Never imported by app code, so Metro never bundles it.
import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";

import type {
  ReplicaBindValue,
  ReplicaSqliteDriver,
} from "@centraid/client/replica/native";

export class NodeSqliteDriver implements ReplicaSqliteDriver {
  private readonly db: DatabaseSync;
  /**
   * Statements cached by SQL text, as every real driver does (op-sqlite caches
   * internally, the wasm driver keeps its own map). Without it this stand-in
   * would measure a statement budget no seat actually pays (#922 C2).
   */
  private readonly cachedStatements = new Map<string, StatementSync>();

  constructor(filename = ":memory:") {
    this.db = new DatabaseSync(filename);
  }

  private prepared(sql: string): StatementSync {
    const hit = this.cachedStatements.get(sql);
    if (hit) return hit;
    const statement = this.db.prepare(sql);
    this.cachedStatements.set(sql, statement);
    return statement;
  }

  run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    this.prepared(sql).run(...bind);
  }

  all<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): T[] {
    return this.prepared(sql).all(...bind) as T[];
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

  /**
   * The stand-in for op-sqlite's background thread: it YIELDS to the event
   * loop between chunks, so a harness measuring the longest synchronous
   * stretch on the JS thread measures the real shape of the batched path.
   */
  async runBatchAsync(
    statements: readonly { sql: string; bind: readonly ReplicaBindValue[] }[]
  ): Promise<void> {
    const CHUNK = 250;
    this.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < statements.length; index += CHUNK) {
        // oxlint-disable-next-line no-await-in-loop -- (#922) yielding between chunks IS the point: this stand-in models op-sqlite background thread
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        for (const statement of statements.slice(index, index + CHUNK)) {
          this.run(statement.sql, statement.bind);
        }
      }
      this.exec("COMMIT");
    } catch (error) {
      this.exec("ROLLBACK");
      throw error;
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.cachedStatements.clear();
    this.db.close();
  }
}
