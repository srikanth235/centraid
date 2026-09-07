// THE PHONE'S SEAT (#996, wave 4b).
//
// The same seat the browser runs, assembled out of what a phone has: an
// expo-sqlite handle over SQLCipher (`ExpoSeatDriver`), the app's own document
// directory for staging (`expoSeatStaging`), the gateway's snapshot door over
// `fetch`, and `SeatLoop` for the bootstrap-and-tail that is identical
// everywhere. `SeatWorkerCore` is the store on both hosts; what differs is the
// distance to it, and here there is none — RN has no Worker, and expo-sqlite's
// handle is native and synchronous, so `inProcessSeatChannel` calls the core.
//
// ONE FILE, ONE WRITER, AND THE SEAT OWNS IT. The old store's file
// (`centraid-replica-…`) is a different database with a different schema and it
// is still there until W5; the seat's is `centraid-seat-…`, and the two never
// share a handle. That separation is what lets the phone's read path move to
// the seat one screen at a time without a migration.
//
// AND A READ IS A PAGE (R8). `page` is the whole reason the phone needed this:
// `NativeInlineQuerySession` had no way to answer `ctx.vault.page`, so every
// app that ran through `runNativeInlineQuery` got the online-only stub and no
// shared handler could be converted. It is `seatWorkerPage` — the SAME
// assembler the shell's read path uses, so a cursor means one thing on both.

import {
  inProcessSeatChannel,
  replicaStorageKey,
  SeatLoop,
  seatWorkerPage,
  SeatWorkerCore,
  httpSeatSnapshotTransport,
} from "@centraid/client/replica/native";
import type {
  InlinePage,
  InlinePageRequest,
  ReplicaDigest,
  SeatWatermark,
  SeatWorkerQuery,
} from "@centraid/client/replica/native";
import type { Page } from "@centraid/core/page";

import { ExpoSeatDriver } from "./expo-seat-driver";
import { expoSeatStaging } from "./expo-seat-staging";

export interface NativeSeatOptions {
  readonly gatewayId: string;
  readonly vaultId: string;
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Where the seat file and its staging live; the module's durable directory. */
  readonly storageLocation: string;
  /** The locker's SQLCipher passphrase (#996 wave 6); absent opens plaintext. */
  readonly key?: string;
  /** Hermes has no WebCrypto; the phone passes expo-crypto's. */
  readonly digest?: ReplicaDigest;
  readonly fetch?: typeof globalThis.fetch;
}

/** `centraid-seat-…`, beside — never over — the old store's file. */
export async function nativeSeatDatabaseName(
  options: Pick<NativeSeatOptions, "gatewayId" | "vaultId" | "digest">
): Promise<string> {
  const stem = await replicaStorageKey(
    { gatewayId: options.gatewayId, vaultId: options.vaultId },
    options.digest
  );
  return `centraid-seat-${stem}.sqlite3`;
}

export class NativeSeat {
  private constructor(private readonly loop: SeatLoop) {}

  static async open(options: NativeSeatOptions): Promise<NativeSeat> {
    const name = await nativeSeatDatabaseName(options);
    const location = options.storageLocation.replace(/\/+$/u, "");
    const databasePath = `${location}/${name}`;
    const core = new SeatWorkerCore({
      openDatabase: () =>
        ExpoSeatDriver.open({
          name,
          location,
          ...(options.key === undefined ? {} : { key: options.key }),
        }),
      staging: () =>
        expoSeatStaging({
          directory: `${location}/seat-staging`,
          databasePath,
        }),
      transport: (bootstrap) =>
        httpSeatSnapshotTransport({
          url: bootstrap.snapshotUrl,
          ...(bootstrap.headers ? { headers: bootstrap.headers } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        }),
    });
    const loop = new SeatLoop(inProcessSeatChannel(core), {
      vaultId: options.vaultId,
      dbName: databasePath,
      // The phone always holds its copy: "keep an offline copy" is the
      // browser's choice on a shared machine (R9), and a phone that is
      // remote-only is a phone with no reason to have a seat.
      remember: true,
      baseUrl: options.baseUrl,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    await loop.open();
    return new NativeSeat(loop);
  }

  sync(): Promise<SeatWatermark | undefined> {
    return this.loop.sync();
  }

  watermark(): SeatWatermark | undefined {
    return this.loop.watermark();
  }

  query<T extends object>(request: SeatWorkerQuery): Promise<T[]> {
    return this.loop.query<T>(request);
  }

  /**
   * One page of one handler's plain SQL over this phone's copy (R8).
   *
   * Shaped as `InlinePage` — the request object the ctx passes — rather than as
   * loose arguments, because it carries the OVERLAY: a list read that drops it
   * shows the member everything except their own unsettled write (R23-R25).
   */
  readonly page: InlinePage = <Row extends object>(
    request: InlinePageRequest<Row>
  ): Promise<Page<Row>> =>
    seatWorkerPage(
      this.loop,
      request.query,
      {
        limit: request.limit,
        ...(request.after ? { after: request.after } : {}),
      },
      request.overlay
    );

  close(): Promise<void> {
    return this.loop.close();
  }
}

/**
 * A seat, filled, or nothing (#996 wave 4, the browser's own rule).
 *
 * Opening the file only opens the FILE: on a phone that has never held this
 * vault it is empty, and the first handler's SQL against it does not come back
 * empty — it comes back `no such table`. So the copy is fetched before the seat
 * is handed to anything, and a bootstrap that fails is "no seat" rather than an
 * error: the read path then refuses ONLINE_ONLY and the query runs whole on the
 * gateway's paged door. A half-open file hands its handle back rather than
 * keeping it — expo caches connections by name, and a handle left behind is the
 * one the next open would get instead of its own.
 */
export async function openSyncedNativeSeat(
  options: NativeSeatOptions
): Promise<NativeSeat | undefined> {
  let seat: NativeSeat | undefined;
  try {
    seat = await NativeSeat.open(options);
    const watermark = await seat.sync();
    if (watermark === undefined) throw new Error("seat did not arrive");
    return seat;
  } catch {
    await seat?.close().catch(() => undefined);
    return undefined;
  }
}
