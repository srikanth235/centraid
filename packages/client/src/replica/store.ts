import type { OnlineOnlyGuard } from './errors.js';
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
} from './types.js';

/**
 * The async storage surface a {@link import('./coordinator.js').ReplicaCoordinator}
 * consumes, independent of where the SQLite engine lives. On web it is satisfied
 * by `ReplicaWorkerClient` (an OPFS worker reached over postMessage); on React
 * Native by an in-process op-sqlite store. Extracting it lets one coordinator,
 * intent queue and change-feed loop drive either platform unchanged.
 *
 * Both a guarded and a clone-safe read path are exposed on purpose:
 *
 * - `read` returns rows wrapped in an {@link OnlineOnlyGuard} proxy, so touching
 *   an unavailable field throws instead of silently reading `undefined`. This is
 *   the path local live queries use.
 * - `readWire`/`searchWire` return plain, structured-clone-safe envelopes with no
 *   proxy, because on web the rows must survive a shell→iframe `postMessage` hop
 *   and be guarded on the far side. Native implementations return the same
 *   envelopes directly (no hop), keeping the coordinator identical across
 *   platforms. They stay on the interface because the coordinator itself calls
 *   them for the shell's MessagePort transport.
 */
export interface ReplicaStore {
  status(): Promise<ReplicaStatus>;
  catalog(): Promise<ReplicaShape[]>;
  bootstrap(snapshot: ReplicaSnapshot): Promise<ReplicaCursor>;
  /**
   * Page-wise bootstrap for windowed mode (a 50k+ asset library cannot land in
   * one envelope). `bootstrapBegin` clears the replica and installs the page-1
   * catalog; each `bootstrapPage` applies one window atomically; only
   * `bootstrapCommit` writes the cursor that makes the replica readable. Until
   * then `status().cursor` is null, so an interrupted bootstrap is indistinguishable
   * from none and restarts rather than presenting partial data as complete.
   */
  bootstrapBegin(header: ReplicaBootstrapHeader): Promise<undefined>;
  bootstrapPage(rows: ReplicaSnapshotRow[]): Promise<undefined>;
  /** Commit at the PAGE-1 cursor; the caller must then replay changes from it. */
  bootstrapCommit(cursor: ReplicaCursor): Promise<ReplicaCursor>;
  applyChanges(batch: ReplicaChangeBatch): Promise<ApplyChangesResult>;
  read(
    request: ReplicaReadRequest,
    mutations?: OptimisticMutation[],
    guard?: OnlineOnlyGuard,
  ): Promise<ReplicaReadResult>;
  readWire(
    request: ReplicaReadRequest,
    mutations?: OptimisticMutation[],
  ): Promise<ReplicaReadWireResult>;
  searchWire(
    request: ReplicaSearchRequest,
    mutations?: OptimisticMutation[],
  ): Promise<ReplicaSearchWireResult>;
  wipe(): Promise<undefined>;
  close(): Promise<void>;
  purge(): Promise<void>;
}
