import type {
  BindingSpec,
  Database,
  PreparedStatement,
} from "@sqlite.org/sqlite-wasm";

import type { ReplicaBindValue, ReplicaSqliteDriver } from "./store-core.js";

/**
 * A bootstrap runs the same handful of statements once per row, so the cache
 * only ever needs to hold that handful; the bound keeps a pathological caller
 * from pinning compiled statements without limit.
 */
const STATEMENT_CACHE_MAX = 64;

/** Drives the platform-neutral store core against a `@sqlite.org/sqlite-wasm` handle. */
export class WasmSqliteDriver implements ReplicaSqliteDriver {
  readonly #statements = new Map<string, PreparedStatement>();

  constructor(private readonly db: Database) {}

  /**
   * The browser replica may run `NORMAL` (ruling SB-replica-sync): it is
   * derived state re-pulled from its cursor, and the outbox that must survive
   * a crash is IndexedDB, outside this file and outside this pragma.
   */
  readonly synchronous = "NORMAL" as const;

  #prepared(sql: string): PreparedStatement {
    const hit = this.#statements.get(sql);
    if (hit) {
      hit.reset(true);
      return hit;
    }
    const statement = this.db.prepare(sql);
    this.#statements.set(sql, statement);
    while (this.#statements.size > STATEMENT_CACHE_MAX) {
      const oldest = this.#statements.keys().next();
      if (oldest.done) break;
      this.#statements.get(oldest.value)?.finalize();
      this.#statements.delete(oldest.value);
    }
    return statement;
  }

  run(sql: string, bind: readonly ReplicaBindValue[] = []): void {
    const statement = this.#prepared(sql);
    if (bind.length > 0) statement.bind(bind as BindingSpec);
    statement.step();
    statement.reset(true);
  }

  all<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): T[] {
    return this.db.exec({
      sql,
      bind: bind as BindingSpec,
      rowMode: "object",
      returnValue: "resultRows",
    }) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    for (const statement of this.#statements.values()) statement.finalize();
    this.#statements.clear();
    this.db.close();
  }
}
