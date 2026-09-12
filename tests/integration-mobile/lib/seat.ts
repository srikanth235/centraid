/*
 * A real native replica session against a real gateway (#890 W3).
 *
 * Everything below the transport is production: the shipped `SeatWorkerCore`
 * applies a real snapshot into a real file, the outbox is that file's own
 * `seat_outbox` table, and `createNativeReplicaSession` is the shipped one.
 * Three things are stand-ins, and each is named here rather than left to be
 * discovered:
 *
 * 1. the SQLite driver is `NodeSeatDriver`, the repo's `node:sqlite` stand-in
 *    for op-sqlite — same SQL, no native module (its own file says so), and
 *    the staging is the node filesystem one the desktop seat uses;
 * 2. `digest`/`idFactory` are injected, exactly as the device injects
 *    expo-crypto, so no Expo native module is resolved here;
 * 3. the change feed is silent BY DEFAULT — every suite here advances the
 *    session with `pullNow()`, which is the same seat catch-up a feed frame
 *    wakes. `liveFeed: true` swaps in the shipped
 *    `NativeMultiplexChangeFeed` over real `fetch` against this gateway's real
 *    SSE route, which is how #1014's T11 closed the gap that used to sit here:
 *    the live defect (R15/R22) was in the feed, and this tier's own gate could
 *    not see it.
 *
 * A fourth stand-in exists only to make the feed module importable off-device:
 * `expo/fetch` is aliased to `lib/expo-fetch.ts` (see the vitest config), which
 * hands back Node's own streaming `fetch`. Every suite injects its own
 * `streamFetch` regardless.
 *
 * The transport itself is real `fetch` over loopback, and `cut()` moves it to a
 * port nothing listens on so a failure is the platform's, not a flag's.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import { NativeMultiplexChangeFeed } from "../../../apps/mobile/src/lib/replica/native-multiplex-change-feed.js";
import { createNativeReplicaSession } from "../../../apps/mobile/src/lib/replica/native-session-open.js";
import type {
  NativeChangeFeed,
  NativeReplicaSession,
} from "../../../apps/mobile/src/lib/replica/native-session.js";
import { href } from "../../../packages/client/src/gateway-auth.js";
import type { ReplicaFetcher } from "../../../packages/client/src/replica/native.js";
import { deadLoopbackUrl } from "./gateway.js";
import type { MobileGateway } from "./gateway.js";
import { openNodeSeat } from "./node-seat.js";
import type { IntegrationSeat } from "./node-seat.js";

/** Hex SHA-256 over UTF-8 — the contract expo-crypto satisfies on device. */
const nodeDigest = (input: string): Promise<string> =>
  Promise.resolve(createHash("sha256").update(input, "utf8").digest("hex"));

/** The coordinator only needs a feed that resolves; see the header note. */
function silentFeed(): NativeChangeFeed & { active: boolean } {
  const feed = {
    active: false,
    subscribe: () => () => undefined,
    setShapeIds: async () => undefined,
    resume: async () => undefined,
    setActive(next: boolean) {
      feed.active = next;
    },
  };
  return feed;
}

export interface MobileSeat {
  readonly session: NativeReplicaSession;
  /**
   * Cancel the open SSE body, exactly as the platform did in the live trace
   * that produced R15 (`-999`, and the request was never re-issued). A no-op
   * on a seat with no live feed.
   */
  dropFeed: () => void;
  /** SSE requests this seat's feed has issued since it opened. */
  feedRequests: () => number;
  /** This phone's copy of the vault — the read door every suite here uses. */
  readonly seat: IntegrationSeat;
  /** The phone loses the network: every request now refuses to connect. */
  cut: () => void;
  /** The network comes back on the same gateway. */
  restore: () => void;
  /** Requests this seat has attempted since it opened. */
  readonly attempts: readonly string[];
  close: () => Promise<void>;
}

export interface OpenSeatOptions {
  /**
   * Give this seat the SHIPPED multiplex feed over this gateway's real SSE
   * route, instead of the silent stand-in (#1014, T11).
   */
  liveFeed?: boolean;
  /**
   * The foreground catch-up clock. Parked beyond any suite's lifetime by
   * default for the same reason `retryDelayMs` is: a background pull would
   * make "did this arrangement land" depend on a timer rather than on the
   * arrangement. A suite asserting the clock exists has to shorten it.
   */
  pullIntervalMs?: number;
  /** Distinct per seat so two seats on one gateway keep separate replicas. */
  label?: string;
  /** Which vault on this gateway. Defaults to the gateway's own default. */
  vaultId?: string;
  /** Where the file goes. Defaults to a directory of this seat's own. */
  directory?: string;
  /** The file's name in that directory — the shipped stem, for #1014's suite. */
  fileName?: string;
  /**
   * The phone's own connectivity oracle, which is NOT the transport: the mount
   * resolves the gateway base once and carries the answer as a boolean, so a
   * probe that misses on a cold launch mounts a session that believes it is
   * offline while the socket underneath it works. Only a suite that moves this
   * can reach what `start()` does when it is false.
   */
  isConnected?: () => boolean;
  /**
   * Base delay for the session's retries. The default parks them beyond any
   * suite's lifetime (see below); a suite asserting that something is retried
   * at all has to shorten it.
   */
  retryDelayMs?: number;
}

/**
 * Open one phone against `gateway`. Returns after `start()` has bootstrapped,
 * so a caller reads the state the session actually reached rather than a
 * half-built one.
 */
export async function openSeat(
  gateway: MobileGateway,
  options: OpenSeatOptions = {}
): Promise<MobileSeat> {
  const label = options.label ?? "seat";
  const dead = await deadLoopbackUrl();
  const attempts: string[] = [];
  let live = true;
  let counter = 0;
  const vaultId = options.vaultId ?? gateway.vaultId;
  const fetcher: ReplicaFetcher = (baseUrl, pathname, init) => {
    attempts.push(pathname);
    // The device's `fetcher(vaultId)` stamps this on every request; a suite
    // with two vaults on one gateway needs the same (#1014).
    const headers = new Headers(init.headers);
    headers.set("x-centraid-vault", vaultId);
    return fetch(href(live ? baseUrl : dead, pathname), {
      ...init,
      headers,
    } as RequestInit);
  };
  const seat = await openNodeSeat({
    directory: options.directory ?? path.join(gateway.dataDir, `seat-${label}`),
    ...(options.fileName ? { fileName: options.fileName } : {}),
    vaultId,
    baseUrl: gateway.url,
    // THE SEAT'S OWN DOORS ARE ADDRESSED TOO (#1014). Without the vault
    // header the snapshot and log doors answer for the gateway's DEFAULT
    // vault — which is precisely the mis-addressed bootstrap R25 recorded, so
    // it must be arranged deliberately here and never by omission.
    headers: {
      Authorization: `Bearer ${gateway.token}`,
      "x-centraid-vault": vaultId,
    },
    fetch: (input, init) => {
      // THE SEAT'S OWN DOORS COUNT AS ATTEMPTS TOO (#996, W5). A bootstrap is a
      // snapshot download now, not a walk of the shaped bootstrap route, so a
      // suite counting "did it ask again" has to see the transport's calls and
      // not only the session's.
      attempts.push(new URL(String(input)).pathname);
      return fetch(
        live ? input : new URL(String(input).replace(gateway.url, dead)),
        init
      );
    },
  });
  // THE SHIPPED RADIO, OVER REAL `fetch` (#1014, T11). Not a stand-in: this is
  // `NativeMultiplexChangeFeed` talking to the gateway's own SSE route, so a
  // suite can finally assert that a gateway write reaches a seat with no
  // `pullNow()` at all — and that a cancelled stream is re-issued.
  const bodies: ReadableStream<Uint8Array>[] = [];
  let feedRequests = 0;
  const multiplex = options.liveFeed
    ? new NativeMultiplexChangeFeed({
        gatewayAuth: {
          baseUrl: gateway.url,
          token: gateway.token,
          gatewayId: "mobile-integration",
          vaultId,
        },
        minReconnectMs: 10,
        maxReconnectMs: 50,
        streamFetch: (async (input: unknown, init: unknown) => {
          feedRequests += 1;
          const response = await fetch(
            live ? String(input) : String(input).replace(gateway.url, dead),
            init as RequestInit
          );
          if (response.body) bodies.push(response.body);
          return response;
        }) as never,
        resumeFrom: () => {
          const watermark = seat.watermark();
          return watermark
            ? { epoch: watermark.epoch, applied: watermark.applied }
            : undefined;
        },
      })
    : undefined;
  const session = await createNativeReplicaSession({
    gatewayAuth: {
      baseUrl: gateway.url,
      token: gateway.token,
      gatewayId: "mobile-integration",
      vaultId,
    },
    fetcher,
    changeFeed: multiplex ? multiplex.scope(vaultId) : silentFeed(),
    seat,
    digest: nodeDigest,
    idFactory: () => `${label}-intent-${++counter}`,
    ...(options.isConnected ? { isConnected: options.isConnected } : {}),
    // The drain must not re-arm behind the test's back: every suite here
    // flushes explicitly, so a background retry would make "did it settle"
    // depend on a timer rather than on the arrangement.
    retryDelayMs: options.retryDelayMs ?? 10 * 60_000,
    pullIntervalMs: options.pullIntervalMs ?? 10 * 60_000,
  });
  // THE FIRST COPY, AWAITED — which the phone never does. `start()` fires the
  // first catch-up and deliberately does NOT await it (a member who tapped an
  // icon must not wait for the whole vault file), so on the phone the screens
  // draw behind the mount and re-read when the copy lands. A suite has no
  // screens: it reads once, immediately, and would be reading through the
  // window in which the file handle is released for the snapshot swap. This
  // joins the catch-up already running rather than starting a second one.
  await session.pullNow();
  return {
    session,
    seat,
    dropFeed: () => {
      for (const body of bodies.splice(0))
        void body.cancel().catch(() => undefined);
    },
    feedRequests: () => feedRequests,
    cut: () => {
      live = false;
    },
    restore: () => {
      live = true;
    },
    attempts,
    close: async () => {
      multiplex?.close();
      await session.close();
    },
  };
}

/**
 * Ship whatever the outbox holds and wait for the queue to settle. `flushIntents`
 * resolves when the drain loop stops, so a poll would only re-observe what the
 * awaited promise already guarantees.
 */
export async function drain(seat: MobileSeat): Promise<void> {
  await seat.session.flushIntents();
}
