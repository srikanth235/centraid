// The `node:sqlite` seat driver.
//
// Two jobs, and both are product jobs rather than test scaffolding. It is the
// desktop seat's driver — the desktop shell runs on Node and holds the file
// directly — and it is the driver the seat suites run against, which is what
// keeps the applier honest about being driver-neutral: the same program has to
// apply the same page through `node:sqlite` (3.50), sqlite-wasm (3.53) and
// op-sqlite (3.49, `SEAT_SQLITE_FLOOR`).

import { DatabaseSync } from "node:sqlite";

import type { SeatBindValue, SeatSqliteDriver } from "./driver.js";

export class NodeSeatDriver implements SeatSqliteDriver {
  readonly #db: DatabaseSync;

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
  }

  run(sql: string, bind: readonly SeatBindValue[] = []): void {
    this.#db.prepare(sql).run(...(bind as never[]));
  }

  /**
   * PLAIN OBJECTS, because the other two drivers return plain objects.
   * `node:sqlite` materialises rows with a null prototype; sqlite-wasm's
   * `rowMode: "object"` and op-sqlite both hand back ordinary ones, and a
   * driver whose rows behave differently from its siblings' is a difference
   * every caller — and every assertion — then has to know about.
   */
  all<T extends object>(sql: string, bind: readonly SeatBindValue[] = []): T[] {
    return (this.#db.prepare(sql).all(...(bind as never[])) as T[]).map(
      (row) => ({ ...row })
    );
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  close(): void {
    this.#db.close();
  }
}
