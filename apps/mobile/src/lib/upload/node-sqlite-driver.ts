// Test-only stand-in for the op-sqlite driver, mirroring
// `../replica/node-sqlite-driver.ts`. Two differences, both required by the
// crash tests: this one is FILE-backed (a simulated process death must be able
// to reopen the same database and find exactly what was committed, which
// `:memory:` cannot express) and it opens an existing path rather than always
// creating a fresh database. Never imported by app code, so Metro never
// bundles it.
import { DatabaseSync } from 'node:sqlite';

import type { ReplicaBindValue, ReplicaSqliteDriver } from '@centraid/client/replica/native';

export class NodeSqliteFileDriver implements ReplicaSqliteDriver {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

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
