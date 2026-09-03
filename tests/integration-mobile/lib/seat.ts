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

const nodeDigest = (input: string): Promise<string> =>
  Promise.resolve(createHash("sha256").update(input, "utf8").digest("hex"));

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
  cut: () => void;
  restore: () => void;
  readonly attempts: readonly string[];
  close: () => Promise<void>;
}

export interface OpenSeatOptions {
  bootstrapWindow?: number;
  label?: string;
  isConnected?: () => boolean;
  retryDelayMs?: number;
}

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
    ...(options.isConnected ? { isConnected: options.isConnected } : {}),
    retryDelayMs: options.retryDelayMs ?? 10 * 60_000,
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

export async function drain(seat: MobileSeat): Promise<void> {
  await seat.session.flushIntents();
}
