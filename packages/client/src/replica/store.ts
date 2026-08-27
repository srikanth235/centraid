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

/**
 * Storage backend behind ReplicaCoordinator; `read` rows are
 * OnlineOnlyGuard-wrapped: unavailable fields throw.
 */
export interface ReplicaStore {
  status: () => Promise<ReplicaStatus>;
  catalog: () => Promise<ReplicaShape[]>;
  bootstrap: (snapshot: ReplicaSnapshot) => Promise<ReplicaCursor>;
  /**
   * Commit alone writes the readable cursor. A store that persists the walk's
   * position answers with the {@link ReplicaBootstrapResume} the driver should
   * pick up from (#880); one that does not answers undefined and the walk
   * starts at page one, exactly as before.
   */
  bootstrapBegin: (
    header: ReplicaBootstrapHeader,
    options?: { restart?: boolean }
  ) => Promise<ReplicaBootstrapResume | undefined>;
  /** `advance` records the walk position in the page's own transaction. */
  bootstrapPage: (
    rows: ReplicaSnapshotRow[],
    advance?: ReplicaBootstrapAdvance
  ) => Promise<undefined>;
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
