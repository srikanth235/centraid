import type { BindingSpec, Database } from '@sqlite.org/sqlite-wasm';

import type { ReplicaBindValue, ReplicaSqliteDriver } from './store-core.js';

/** Drives the platform-neutral store core against a `@sqlite.org/sqlite-wasm` handle. */
export class WasmSqliteDriver implements ReplicaSqliteDriver {
  constructor(private readonly db: Database) {}

  run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    const statement = this.db.prepare(sql);
    try {
      if (bind.length > 0) statement.bind(bind as BindingSpec);
      statement.step();
    } finally {
      statement.finalize();
    }
  }

  all<T extends object>(sql: string, bind: readonly ReplicaBindValue[] = []): T[] {
    return this.db.exec({
      sql,
      bind: bind as BindingSpec,
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
