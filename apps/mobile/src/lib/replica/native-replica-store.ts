import {
  guardReplicaRow,
  OnlineOnlyError,
  OnlineOnlyGuard,
  ReplicaSqliteStore,
} from "@centraid/client/replica/native";
import type {
  OptimisticMutation,
  ApplyChangesResult,
  ReplicaBootstrapAdvance,
  ReplicaBootstrapHeader,
  ReplicaBootstrapResume,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaSnapshotRow,
  ReplicaReadRequest,
  ReplicaReadResult,
  ReplicaReadWireResult,
  ReplicaSearchRequest,
  ReplicaSearchWireResult,
  ReplicaShape,
  ReplicaSnapshot,
  ReplicaSqliteDriver,
  ReplicaStatus,
  ReplicaStore,
} from "@centraid/client/replica/native";

export class NativeReplicaStore implements ReplicaStore {
  constructor(private readonly core: ReplicaSqliteStore) {}

  static create(
    driver: ReplicaSqliteDriver,
    vaultId: string
  ): NativeReplicaStore {
    return new NativeReplicaStore(new ReplicaSqliteStore(driver, vaultId));
  }

  status(): Promise<ReplicaStatus> {
    const { cursor, schemaEpoch, coverage, durability } = this.core.status();
    return Promise.resolve({
      mode: "native",
      cursor,
      schemaEpoch,
      coverage,
      durability,
      intentDurability: durability,
    });
  }

  catalog(): Promise<ReplicaShape[]> {
    return Promise.resolve(this.core.catalog());
  }

  bootstrap(snapshot: ReplicaSnapshot): Promise<ReplicaCursor> {
    return Promise.resolve(this.core.bootstrap(snapshot));
  }

  bootstrapBegin(
    header: ReplicaBootstrapHeader,
    options?: { restart?: boolean }
  ): Promise<ReplicaBootstrapResume | undefined> {
    return Promise.resolve(this.core.bootstrapBegin(header, options));
  }

  bootstrapPage(
    rows: ReplicaSnapshotRow[],
    advance?: ReplicaBootstrapAdvance
  ): Promise<undefined> {
    this.core.bootstrapPage(rows, advance);
    return Promise.resolve(undefined);
  }

  bootstrapPreview(cursor: ReplicaCursor): Promise<undefined> {
    this.core.bootstrapPreview(cursor);
    return Promise.resolve(undefined);
  }

  bootstrapCommit(cursor: ReplicaCursor): Promise<ReplicaCursor> {
    return Promise.resolve(this.core.bootstrapCommit(cursor));
  }

  applyChanges(batch: ReplicaChangeBatch): Promise<ApplyChangesResult> {
    return Promise.resolve(this.core.applyChanges(batch));
  }

  async read(
    request: ReplicaReadRequest,
    mutations: OptimisticMutation[] = [],
    guard: OnlineOnlyGuard = new OnlineOnlyGuard()
  ): Promise<ReplicaReadResult> {
    try {
      const result = this.core.read(request, mutations);
      return {
        rows: result.rows.map((row) => guardReplicaRow(row, guard)),
        receiptId: `replica:${result.cursor.epoch}:${result.cursor.seq}`,
        dependency: result.dependency,
        coverage: result.coverage,
      };
    } catch (error) {
      if (error instanceof OnlineOnlyError) guard.mark(error);
      throw error;
    }
  }

  readWire(
    request: ReplicaReadRequest,
    mutations: OptimisticMutation[] = []
  ): Promise<ReplicaReadWireResult> {
    return Promise.resolve(this.core.read(request, mutations));
  }

  searchWire(
    request: ReplicaSearchRequest,
    mutations: OptimisticMutation[] = []
  ): Promise<ReplicaSearchWireResult> {
    return Promise.resolve(this.core.search(request, mutations));
  }

  wipe(): Promise<undefined> {
    this.core.wipe();
    return Promise.resolve(undefined);
  }

  close(): Promise<void> {
    this.core.close();
    return Promise.resolve();
  }

  purge(): Promise<void> {
    this.core.wipe();
    return Promise.resolve();
  }
}
