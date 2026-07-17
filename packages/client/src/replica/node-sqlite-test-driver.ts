// Shared by the store conformance suites: a node:sqlite adapter — the same
// synchronous seam op-sqlite fills on device (which cannot load under vitest
// on macOS/node).
import { DatabaseSync } from 'node:sqlite';

import type { ReplicaBindValue, ReplicaSqliteDriver } from './store-core.js';

export class NodeSqliteDriver implements ReplicaSqliteDriver {
  private readonly db = new DatabaseSync(':memory:');

  run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    this.db.prepare(sql).run(...bind);
  }

  all<T extends object>(sql: string, bind: readonly ReplicaBindValue[] = []): T[] {
    return this.db.prepare(sql).all(...bind) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
