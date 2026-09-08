// The sqlite-wasm seat driver — the browser seat's write path (#996, wave 2).
//
// Statements are cached because the applier runs the SAME handful of them
// millions of times on a catch-up: one upsert and one delete per table, and
// the seat's table count is bounded by the schema. Compiling per row is most
// of the cost of applying a page, and it is the whole of the difference
// between a catch-up that finishes on a train and one that does not. The
// caching itself is `WasmStatementCache`, shared with the replica store's
// driver; the seat only says how large its handful is.

import type { Database } from "@sqlite.org/sqlite-wasm";

import { WasmStatementCache } from "../wasm-statement-cache.js";
import type { SeatSqliteDriver } from "./driver.js";

/** Two statements per replicated table, with room for the seat's own. */
const STATEMENT_CACHE_MAX = 256;

export class WasmSeatDriver
  extends WasmStatementCache
  implements SeatSqliteDriver
{
  constructor(db: Database) {
    super(db, STATEMENT_CACHE_MAX);
  }
}
