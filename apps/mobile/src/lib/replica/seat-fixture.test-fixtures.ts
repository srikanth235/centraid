/**
 * A SEAT-SHAPED READ PLANE FOR THE AIRPLANE FIXTURES (#996 wave 5).
 *
 * The two airplane oracles — Tally's and Locker's — used to seed the old
 * store: one `replica_row` table of `payload_json` blobs keyed by a shape id.
 * Every read they proved has since become a handler's plain SQL over the
 * vault's own tables (`ctx.vault.page`, R8, W4-D2), and plain SQL cannot run
 * on a JSON blob at all. So the seed moves with the reads: the same rows, in
 * the tables the gateway names them in.
 *
 * ONE PHYSICAL NAME, DERIVED ONCE. A seat holds the gateway's schema, so
 * `tally.expense` IS `tally_expense` — the entity name with its dot replaced.
 * The fixtures already declare each entity's primary key and column list, and
 * that declaration is now the table definition rather than a payload contract.
 *
 * THE TABLES A QUERY ONLY TOUCHES ARE CREATED EMPTY, NOT OMITTED. A handler
 * that decorates its rows reads tables this ledger has nothing in; on a real
 * seat those tables exist and answer nothing, and a fixture that leaves them
 * out turns "no decoration" into `no such table` — a failure that says the
 * handler is broken when the fixture is.
 */
import { DatabaseSync } from "node:sqlite";

import { seatWorkerPage } from "@centraid/client/replica/native";
import type {
  InlinePage,
  InlinePageRequest,
  SeatWorkerQuery,
} from "@centraid/client/replica/native";
import type { Page } from "@centraid/core/page";

/** One entity's rows, as both airplane fixtures already declare them. */
export interface SeedEntity {
  entity: string;
  primaryKey: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /**
   * The PHYSICAL table's whole column list, when it is wider than the columns
   * these rows carry values for. A handler's statement names the columns the
   * gateway's table has, not the ones a fixture happened to populate, and a
   * column left out of the table is `no such column` rather than a null.
   */
  seatColumns?: readonly string[];
}

/** The gateway's physical name for an entity: `tally.expense` → `tally_expense`. */
export function seatTableOf(entity: string): string {
  return entity.replace(/\./gu, "_");
}

/**
 * A table a handler reads but this ledger has no rows for: the name, and the
 * columns its statements project. Declared rather than inferred, because the
 * column list is exactly what a `SELECT` would fail on.
 */
export interface EmptySeatTable {
  table: string;
  columns: readonly string[];
}

function createTable(
  db: DatabaseSync,
  table: string,
  columns: readonly string[]
): void {
  // Column types are deliberately absent: SQLite stores each value with its
  // own affinity, so an integer stays an integer and a null stays a null,
  // which is what the payload blob these rows came out of also carried.
  db.exec(`CREATE TABLE ${table} (${columns.join(", ")})`);
}

/** Write the fixture's rows into the vault's tables in one transaction. */
export function seedSeatTables(
  file: string,
  entities: readonly SeedEntity[],
  empty: readonly EmptySeatTable[] = []
): void {
  const db = new DatabaseSync(file);
  try {
    for (const entity of entities)
      createTable(
        db,
        seatTableOf(entity.entity),
        entity.seatColumns ?? entity.columns
      );
    for (const table of empty) createTable(db, table.table, table.columns);
    db.exec("BEGIN IMMEDIATE");
    for (const entity of entities) {
      if (entity.rows.length === 0) continue;
      const columns = entity.columns;
      const insert = db.prepare(
        `INSERT INTO ${seatTableOf(entity.entity)} (${columns.join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`
      );
      for (const row of entity.rows)
        insert.run(
          ...columns.map((column) => {
            const value = row[column];
            return value === undefined ? null : (value as never);
          })
        );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

/**
 * The seat's `page`, over a real file, through the SAME assembler the phone
 * runs (`seatWorkerPage`): the statement, the probe row and the cursor are the
 * seat's, and only the distance to the driver is different.
 */
export class SeatPageFixture {
  readonly #db: DatabaseSync;

  constructor(file: string) {
    this.#db = new DatabaseSync(file, { readOnly: true });
  }

  readonly query = <T extends object>(request: SeatWorkerQuery): Promise<T[]> =>
    Promise.resolve(
      (this.#db.prepare(request.sql).all(...(request.bind ?? [])) as T[]).map(
        (row) => ({ ...row })
      )
    );

  readonly page: InlinePage = <Row extends object>(
    request: InlinePageRequest<Row>
  ): Promise<Page<Row>> =>
    seatWorkerPage(this, request.query, {
      limit: request.limit,
      ...(request.after ? { after: request.after } : {}),
    });

  close(): void {
    this.#db.close();
  }
}

/**
 * A read plane that is the SEAT and nothing else.
 *
 * `read` and `search` refuse rather than answer: every read these fixtures
 * prove is a page now, so a handler that reached for the declarative store
 * would be doing it silently, and a refusal here names it at the call.
 */
export function seatOnlyReadPlane(page: InlinePage): {
  read: () => never;
  search: () => never;
  page: InlinePage;
} {
  const refuse = (): never => {
    throw new Error(
      "this seat answers pages only: the declarative read is not part of it"
    );
  };
  return { read: refuse, search: refuse, page };
}
