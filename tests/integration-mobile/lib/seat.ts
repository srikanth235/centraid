/*
 * A real native replica session against a real gateway (#890 W3).
 *
 * Everything below the transport is production: `createNativeReplicaSession`
 * builds the shipped `NativeReplicaStore`, the shipped `SqliteIntentStore`, and
 * the shipped `ReplicaCoordinator`. Three things are stand-ins, and each is
 * named here rather than left to be discovered:
 *
 * 1. the SQLite driver is `NodeSqliteDriver`, the repo's existing `node:sqlite`
 *    stand-in for op-sqlite — same SQL, no native module (its own file says so);
 * 2. `digest`/`idFactory` are injected, exactly as the device injects
 *    expo-crypto, so no Expo native module is resolved here;
 * 3. the change feed never emits. The SSE feed is a device concern; every
 *    suite here advances the session with `pullNow()`, which is the same
 *    coordinator path a feed frame triggers. What this tier therefore CANNOT
 *    claim is that a live SSE frame wakes the pull — that stays with the
 *    device journeys.
 *
 * The transport itself is real `fetch` over loopback, and `cut()` moves it to a
 * port nothing listens on so a failure is the platform's, not a flag's.
 */

import { createHash } from "node:crypto";
import path from "node:path";

import { createNativeReplicaSession } from "../../../apps/mobile/src/lib/replica/native-session.js";
import type {
  NativeChangeFeed,
  NativeReplicaSession,
} from "../../../apps/mobile/src/lib/replica/native-session.js";
import { NodeSqliteDriver } from "../../../apps/mobile/src/lib/replica/node-sqlite-driver.js";
import { href } from "../../../packages/client/src/gateway-auth.js";
import type { ReplicaFetcher } from "../../../packages/client/src/replica/native.js";
import { deadLoopbackUrl } from "./gateway.js";
import type { MobileGateway } from "./gateway.js";

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
  /** The phone loses the network: every request now refuses to connect. */
  cut: () => void;
  /** The network comes back on the same gateway. */
  restore: () => void;
  /** Requests this seat has attempted since it opened. */
  readonly attempts: readonly string[];
  close: () => Promise<void>;
}

export interface OpenSeatOptions {
  /** Rows per bootstrap page; small on purpose so a walk really pages. */
  bootstrapWindow?: number;
  /** Distinct per seat so two seats on one gateway keep separate replicas. */
  label?: string;
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
  const fetcher: ReplicaFetcher = (baseUrl, pathname, init) => {
    attempts.push(pathname);
    return fetch(href(live ? baseUrl : dead, pathname), init as RequestInit);
  };
  const session = await createNativeReplicaSession({
    gatewayAuth: {
      baseUrl: gateway.url,
      token: gateway.token,
      gatewayId: "mobile-integration",
      vaultId: gateway.vaultId,
    },
    fetcher,
    changeFeed: silentFeed(),
    driver: new NodeSqliteDriver(
      path.join(gateway.dataDir, `replica-${label}.db`)
    ),
    digest: nodeDigest,
    idFactory: () => `${label}-intent-${++counter}`,
    bootstrapWindow: options.bootstrapWindow ?? 200,
    // The drain must not re-arm behind the test's back: every suite here
    // flushes explicitly, so a background retry would make "did it settle"
    // depend on a timer rather than on the arrangement.
    retryDelayMs: 10 * 60_000,
  });
  return {
    session,
    cut: () => {
      live = false;
    },
    restore: () => {
      live = true;
    },
    attempts,
    close: () => session.close(),
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
