import type { OnlineOnlyGuard } from "./errors.js";
import type {
  ApplyChangesResult,
  OptimisticMutation,
  ReplicaBootstrapHeader,
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
  ReplicaStatus,
} from "./types.js";

/**
 * Storage backend behind ReplicaCoordinator; `read` rows are
 * OnlineOnlyGuard-wrapped: unavailable fields throw.
 */
export interface ReplicaStore {
  status: () => Promise<ReplicaStatus>;
  catalog: () => Promise<ReplicaShape[]>;
  bootstrap: (snapshot: ReplicaSnapshot) => Promise<ReplicaCursor>;
  /** Commit alone writes the readable cursor. */
  bootstrapBegin: (header: ReplicaBootstrapHeader) => Promise<undefined>;
  bootstrapPage: (rows: ReplicaSnapshotRow[]) => Promise<undefined>;
  bootstrapPreview?: (cursor: ReplicaCursor) => Promise<undefined>;
  /** Commits at the PAGE-1 cursor; replay from it. */
  bootstrapCommit: (cursor: ReplicaCursor) => Promise<ReplicaCursor>;
  applyChanges: (batch: ReplicaChangeBatch) => Promise<ApplyChangesResult>;
  read: (
    request: ReplicaReadRequest,
    mutations?: OptimisticMutation[],
    guard?: OnlineOnlyGuard
  ) => Promise<ReplicaReadResult>;
  readWire: (
    request: ReplicaReadRequest,
    mutations?: OptimisticMutation[]
  ) => Promise<ReplicaReadWireResult>;
  searchWire: (
    request: ReplicaSearchRequest,
    mutations?: OptimisticMutation[]
  ) => Promise<ReplicaSearchWireResult>;
  wipe: () => Promise<undefined>;
  close: () => Promise<void>;
  purge: () => Promise<void>;
}
