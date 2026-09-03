import type { OnlineOnlyGuard } from "./errors.js";
import type {
  ReplicaBootstrapAdvance,
  ReplicaBootstrapResume,
} from "./store-core.js";
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

export interface ReplicaStore {
  status: () => Promise<ReplicaStatus>;
  catalog: () => Promise<ReplicaShape[]>;
  bootstrap: (snapshot: ReplicaSnapshot) => Promise<ReplicaCursor>;
  bootstrapBegin: (
    header: ReplicaBootstrapHeader,
    options?: { restart?: boolean }
  ) => Promise<ReplicaBootstrapResume | undefined>;
  bootstrapPage: (
    rows: ReplicaSnapshotRow[],
    advance?: ReplicaBootstrapAdvance
  ) => Promise<undefined>;
  bootstrapPreview?: (cursor: ReplicaCursor) => Promise<undefined>;
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
