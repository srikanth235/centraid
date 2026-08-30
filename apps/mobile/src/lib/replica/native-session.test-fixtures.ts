// Shared fixture vocabulary for the native replica session suites: the sync
// rail in `native-session.test.ts` and the durable write rail in
// `native-session-write-rail.test.ts`. Both stand up the same gateway, change
// feed and snapshot shapes, so the doubles live here rather than drifting apart
// by copy-paste across two files the repo file-size cap keeps separate.
import { createHash } from "node:crypto";

import type {
  GatewayAuth,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaDigest,
  ReplicaIdFactory,
  ReplicaSnapshot,
  ReplicaSnapshotRow,
  VaultChangeMessage,
} from "@centraid/client/replica/native";

import type { NativeChangeFeed } from "./native-session";

export const gatewayAuth: GatewayAuth = {
  baseUrl: "http://127.0.0.1:18789",
  gatewayId: "gateway-1",
  vaultId: "vault-a",
};

/**
 * Hermes has neither `crypto.subtle` nor `crypto.randomUUID`, so the session
 * takes both by injection; on device `./native-hash` supplies the expo-crypto
 * pair. Injecting here also keeps these node runs from loading an Expo native
 * module. `nodeDigest` is hex SHA-256 over UTF-8 — the same contract
 * `expo-crypto` and `crypto.subtle` satisfy, so payload hashes are identical.
 */
export const nodeDigest: ReplicaDigest = (input) =>
  Promise.resolve(createHash("sha256").update(input, "utf8").digest("hex"));

export function sequentialIds(): ReplicaIdFactory {
  let next = 0;
  return () => `intent-${++next}`;
}

/**
 * One windowed bootstrap page. Native always bootstraps windowed, so page 1
 * carries the catalog and every page reports its own snapshot cursor.
 */
export function page(
  cursor: ReplicaCursor,
  options: { rows?: ReplicaSnapshotRow[]; next?: string; first?: boolean } = {}
): Record<string, unknown> {
  const full = snapshot(cursor);
  return {
    protocolVersion: 1,
    vaultId: "vault-a",
    schemaEpoch: "schema-1",
    cursor,
    rows: options.rows ?? full.rows,
    complete: options.next === undefined,
    ...(options.next ? { next: options.next } : {}),
    ...(options.first === false
      ? {}
      : { shapes: full.shapes, shapeIds: ["shape-photos"] }),
  };
}

/** An already-converged delta pull: the mandatory post-bootstrap replay finds nothing. */
export function noChanges(cursor: ReplicaCursor): ReplicaChangeBatch {
  return {
    protocolVersion: 1,
    schemaEpoch: "schema-1",
    from: cursor,
    to: cursor,
    changes: [],
  };
}

function snapshot(cursor: ReplicaCursor): ReplicaSnapshot {
  return {
    protocolVersion: 1,
    vaultId: "vault-a",
    schemaEpoch: "schema-1",
    cursor,
    shapes: [
      {
        shapeId: "shape-photos",
        appId: "photos",
        purpose: "dpv:ServiceProvision",
        entities: [
          {
            entity: "core.content_item",
            primaryKey: "content_id",
            columns: ["content_id", "title", "deleted_at", "created_at"],
          },
        ],
      },
    ],
    rows: [
      {
        shapeId: "shape-photos",
        entity: "core.content_item",
        rowId: "photo-1",
        values: {
          content_id: "photo-1",
          title: "Original",
          deleted_at: null,
          created_at: "2026-07-15T10:00:00.000Z",
        },
      },
    ],
  };
}

interface FakeFeed extends NativeChangeFeed {
  readonly active: boolean;
  readonly shapeIds: readonly string[];
  emit: (message: VaultChangeMessage) => void;
}

/** Records active toggles and lets the test drive coordinator feed messages. */
export function createFeed(): FakeFeed {
  let listener: ((message: VaultChangeMessage) => void) | undefined;
  let active = false;
  let shapeIds: readonly string[] = [];
  return {
    get active() {
      return active;
    },
    get shapeIds() {
      return shapeIds;
    },
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async setShapeIds(next) {
      shapeIds = next;
    },
    async resume() {
      /* The coordinator only needs resume to resolve. */
    },
    setActive(next) {
      active = next;
    },
    emit(message) {
      listener?.(message);
    },
  };
}

type Responder = () => Response | Promise<Response>;

interface FakeGateway {
  on: (pathFragment: string, responder: Responder) => FakeGateway;
  readonly baseUrls: readonly string[];
  readonly pathnames: readonly string[];
  readonly fetcher: (
    baseUrl: string,
    pathname: string,
    init: RequestInit
  ) => Promise<Response>;
}

/** Programmable transport keyed by path, with a per-path FIFO of responders. */
export function createGateway(): FakeGateway {
  const queues = new Map<string, Responder[]>();
  const baseUrls: string[] = [];
  const pathnames: string[] = [];
  const gateway: FakeGateway = {
    baseUrls,
    pathnames,
    on(pathFragment, responder) {
      const queue = queues.get(pathFragment) ?? [];
      queue.push(responder);
      queues.set(pathFragment, queue);
      return gateway;
    },
    fetcher: (baseUrl, pathname) => {
      baseUrls.push(baseUrl);
      pathnames.push(pathname);
      for (const [fragment, queue] of queues) {
        if (pathname.includes(fragment) && queue.length > 0) {
          return Promise.resolve(queue.shift()!());
        }
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  };
  return gateway;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
