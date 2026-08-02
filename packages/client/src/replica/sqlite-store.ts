import type { Database } from "@sqlite.org/sqlite-wasm";

import { ReplicaSqliteStore } from "./store-core.js";
import type { ReplicaDurability } from "./types.js";
import { WasmSqliteDriver } from "./wasm-sqlite-driver.js";

/**
 * Web replica store: the shared {@link ReplicaSqliteStore} core over a
 * sqlite-wasm handle. Retained as its own class so the worker and its
 * regression suite keep constructing `new SqliteReplicaStore(db, vaultId)`.
 */
export class SqliteReplicaStore extends ReplicaSqliteStore {
  constructor(
    db: Database,
    expectedVaultId: string,
    durability: ReplicaDurability = "durable"
  ) {
    super(new WasmSqliteDriver(db), expectedVaultId, durability);
  }
}
