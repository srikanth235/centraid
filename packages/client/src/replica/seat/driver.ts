// THE SEAT'S SQLite SEAM (#996, wave 2).
//
// The old store's `ReplicaSqliteDriver` binds `string | number | null`, which
// was the right union for a projection of JSON-shaped shape rows. A seat holds
// `vault.db` WHOLE, so two more types are on its write path and neither
// survives that union: a BLOB (thumbnails, embeddings, key-wrapped bytes) and
// a 64-bit INTEGER beyond 2^53 (byte counts, epoch-nanosecond stamps). The
// wire preserves both on purpose — `row-json.ts` exists for exactly that — so
// the seam that binds them has to as well.
//
// A SEPARATE INTERFACE RATHER THAN A WIDER ONE. The two stores live side by
// side until wave 5, and widening the old union would push `bigint` and
// `Uint8Array` into every driver the old store has on three platforms, for a
// value none of them can be handed today. The seat's driver is the seat's.

/** One bound value on a seat's write path. */
export type SeatBindValue = string | number | null | bigint | Uint8Array;

/**
 * The minimal synchronous SQLite surface the seat store is written over.
 *
 * Synchronous on purpose: the applier's whole correctness argument is "one
 * commit, one transaction, cursor included", and an `await` between `BEGIN`
 * and `COMMIT` is how another caller's statement lands inside someone else's
 * transaction. The asynchrony lives at the WORKER boundary instead.
 */
export interface SeatSqliteDriver {
  run: (sql: string, bind?: readonly SeatBindValue[]) => void;
  all: <T extends object>(sql: string, bind?: readonly SeatBindValue[]) => T[];
  /** Multi-statement, bindless SQL: DDL, PRAGMA, transaction control. */
  exec: (sql: string) => void;
  close: () => void;
}

/**
 * The PRAGMAs every seat file is opened under, in the order they must run.
 *
 * `foreign_keys = OFF` is the #996 invariant, not a convenience: the gateway's
 * integrity is the only integrity, and a seat applying commits in the
 * gateway's order legitimately sees a child row before the commit that carries
 * its parent. Enforcing here would reject rows the gateway accepted, and the
 * replay test asserts `PRAGMA foreign_key_check` is empty at the WATERMARK,
 * which is the honest place to ask.
 *
 * `recursive_triggers` stays OFF: the only triggers a seat file retains are
 * FTS sync, which are flat by construction.
 */
export const SEAT_OPEN_PRAGMAS = [
  "PRAGMA foreign_keys = OFF",
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA temp_store = MEMORY",
] as const;

export function openSeatFile(driver: SeatSqliteDriver): void {
  for (const pragma of SEAT_OPEN_PRAGMAS) driver.exec(pragma);
}
