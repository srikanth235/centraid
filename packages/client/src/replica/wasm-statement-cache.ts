// THE STATEMENT CACHE BOTH WASM DRIVERS ARE (#996, wave 2).
//
// The browser has two SQLite handles — the replica store's and the seat's —
// and both drive `@sqlite.org/sqlite-wasm` the same way: bind, step, reset,
// and keep the compiled statement, because the caller runs the same handful of
// statements once per row and compiling per row is most of the cost of a
// catch-up. What differs between them is only how many statements that handful
// is, so that is the only thing a subclass says.

import type {
  BindingSpec,
  Database,
  PreparedStatement,
} from "@sqlite.org/sqlite-wasm";

export abstract class WasmStatementCache {
  readonly #statements = new Map<string, PreparedStatement>();

  protected constructor(
    protected readonly db: Database,
    /** Bound on compiled statements held, so a pathological caller cannot pin them without limit. */
    private readonly cacheMax: number
  ) {}

  #prepared(sql: string): PreparedStatement {
    const hit = this.#statements.get(sql);
    if (hit) {
      hit.reset(true);
      return hit;
    }
    const statement = this.db.prepare(sql);
    this.#statements.set(sql, statement);
    while (this.#statements.size > this.cacheMax) {
      const oldest = this.#statements.keys().next();
      if (oldest.done) break;
      this.#statements.get(oldest.value)?.finalize();
      this.#statements.delete(oldest.value);
    }
    return statement;
  }

  run(sql: string, bind: readonly unknown[] = []): void {
    const statement = this.#prepared(sql);
    if (bind.length > 0) statement.bind(bind as unknown as BindingSpec);
    statement.step();
    statement.reset(true);
  }

  all<T extends object>(sql: string, bind: readonly unknown[] = []): T[] {
    return this.db.exec({
      sql,
      bind: bind as unknown as BindingSpec,
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
