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
  SeatLoop,
  seatWorkerPage,
  SeatWorkerCore,
  httpSeatSnapshotTransport,
} from "@centraid/client/replica/native";
import type {
  IntentRecordStore,
  InlinePage,
  OptimisticMutation,
  ReplicaBaseVersion,
  InlinePageRequest,
  ReplicaDigest,
  ReplicaSearchWireResult,
  SeatWatermark,
  SeatWorkerQuery,
} from "@centraid/client/replica/native";
// By its OWN subpath (see the note in `timeline-page.ts`): the phone's bundle
// is over its weight ceiling, and the seat barrel would pull the browser's
// worker client and OPFS probe in behind it.
import {
  SeatRowKeys,
  seatBaseVersions,
} from "@centraid/client/replica/seat/base-versions";
import { seatSearchEnvelopes } from "@centraid/client/replica/seat/search-page";
import type { SeatSearchRequest } from "@centraid/client/replica/seat/search-page";
import type { Page } from "@centraid/core/page";

import { ExpoSeatDriver } from "./expo-seat-driver";
import { expoSeatCarryOverSidecar, expoSeatStaging } from "./expo-seat-staging";
import { nativeSeatDatabaseName } from "./native-seat-path";
import { acquireSeatLease, seatLeaseHolder } from "./seat-lease";
import type { SeatLease } from "./seat-lease";
import { SeatLeaseHeldError } from "./seat-lease-held-error";

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
  /**
   * WHO IS OPENING THIS FILE, AND THAT IT IS ALLOWED TO (#1014, P1/C8).
   *
   * expo-sqlite caches connections by database NAME, so a second opener over
   * one seat gets the FIRST one's handle and closing it closes theirs.
   * `useNewConnection` stops that; the lease stops the deeper problem, which
   * is two writers on one outbox. A caller that names an owner is refused with
   * {@link SeatLeaseHeldError} while another live owner holds the file.
   */
  readonly owner?: string;
  /** A second connection rather than the cached one. The background pass. */
  readonly useNewConnection?: boolean;
}

/**
 * What the session needs from this phone's seat.
 *
 * Structural rather than the class, for the reason `SeatQueryPort` is: a suite
 * drives the SAME `SeatWorkerCore` over `node:sqlite`, and requiring the class
 * would require expo-sqlite in a node run. The class satisfies it.
 */
export interface NativeSeatPort {
  outbox: () => IntentRecordStore;
  /** Rebase the snapshot and log doors after the tunnel moves (see below). */
  updateGatewayBase: (baseUrl: string) => void;
  search: (request: SeatSearchRequest) => Promise<ReplicaSearchWireResult>;
  baseVersions: (
    mutations: readonly OptimisticMutation[]
  ) => Promise<ReplicaBaseVersion[]>;
  sync: () => Promise<SeatWatermark | undefined>;
  watermark: () => SeatWatermark | undefined;
  purge: () => Promise<void>;
  close: () => Promise<void>;
}

export class NativeSeat implements NativeSeatPort {
  #rowKeys: SeatRowKeys | undefined;

  private constructor(
    private readonly loop: SeatLoop,
    private readonly lease: SeatLease | undefined
  ) {}

  static async open(options: NativeSeatOptions): Promise<NativeSeat> {
    const name = await nativeSeatDatabaseName(options);
    const location = options.storageLocation.replace(/\/+$/u, "");
    const databasePath = `${location}/${name}`;
    // BEFORE THE FILE IS OPENED, NOT AFTER (#1014, P1/C8). A pass that has to
    // open the seat to learn it may not open the seat has already taken the
    // cached handle out from under the holder.
    let lease: SeatLease | undefined;
    if (options.owner !== undefined) {
      lease = acquireSeatLease(databasePath, options.owner);
      if (!lease)
        throw new SeatLeaseHeldError(
          seatLeaseHolder(databasePath) ?? "another owner"
        );
    }
    const core = new SeatWorkerCore({
      openDatabase: () =>
        ExpoSeatDriver.open({
          name,
          location,
          ...(options.key === undefined ? {} : { key: options.key }),
          ...(options.useNewConnection === true
            ? { useNewConnection: true }
            : {}),
        }),
      staging: () =>
        expoSeatStaging({
          directory: `${location}/seat-staging`,
          databasePath,
          // The seat's own tables are written onto the expanded artifact
          // BEFORE it is moved into place (#1014, C17), so staging needs the
          // same driver — and the same key — the installed file is opened
          // with. A new connection: expo caches by NAME, and `.incoming` is
          // a different file that must not adopt this seat's handle.
          openIncoming: (path: string) => {
            const at = path.lastIndexOf("/");
            return ExpoSeatDriver.open({
              name: path.slice(at + 1),
              location: path.slice(0, at),
              ...(options.key === undefined ? {} : { key: options.key }),
              useNewConnection: true,
            });
          },
        }),
      // THE QUEUE'S DURABLE PLACE ACROSS THE SWAP (#1014, C5/T6). Keyed by
      // the seat's own file path, so two vaults on one phone never share a
      // stash.
      carryOver: () => expoSeatCarryOverSidecar(databasePath),
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
      // WIRE-COMPATIBILITY, SAID OUT LOUD (#1014, C16). A gateway older than
      // #1014 sends no vault header, and this app still bootstraps against
      // one — refusing would brick a compatible pair. What it must not do is
      // pretend the check happened.
      onBootstrapped: (result) => {
        if (result.vaultChecked !== "none") return;
        console.warn(
          `[centraid] replica: seat bootstrap for ${options.vaultId} named no vault — ` +
            `the gateway sent no vault header and the artifact carries no core_vault row`
        );
      },
      baseUrl: options.baseUrl,
      ...(options.headers ? { headers: options.headers } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    try {
      await loop.open();
    } catch (error) {
      lease?.release();
      throw error;
    }
    return new NativeSeat(loop, lease);
  }

  async sync(): Promise<SeatWatermark | undefined> {
    // Renewed on the work, not on a timer: a pass that is running is the
    // proof the holder is alive, and a lease is worth exactly that.
    this.lease?.renew();
    return this.loop.sync();
  }

  /**
   * THE SEAT IS REBASED TOO, NOT ONLY THE FEED AND THE SESSION.
   *
   * This phone's gateway base is an ephemeral loopback port that the tunnel
   * picks per launch, and the seat is opened from disk BEFORE it exists (the
   * outbox has to be durable for a write made offline). Left at the base it
   * opened with, the seat asks a dead address for the snapshot and for every
   * log page — bootstrap never lands and the copy stays empty behind a Home
   * that is rendering it correctly.
   */
  updateGatewayBase(baseUrl: string): void {
    this.loop.updateGatewayBase(baseUrl);
  }

  /** The outbox in this phone's seat file — the queue's durable store (R24). */
  outbox(): IntentRecordStore {
    return this.loop.outbox();
  }

  /**
   * The versions a queued write is against (#922 G5), read from CANONICAL rows.
   *
   * The overlay is bypassed deliberately: a queued edit must not become its own
   * base version, and a retry must observe the row that rejected it.
   */
  baseVersions(
    mutations: readonly OptimisticMutation[]
  ): Promise<ReplicaBaseVersion[]> {
    this.#rowKeys ??= new SeatRowKeys(this.loop);
    return seatBaseVersions(this.loop, this.#rowKeys, mutations);
  }

  /** Delete this phone's copy of the vault, outbox and all (revocation). */
  async purge(): Promise<void> {
    try {
      await this.loop.purge();
    } finally {
      this.lease?.release();
    }
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
  /**
   * ONE RANKED WINDOW OVER THIS PHONE'S COPY (#996, ruling W5-D1).
   *
   * The vault's FTS shadow tables came across in the bootstrap and are kept by
   * the same triggers, so search is the gateway's own statement over the file
   * already here — no second index, and nothing to rebuild. `search-page.ts`
   * assembles it; this is only which file it runs against.
   */
  readonly search = (
    request: SeatSearchRequest
  ): Promise<ReplicaSearchWireResult> =>
    seatSearchEnvelopes(this.loop, request);

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

  async close(): Promise<void> {
    try {
      await this.loop.close();
    } finally {
      // RELEASED EVEN ON A FAILED CLOSE. A lease held by a seat nobody is
      // using is a vault the background pass will skip until it expires.
      this.lease?.release();
    }
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
