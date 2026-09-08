// A PHONE'S SEAT, IN A NODE RUN (#996, W5).
//
// The REAL `SeatWorkerCore` over `node:sqlite`, with the phone's own assembly
// around it: the in-process channel, the loop, the outbox, the search and the
// base-version capture. What is substituted is expo-sqlite and the snapshot
// door — the two things a node process has not got — and nothing else.
//
// SO A SUITE THAT DRIVES THIS IS DRIVING THE SESSION'S REAL SEAT. The outbox is
// a real `seat_outbox` in a real file, which is what makes a restart assertion
// mean anything: the second session opens the same path and finds what the
// first one committed.

import {
  initSeatState,
  inProcessSeatChannel,
  SeatLoop,
  SeatRowKeys,
  seatBaseVersions,
  SeatWorkerCore,
} from "@centraid/client/replica/native";
import type {
  IntentRecordStore,
  OptimisticMutation,
  ReplicaBaseVersion,
  ReplicaSearchWireResult,
  SeatWatermark,
} from "@centraid/client/replica/native";
import { NodeSeatDriver } from "@centraid/client/replica/seat/node-seat-driver";
import { seatSearchEnvelopes } from "@centraid/client/replica/seat/search-page";
import type { SeatSearchRequest } from "@centraid/client/replica/seat/search-page";

import type { NativeSeatPort } from "./native-seat";

export interface NodeSeatOptions {
  /** The file this seat holds. The same path twice is the same seat. */
  readonly path: string;
  /** Statements run when the file is adopted (the vault's tables). */
  readonly schema?: string;
  /** A catch-up that does not finish until this settles. */
  readonly holdSync?: Promise<void>;
}

export interface NodeNativeSeat extends NativeSeatPort {
  driver: () => NodeSeatDriver;
}

/**
 * A seat over one file, OPENED, with no snapshot door behind it.
 *
 * Opened here rather than by the caller because that is the phone's own order
 * since W5: the file is opened before the session, so `seat_outbox` exists
 * before the first write. A fixture that handed back an unopened seat would let
 * a suite pass that the product cannot.
 */
export async function openNodeNativeSeat(
  options: NodeSeatOptions
): Promise<NodeNativeSeat> {
  const seat = nodeNativeSeat(options);
  await seat.open();
  return seat;
}

function nodeNativeSeat(options: NodeSeatOptions): NodeNativeSeat & {
  open: () => Promise<void>;
} {
  const drivers: NodeSeatDriver[] = [];
  const core = new SeatWorkerCore({
    openDatabase: () => {
      const driver = new NodeSeatDriver(options.path);
      drivers.push(driver);
      if (options.schema) driver.exec(options.schema);
      return driver;
    },
    staging: () => {
      throw new Error("this seat never bootstraps");
    },
    transport: () => {
      throw new Error("this seat never bootstraps");
    },
  });
  const loop = new SeatLoop(inProcessSeatChannel(core), {
    vaultId: "vault-a",
    dbName: options.path,
    remember: true,
    baseUrl: "http://127.0.0.1:0",
  });
  let rowKeys: SeatRowKeys | undefined;
  return {
    driver: () => drivers.at(-1)!,
    outbox: (): IntentRecordStore => loop.outbox(),
    search: (request: SeatSearchRequest): Promise<ReplicaSearchWireResult> =>
      seatSearchEnvelopes(loop, request),
    baseVersions: (
      mutations: readonly OptimisticMutation[]
    ): Promise<ReplicaBaseVersion[]> => {
      rowKeys ??= new SeatRowKeys(loop);
      return seatBaseVersions(loop, rowKeys, mutations);
    },
    // NO DOOR: a suite's seat is already the file it wants, so a catch-up is a
    // no-op rather than a fetch nothing is listening on.
    sync: async (): Promise<SeatWatermark | undefined> => {
      await options.holdSync;
      return undefined;
    },
    watermark: (): SeatWatermark | undefined => undefined,
    purge: (): Promise<void> => loop.purge(),
    close: (): Promise<void> => loop.close(),
    /**
     * THIS SEAT ALREADY HAS ITS COPY, and now it SAYS SO.
     *
     * The loop refuses a read on a seat that has not bootstrapped — the file
     * carries the vault's DDL either way, so an unguarded read would answer an
     * entirely believable empty page. A fixture that hands itself the file
     * therefore has to hand itself the state row that goes with it, or it is
     * posing a copyless seat while claiming to be a full one.
     */
    open: async (): Promise<void> => {
      await loop.open();
      initSeatState(drivers.at(-1)!, {
        vaultId: "vault-a",
        epoch: "epoch-a",
        // Presence is the whole claim here; this seat never applies a page, so
        // the number is not compared against anything — it only has to satisfy
        // the file's own `schema_epoch >= 1`.
        schemaEpoch: 1,
        appliedSeq: 0,
      });
      await loop.open();
    },
  } as NodeNativeSeat & { open: () => Promise<void> };
}
