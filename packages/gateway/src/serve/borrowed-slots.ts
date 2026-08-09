/*
 * The gateway's borrowed slots (#726 P4 D4): one store + one CAS per
 * COUNTERPARTY VAULT, opened lazily and cached for the process's life.
 *
 * Lazy on purpose. A gateway that has never borrowed anything creates no
 * `borrowed/` directory at all, so "does this machine hold anyone else's
 * data?" is answerable by looking at the filesystem — which is the same
 * enforcement-by-location the whole design rests on.
 */

import { BorrowedCas } from "./borrowed-cas.js";
import { borrowedCasRoot, borrowedStoreFile } from "./borrowed-paths.js";
import { BorrowedStore } from "./borrowed-store.js";
import type { GatewayDatabase } from "./gateway-db.js";
import type { BorrowedDeps } from "./lend-audience.js";

export class BorrowedSlots implements BorrowedDeps {
  private readonly stores = new Map<string, BorrowedStore>();
  private readonly cases = new Map<string, BorrowedCas>();

  constructor(
    readonly gatewayDatabase: GatewayDatabase,
    private readonly dataDir: string
  ) {}

  storeFor = (peerVaultId: string): BorrowedStore => {
    const existing = this.stores.get(peerVaultId);
    if (existing) return existing;
    const store = BorrowedStore.open(
      borrowedStoreFile(this.dataDir, peerVaultId)
    );
    this.stores.set(peerVaultId, store);
    return store;
  };

  casFor = (peerVaultId: string): BorrowedCas => {
    const existing = this.cases.get(peerVaultId);
    if (existing) return existing;
    const cas = BorrowedCas.open(borrowedCasRoot(this.dataDir, peerVaultId));
    this.cases.set(peerVaultId, cas);
    return cas;
  };

  close(): void {
    for (const store of this.stores.values()) store.close();
    this.stores.clear();
    this.cases.clear();
  }
}
