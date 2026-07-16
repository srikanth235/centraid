import {
  guardReplicaRow,
  OnlineOnlyError,
  OnlineOnlyGuard,
  ReplicaSqliteStore,
  type OptimisticMutation,
  type ApplyChangesResult,
  type ReplicaBootstrapHeader,
  type ReplicaChangeBatch,
  type ReplicaCursor,
  type ReplicaSnapshotRow,
  type ReplicaReadRequest,
  type ReplicaReadResult,
  type ReplicaReadWireResult,
  type ReplicaSearchRequest,
  type ReplicaSearchWireResult,
  type ReplicaShape,
  type ReplicaSnapshot,
  type ReplicaSqliteDriver,
  type ReplicaStatus,
  type ReplicaStore,
} from '@centraid/client/replica/native';

/**
 * In-process React Native replica store: the shared driver-neutral core over an
 * op-sqlite driver, wrapped to satisfy the async {@link ReplicaStore} contract
 * the coordinator consumes. No worker, no postMessage — the "wire" results are
 * returned directly; `read` still applies the online-only guard exactly as the
 * web worker client does.
 */
export class NativeReplicaStore implements ReplicaStore {
  constructor(private readonly core: ReplicaSqliteStore) {}

  static create(driver: ReplicaSqliteDriver, vaultId: string): NativeReplicaStore {
    return new NativeReplicaStore(new ReplicaSqliteStore(driver, vaultId));
  }

  status(): Promise<ReplicaStatus> {
    const { cursor, schemaEpoch } = this.core.status();
    return Promise.resolve({ mode: 'native', cursor, schemaEpoch });
  }

  catalog(): Promise<ReplicaShape[]> {
    return Promise.resolve(this.core.catalog());
  }

  bootstrap(snapshot: ReplicaSnapshot): Promise<ReplicaCursor> {
    return Promise.resolve(this.core.bootstrap(snapshot));
  }

  bootstrapBegin(header: ReplicaBootstrapHeader): Promise<undefined> {
    this.core.bootstrapBegin(header);
    return Promise.resolve(undefined);
  }

  bootstrapPage(rows: ReplicaSnapshotRow[]): Promise<undefined> {
    this.core.bootstrapPage(rows);
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
    guard: OnlineOnlyGuard = new OnlineOnlyGuard(),
  ): Promise<ReplicaReadResult> {
    try {
      const result = this.core.read(request, mutations);
      return {
        rows: result.rows.map((row) => guardReplicaRow(row, guard)),
        receiptId: `replica:${result.cursor.epoch}:${result.cursor.seq}`,
        dependency: result.dependency,
      };
    } catch (error) {
      if (error instanceof OnlineOnlyError) guard.mark(error);
      throw error;
    }
  }

  readWire(
    request: ReplicaReadRequest,
    mutations: OptimisticMutation[] = [],
  ): Promise<ReplicaReadWireResult> {
    return Promise.resolve(this.core.read(request, mutations));
  }

  searchWire(
    request: ReplicaSearchRequest,
    mutations: OptimisticMutation[] = [],
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

  /**
   * Terminal cleanup clears the replica tables in place. The intent outbox lives
   * in its own table in the same database and is purged separately by the queue,
   * so this must not drop the shared handle or delete the file.
   */
  purge(): Promise<void> {
    this.core.wipe();
    return Promise.resolve();
  }
}
