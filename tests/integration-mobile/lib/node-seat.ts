/*
 * A PHONE'S SEAT, AGAINST A REAL GATEWAY, IN A NODE PROCESS (#996, W5).
 *
 * `NativeSeat` is expo-sqlite and expo-file-system; this is the same assembly
 * with the two things a node process has not got swapped for their node
 * equivalents — `NodeSeatDriver` for the driver, `nodeSeatStaging` for the
 * staging — and NOTHING ELSE substituted. The snapshot transport is the
 * shipped HTTP one, so the bootstrap this seat performs is a real download of
 * a real artifact from the gateway under test, resumable marker and all.
 *
 * WHICH IS WHY IT IS HERE RATHER THAN IN THE MOBILE PACKAGE. The mobile
 * fixture (`native-seat.test-fixtures.ts`) deliberately has NO door: a unit
 * suite's seat is already the file it wants. This tier's whole claim is the
 * door, so it wires one.
 */

import { mkdirSync } from "node:fs";

import type { NativeSeatPort } from "../../../apps/mobile/src/lib/replica/native-seat.js";
import {
  httpSeatSnapshotTransport,
  inProcessSeatChannel,
  SeatLoop,
  SeatRowKeys,
  seatBaseVersions,
  SeatWorkerCore,
  seatWorkerPage,
} from "../../../packages/client/src/replica/native.js";
import type {
  SeatWorkerSink,
  IntentRecordStore,
  OptimisticMutation,
  ReplicaBaseVersion,
  ReplicaSearchWireResult,
  SeatWatermark,
} from "../../../packages/client/src/replica/native.js";
import { NodeSeatDriver } from "../../../packages/client/src/replica/seat/node-seat-driver.js";
import {
  nodeSeatCarryOverSidecar,
  nodeSeatStaging,
} from "../../../packages/client/src/replica/seat/node-staging.js";
import type { SeatReadOverlay } from "../../../packages/client/src/replica/seat/read-overlay.js";
import { seatSearchEnvelopes } from "../../../packages/client/src/replica/seat/search-page.js";
import type { SeatSearchRequest } from "../../../packages/client/src/replica/seat/search-page.js";
import type {
  Page,
  PageQuery,
  PageRequest,
} from "../../../packages/core/src/page/index.js";

/** The seat this tier hands back: the session's port, plus the read door. */
export interface IntegrationSeat extends NativeSeatPort {
  page: <Row extends object>(
    query: PageQuery<Row>,
    request: PageRequest,
    overlay?: SeatReadOverlay
  ) => Promise<Page<Row>>;
}

export interface NodeSeatOptions {
  /** This seat's own directory: the file, and the staging beside it. */
  readonly directory: string;
  readonly vaultId: string;
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
  /**
   * The seat file's name inside `directory`, so a suite can give two vaults
   * the SHIPPED naming (`nativeSeatDatabaseName`) in one storage directory —
   * which is the arrangement R25 was found in (#1014).
   */
  readonly fileName?: string;
  /**
   * WHERE THE PROCESS DIES (#1014, C5/T6).
   *
   * The re-bootstrap swap has no atomic step: the queue comes out of the old
   * file, the handle is released, an artifact arrives over minutes, the file is
   * REPLACED, and only then is the queue written back. Every one of those
   * boundaries is a place a phone gets killed, and the only tier that can
   * actually inject one is this one — the seams are the host's, not the
   * session's. Each fault throws where a kill would land; the suite then
   * reopens and asks whether the member's work is still there.
   */
  readonly faults?: {
    /** Before the queue is stashed anywhere. */
    readonly carryOver?: () => void;
    /** After the handle is released, before the download. */
    readonly staging?: () => void;
    /** Around the install: call `run()` to let the swap happen first. */
    readonly install?: (run: () => Promise<void>) => Promise<void>;
  };
}

/** Open the seat's FILE — the outbox exists from here, copy or no copy. */
export async function openNodeSeat(
  options: NodeSeatOptions
): Promise<IntegrationSeat> {
  // THE PHONE NEVER HAS TO DO THIS: expo's document directory is the seat's
  // parent and it always exists. This tier gives each seat its OWN directory so
  // two phones in one suite do not share a file, so it has to make it — SQLite
  // will not create a missing parent, it answers "unable to open database file".
  mkdirSync(options.directory, { recursive: true });
  const databasePath = `${options.directory}/${options.fileName ?? "seat.sqlite3"}`;
  // The product's own indirection (#1014, C3): the core takes its sink at
  // construction, and the session that reads the invalidations is built after
  // the file is open. This tier carries it so a suite watches the SAME hook
  // the phone does rather than a narrower stand-in.
  const sinkHolder: { sink: SeatWorkerSink } = { sink: {} };
  const core = new SeatWorkerCore(
    {
      openDatabase: () => new NodeSeatDriver(databasePath),
      staging: () => {
        options.faults?.staging?.();
        const staging = nodeSeatStaging({
          // Per FILE, not per directory: two seats sharing a staging directory
          // would resume each other's part file (#1014).
          directory: `${databasePath}-staging`,
          databasePath,
        });
        const install = options.faults?.install;
        if (!install) return staging;
        return {
          ...staging,
          install: (etag, prepare) =>
            install(() => staging.install(etag, prepare)),
        };
      },
      // The phone's stash, in `node:fs` terms (#1014, C5/T6): this tier is
      // where a kill mid-swap is actually injected, so it must have the same
      // seam.
      carryOver: () => {
        options.faults?.carryOver?.();
        return nodeSeatCarryOverSidecar(databasePath);
      },
      transport: (bootstrap) =>
        httpSeatSnapshotTransport({
          url: bootstrap.snapshotUrl,
          ...(bootstrap.headers ? { headers: bootstrap.headers } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        }),
    },
    {
      onChange: (notice) => sinkHolder.sink.onChange?.(notice),
      onOverlaysCleared: (ids) => sinkHolder.sink.onOverlaysCleared?.(ids),
      onBootstrapProgress: (p) => sinkHolder.sink.onBootstrapProgress?.(p),
    }
  );
  const loop = new SeatLoop(inProcessSeatChannel(core), {
    vaultId: options.vaultId,
    dbName: databasePath,
    remember: true,
    baseUrl: options.baseUrl,
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  await loop.open();
  let rowKeys: SeatRowKeys | undefined;
  return {
    attachSink: (sink: SeatWorkerSink): void => {
      sinkHolder.sink = sink;
    },
    outbox: (): IntentRecordStore => loop.outbox(),
    page: <Row extends object>(
      query: PageQuery<Row>,
      request: PageRequest,
      overlay?: SeatReadOverlay
    ): Promise<Page<Row>> => seatWorkerPage(loop, query, request, overlay),
    search: (request: SeatSearchRequest): Promise<ReplicaSearchWireResult> =>
      seatSearchEnvelopes(loop, request),
    baseVersions: (
      mutations: readonly OptimisticMutation[]
    ): Promise<ReplicaBaseVersion[]> => {
      rowKeys ??= new SeatRowKeys(loop);
      return seatBaseVersions(loop, rowKeys, mutations);
    },
    // The phone's real port moves per launch (the tunnel picks it), so the
    // port is state the session re-points rather than open configuration.
    // This tier's base is fixed, but the port must exist for a session test
    // to exercise a reconnect the way the device does.
    updateGatewayBase: (baseUrl: string): void =>
      loop.updateGatewayBase(baseUrl),
    sync: (): Promise<SeatWatermark | undefined> => loop.sync(),
    watermark: (): SeatWatermark | undefined => loop.watermark(),
    purge: (): Promise<void> => loop.purge(),
    close: (): Promise<void> => loop.close(),
  };
}
