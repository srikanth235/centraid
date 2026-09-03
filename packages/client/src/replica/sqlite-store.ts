import type { Database } from "@sqlite.org/sqlite-wasm";

import { ReplicaSqliteStore } from "./store-core.js";
import type { ReplicaDurability } from "./types.js";
import { WasmSqliteDriver } from "./wasm-sqlite-driver.js";

export class SqliteReplicaStore extends ReplicaSqliteStore {
  constructor(
    db: Database,
    expectedVaultId: string,
    durability: ReplicaDurability = "durable"
  ) {
    super(new WasmSqliteDriver(db), expectedVaultId, durability);
  }
}
