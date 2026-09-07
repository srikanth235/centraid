// THE SEAT'S READ SEAM, OVER ONE OPEN FILE (#996 wave 3).
//
// `MultiVaultReplicaReader` used to be this seam, and it was 999 lines because
// it read across up to four ATTACHed databases: a union per statement, a merged
// schema, a content-hash dedupe, per-scope provenance, and two degradations for
// the reads that could not be pushed down. None of that is a question a seat
// with one file can ask, and `ReplicaSqliteStore.read` already answers what is
// left.
//
// WHAT THIS ADDS TO THE STORE, and it is only two things: the appId → shapeId
// resolution the reader did (a caller names its app, not a shape), and the
// vault stamp every row carries. Production reads go through
// `NativeReplicaSession`, which composes the pending overlay as well; this is
// the seam for callers that hold a store and no session — the airplane-mode
// lanes and the read-parity oracles, which are about the SQL and the rows.

import type {
  ReplicaReadWireResult,
  ReplicaSearchWireResult,
} from "@centraid/client/replica/native";

import type { NativeReplicaStore } from "./native-replica-store";
import type { NativeReadRequest, NativeSearchRequest } from "./native-session";
import { stampVaultSourceRows } from "./vault-source";
import type { VaultSource } from "./vault-source";

export class VaultReadPlane {
  constructor(
    private readonly store: NativeReplicaStore,
    private readonly source: VaultSource
  ) {}

  /**
   * The shape that carries this entity for this app.
   *
   * A caller names its app; a store indexes by shape. The reader resolved this
   * from the schema rows it had just read, and this resolves it from the
   * catalog for the same reason: a seat is handed shapes by the gateway and
   * never invents one.
   */
  private async shapeIdFor(
    appId: string,
    entity: string,
    declared: string | undefined
  ): Promise<string> {
    if (declared) return declared;
    const shape = (await this.store.catalog()).find(
      (candidate) =>
        candidate.appId === appId &&
        candidate.entities.some((each) => each.entity === entity)
    );
    return shape?.shapeId ?? appId;
  }

  async read(
    appId: string,
    request: NativeReadRequest
  ): Promise<ReplicaReadWireResult> {
    const shapeId = await this.shapeIdFor(
      appId,
      request.entity,
      request.shapeId
    );
    return stampVaultSourceRows(
      await this.store.readWire({ ...request, shapeId }),
      this.source
    );
  }

  async search(
    appId: string,
    request: NativeSearchRequest
  ): Promise<ReplicaSearchWireResult> {
    const shapeId = await this.shapeIdFor(
      appId,
      request.entity,
      request.shapeId
    );
    return stampVaultSourceRows(
      await this.store.searchWire({ ...request, shapeId }),
      this.source
    );
  }

  close(): void {
    void this.store.close();
  }
}
