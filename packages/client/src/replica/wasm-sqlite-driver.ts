import type { Database } from "@sqlite.org/sqlite-wasm";

import type { ReplicaSqliteDriver } from "./store-core.js";
import { WasmStatementCache } from "./wasm-statement-cache.js";

/**
 * A bootstrap runs the same handful of statements once per row, so the cache
 * only ever needs to hold that handful; the bound keeps a pathological caller
 * from pinning compiled statements without limit.
 */
const STATEMENT_CACHE_MAX = 64;

/** Drives the platform-neutral store core against a `@sqlite.org/sqlite-wasm` handle. */
export class WasmSqliteDriver
  extends WasmStatementCache
  implements ReplicaSqliteDriver
{
  constructor(db: Database) {
    super(db, STATEMENT_CACHE_MAX);
  }

  /**
   * The browser replica may run `NORMAL` (ruling SB-replica-sync): it is
   * derived state re-pulled from its cursor, and the outbox that must survive
   * a crash is IndexedDB, outside this file and outside this pragma.
   */
  readonly synchronous = "NORMAL" as const;
}
