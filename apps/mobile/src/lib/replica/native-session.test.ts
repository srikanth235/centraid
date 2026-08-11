import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type {
  GatewayAuth,
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaDigest,
  ReplicaFetcher,
  ReplicaIdFactory,
  ReplicaSnapshot,
  ReplicaSnapshotRow,
  VaultChangeMessage,
} from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import type { AppStateLike, NativeChangeFeed } from "./native-session";
import { createNativeReplicaSession } from "./native-session";
import { NodeSqliteDriver } from "./node-sqlite-driver";

const gatewayAuth: GatewayAuth = {
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
const nodeDigest: ReplicaDigest = (input) =>
  Promise.resolve(createHash("sha256").update(input, "utf8").digest("hex"));

function sequentialIds(): ReplicaIdFactory {
  let next = 0;
  return () => `intent-${++next}`;
}

/**
 * One windowed bootstrap page. Native always bootstraps windowed, so page 1
 * carries the catalog and every page reports its own snapshot cursor.
 */
function page(
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
function noChanges(cursor: ReplicaCursor): ReplicaChangeBatch {
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
function createFeed(): FakeFeed {
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

interface FakeAppState extends AppStateLike {
  send: (state: string) => void;
}

function createAppState(): FakeAppState {
  let handler: ((state: string) => void) | undefined;
  let currentState = "active";
  return {
    get currentState() {
      return currentState;
    },
    addEventListener(_type, next) {
      handler = next;
      return {
        remove: () => {
          handler = undefined;
        },
      };
    },
    send(state) {
      currentState = state;
      handler?.(state);
    },
  };
}

type Responder = () => Response;

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
function createGateway(): FakeGateway {
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A transport that bootstraps once (page 1, complete) and then answers each
 * `POST /replica/intents` from a FIFO queue of outcomes, recording the
 * `intentId` each request actually carried — what the attention-journal
 * retry tests need to prove a retry ships under a fresh id (issue #738).
 */
function intentGateway(outcomes: readonly Record<string, unknown>[]): {
  fetcher: ReplicaFetcher;
  intentIds: string[];
} {
  const intentIds: string[] = [];
  let call = 0;
  const fetcher: ReplicaFetcher = (_baseUrl, pathname, init) => {
    if (pathname.includes("/replica/bootstrap")) {
      return Promise.resolve(json(page({ epoch: "replica-1", seq: 1 })));
    }
    if (pathname.includes("/replica/intents")) {
      const body = JSON.parse(String(init.body ?? "{}")) as {
        intentId: string;
      };
      intentIds.push(body.intentId);
      const outcome = outcomes[call] ?? { status: "executed" };
      call += 1;
      return Promise.resolve(
        json({ outcome: { intentId: body.intentId, ...outcome } })
      );
    }
    // Bootstrap's own mandatory convergence replay, and any later delta pull.
    return Promise.resolve(json(noChanges({ epoch: "replica-1", seq: 1 })));
  };
  return { fetcher, intentIds };
}

function changeBatch(
  from: ReplicaCursor,
  to: ReplicaCursor
): ReplicaChangeBatch {
  return {
    protocolVersion: 1,
    schemaEpoch: "schema-1",
    from,
    to,
    changes: [
      {
        op: "upsert",
        shapeId: "shape-photos",
        entity: "core.content_item",
        rowId: "photo-1",
        values: {
          content_id: "photo-1",
          title: "Renamed",
          deleted_at: null,
          created_at: "2026-07-15T10:00:00.000Z",
        },
      },
    ],
  };
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    return poll();
  };
  return poll();
}

describe(createNativeReplicaSession, () => {
  test("bootstraps on start and pulls deltas when the feed reports a newer cursor", async () => {
    const gateway = createGateway()
      .on("/replica/bootstrap", () =>
        json(page({ epoch: "replica-1", seq: 1 }))
      )
      // The bootstrap's own convergence replay runs first and finds nothing.
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })))
      .on("/changes", () =>
        json(
          changeBatch(
            { epoch: "replica-1", seq: 1 },
            { epoch: "replica-1", seq: 2 }
          )
        )
      );
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
    });
    try {
      expect((await session.status()).cursor).toStrictEqual({
        epoch: "replica-1",
        seq: 1,
      });
      expect(feed.active).toBe(true);

      feed.emit({
        type: "centraid:vault-cursor",
        cursor: { epoch: "replica-1", seq: 2 },
      });
      await until(async () => (await session.status()).cursor?.seq === 2);

      const read = await session.read("photos", {
        entity: "core.content_item",
      });
      expect(read.rows[0]?.values.title).toBe("Renamed");
    } finally {
      await session.close();
    }
  });

  test("pauses the feed on background and resumes it on foreground", async () => {
    const gateway = createGateway()
      .on("/replica/bootstrap", () =>
        json(page({ epoch: "replica-1", seq: 1 }))
      )
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })));
    const feed = createFeed();
    const appState = createAppState();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      appState,
    });
    try {
      expect(feed.active).toBe(true);
      appState.send("background");
      expect(feed.active).toBe(false);
      appState.send("active");
      expect(feed.active).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("uses a newly resolved tunnel port after process restart", async () => {
    const gateway = createGateway()
      .on("/replica/bootstrap", () =>
        json(page({ epoch: "replica-1", seq: 1 }))
      )
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })))
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })));
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth: { ...gatewayAuth },
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
    });
    try {
      session.updateGatewayBase("http://127.0.0.1:29999");
      await session.pullNow();
      expect(gateway.baseUrls.at(-1)).toBe("http://127.0.0.1:29999");
      expect(feed.active).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("write() enqueues and ships an intent using the injected Hermes crypto", async () => {
    const gateway = createGateway()
      .on("/replica/bootstrap", () =>
        json(page({ epoch: "replica-1", seq: 1 }))
      )
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })))
      .on("/replica/intents", () =>
        json({ outcome: { intentId: "intent-1", status: "executed" } })
      );
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
    });
    try {
      // Without injection this path throws on device: RN has no crypto.subtle
      // for the payload hash and no crypto.randomUUID for the intent id.
      const result = await session.write("photos", {
        action: "photos.favorite",
        input: { assetId: "asset-1", favorite: true },
      });
      expect(result).toMatchObject({
        intentId: "intent-1",
        status: "executed",
      });

      const [intent] = await session.coordinator.intents.list();
      expect(intent?.payloadHash).toBe(
        // The pinned cross-platform hash: identical under crypto.subtle,
        // expo-crypto and this node digest, so intent idempotency survives a
        // device swap.
        "9fb4ce111fbf05254e7437936d9e5082d6888dd4112fe38c8254c6d1beff844f"
      );
    } finally {
      await session.close();
    }
  });

  test("bootstraps a multi-page window and converges from the page-1 cursor", async () => {
    const rows = (id: string): ReplicaSnapshotRow[] => [
      {
        shapeId: "shape-photos",
        entity: "core.content_item",
        rowId: id,
        values: {
          content_id: id,
          title: id,
          deleted_at: null,
          created_at: "2026-07-15T10:00:00.000Z",
        },
      },
    ];
    const gateway = createGateway()
      // Page 1 pins the delta floor at seq 1; page 2 is read from a later snapshot.
      .on("/replica/bootstrap", () =>
        json(
          page(
            { epoch: "replica-1", seq: 1 },
            { rows: rows("photo-a"), next: "token-2" }
          )
        )
      )
      .on("/replica/bootstrap", () =>
        json(
          page(
            { epoch: "replica-1", seq: 3 },
            { rows: rows("photo-b"), first: false }
          )
        )
      )
      // The mandatory replay from seq 1 removes what page 1 handed us but that
      // was deleted before page 2's snapshot — the deletion hole this closes.
      .on("/changes", () =>
        json({
          protocolVersion: 1,
          schemaEpoch: "schema-1",
          from: { epoch: "replica-1", seq: 1 },
          to: { epoch: "replica-1", seq: 3 },
          changes: [
            {
              op: "delete",
              shapeId: "shape-photos",
              entity: "core.content_item",
              rowId: "photo-a",
            },
          ],
        })
      )
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 3 })));
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      bootstrapWindow: 1,
    });
    try {
      const read = await session.read("photos", {
        entity: "core.content_item",
      });
      expect(read.rows.map((row) => row.values.content_id)).toStrictEqual([
        "photo-b",
      ]);
      expect((await session.status()).cursor).toStrictEqual({
        epoch: "replica-1",
        seq: 3,
      });
    } finally {
      await session.close();
    }
  });

  test("a 409 pull rebootstraps without dropping a queued intent", async () => {
    const gateway = createGateway()
      .on("/replica/bootstrap", () =>
        json(page({ epoch: "replica-1", seq: 1 }))
      )
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })))
      .on("/changes", () => json({ reason: "restore" }, 409))
      .on("/replica/outcomes", () => json({ outcomes: [] }))
      .on("/replica/bootstrap", () =>
        json(page({ epoch: "replica-2", seq: 5 }))
      )
      .on("/changes", () => json(noChanges({ epoch: "replica-2", seq: 5 })));
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => true,
    });
    try {
      // Queue an intent directly so it stays 'queued' (no drain shipping it).
      await session.coordinator.enqueue({
        appId: "photos",
        action: "rename",
        input: { title: "Local edit" },
      });
      expect(
        (await session.coordinator.pendingIntents()).map((i) => i.intentId)
      ).toHaveLength(1);

      feed.emit({
        type: "centraid:vault-cursor",
        cursor: { epoch: "replica-1", seq: 2 },
      });
      // The 409 pull wipes canonical state and re-bootstraps to the new epoch.
      await until(
        async () => (await session.status()).cursor?.epoch === "replica-2"
      );

      // The queued intent lives in its own table and survives the wipe.
      const pending = await session.coordinator.pendingIntents();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.state).toBe("queued");
    } finally {
      await session.close();
    }
  });
});

// Issue #738 mobile gap 1/3: retry and conflict versions on the attention
// journal `pendingChanges()` reports. Sabotage-verified — dropping the
// `input`/`conflict` passthrough this suite covers back to the pre-fix
// mapping in `pendingChanges()` fails every test below that reads them.
describe("attention journal retry (issue #738)", () => {
  test("journals a denied write's action and payload, and clears on dismiss", async () => {
    const { fetcher, intentIds } = intentGateway([
      { status: "denied", reason: "the owner said no" },
    ]);
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher,
      changeFeed: createFeed(),
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
    });
    try {
      const result = await session.write("tasks", {
        action: "add",
        input: { title: "Beach house" },
      });
      expect(result).toMatchObject({ status: "denied" });
      const deniedId = intentIds[0];
      expect(deniedId).toBeDefined();

      const attention = (await session.pendingChanges()).find(
        (item) => "createdAt" in item
      );
      expect(attention).toMatchObject({
        intentId: deniedId,
        status: "denied",
        appId: "tasks",
        action: "add",
        reason: "the owner said no",
        input: { title: "Beach house" },
      });

      await expect(session.dismissAttention(deniedId!)).resolves.toBe(true);
      expect(
        (await session.pendingChanges()).some((item) => "createdAt" in item)
      ).toBe(false);
    } finally {
      await session.close();
    }
  });

  test("carries expected vs actual versions for a conflict, not a generic reason", async () => {
    const conflict = {
      entity: "schedule.task",
      rowId: "task-1",
      expectedVersion: 2,
      actualVersion: 5,
    };
    const { fetcher } = intentGateway([{ status: "conflict", conflict }]);
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher,
      changeFeed: createFeed(),
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
    });
    try {
      const result = await session.write("tasks", {
        action: "edit",
        input: { task_id: "task-1", title: "Renamed" },
      });
      expect(result).toMatchObject({ status: "conflict" });

      const attention = (await session.pendingChanges()).find(
        (item) => "createdAt" in item
      );
      expect(attention).toMatchObject({ status: "conflict", conflict });
    } finally {
      await session.close();
    }
  });

  test("a denied write survives a fresh session over the same SQLite file and offers retry", async () => {
    const file = path.join(tempDirSync("centraid-attention-restart-"), "v.db");
    const { fetcher } = intentGateway([
      { status: "denied", reason: "the owner said no" },
    ]);
    const before = await createNativeReplicaSession({
      gatewayAuth,
      fetcher,
      changeFeed: createFeed(),
      driver: new NodeSqliteDriver(file),
      digest: nodeDigest,
      idFactory: sequentialIds(),
    });
    await before.write("tasks", {
      action: "add",
      input: { title: "Beach house" },
    });
    await before.close();

    // A cold start over the same file, offline: nothing could have been
    // re-fetched, so a fetcher that throws proves the row is local truth.
    const after = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: () => Promise.reject(new Error("no network in this test")),
      changeFeed: createFeed(),
      driver: new NodeSqliteDriver(file),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => false,
    });
    try {
      const attention = (await after.pendingChanges()).find(
        (item) => "createdAt" in item
      );
      expect(attention).toMatchObject({
        status: "denied",
        appId: "tasks",
        action: "add",
        reason: "the owner said no",
        input: { title: "Beach house" },
      });
    } finally {
      await after.close();
    }
  });

  test("a discarded row stays discarded across a restart", async () => {
    const file = path.join(tempDirSync("centraid-attention-discard-"), "v.db");
    const { fetcher, intentIds } = intentGateway([{ status: "failed" }]);
    const before = await createNativeReplicaSession({
      gatewayAuth,
      fetcher,
      changeFeed: createFeed(),
      driver: new NodeSqliteDriver(file),
      digest: nodeDigest,
      idFactory: sequentialIds(),
    });
    await before.write("tasks", { action: "add", input: { title: "Gone" } });
    await expect(before.dismissAttention(intentIds[0]!)).resolves.toBe(true);
    await before.close();

    const after = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: () => Promise.reject(new Error("no network in this test")),
      changeFeed: createFeed(),
      driver: new NodeSqliteDriver(file),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => false,
    });
    try {
      expect(
        (await after.pendingChanges()).some((item) => "createdAt" in item)
      ).toBe(false);
    } finally {
      await after.close();
    }
  });

  test("mintIntentId escapes the double-tap coalescing cache a same-payload retry would hit", async () => {
    const { fetcher, intentIds } = intentGateway([
      { status: "denied", reason: "the owner said no" },
      { status: "executed" },
    ]);
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher,
      changeFeed: createFeed(),
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
    });
    try {
      await session.write("tasks", {
        action: "add",
        input: { title: "Beach house" },
      });
      const deniedId = intentIds[0]!;

      // The retry contract (ReplicaStatusBar.retryPendingChange): the old
      // attention record goes first, then a FRESH id — minted explicitly, so
      // it cannot fall back onto `deniedId` even though the action and input
      // are byte-identical and issued well inside the double-tap window.
      await expect(session.dismissAttention(deniedId)).resolves.toBe(true);
      const freshId = session.mintIntentId();
      expect(freshId).not.toBe(deniedId);
      const retried = await session.write("tasks", {
        action: "add",
        input: { title: "Beach house" },
        intentId: freshId,
      });

      expect(retried).toMatchObject({ status: "executed" });
      expect(intentIds).toStrictEqual([deniedId, freshId]);
      // The old attention record is gone, and the successful retry left no
      // new one — one write's whole lifecycle, not two rows for it.
      expect(
        (await session.pendingChanges()).some((item) => "createdAt" in item)
      ).toBe(false);
    } finally {
      await session.close();
    }
  });
});
