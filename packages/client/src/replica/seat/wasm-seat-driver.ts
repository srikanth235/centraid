// The sqlite-wasm seat driver — the browser seat's write path (#996, wave 2).
//
// Statements are cached because the applier runs the SAME handful of them
// millions of times on a catch-up: one upsert and one delete per table, and
// the seat's table count is bounded by the schema. Compiling per row is most
// of the cost of applying a page, and it is the whole of the difference
// between a catch-up that finishes on a train and one that does not.

import type {
  BindingSpec,
  Database,
  PreparedStatement,
} from "@sqlite.org/sqlite-wasm";

import type { SeatBindValue, SeatSqliteDriver } from "./driver.js";

/** Two statements per replicated table, with room for the seat's own. */
const STATEMENT_CACHE_MAX = 256;

export class WasmSeatDriver implements SeatSqliteDriver {
  readonly #statements = new Map<string, PreparedStatement>();

  constructor(private readonly db: Database) {}

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

  run(sql: string, bind: readonly SeatBindValue[] = []): void {
    const statement = this.#prepared(sql);
    if (bind.length > 0) statement.bind(bind as unknown as BindingSpec);
    statement.step();
    statement.reset(true);
  }

  all<T extends object>(sql: string, bind: readonly SeatBindValue[] = []): T[] {
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
