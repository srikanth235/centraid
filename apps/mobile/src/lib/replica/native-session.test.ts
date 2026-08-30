// The session's online rails: windowed bootstrap, the change feed and its
// app-state gating, gateway rebase, delta pull, the 409 rebootstrap, and the
// ship drain's settlement of waiters. The durable local write rail — payload
// hashing, offline queueing, network policy, cancellation and crash-recovered
// attention — is `native-session-write-rail.test.ts`; the doubles both suites
// share are in `native-session.test-fixtures.ts`.
import { describe, expect, test } from "vitest";

import type {
  ReplicaChangeBatch,
  ReplicaCursor,
  ReplicaSnapshotRow,
} from "@centraid/client/replica/native";

import type { AppStateLike } from "./native-session";
import { createNativeReplicaSession } from "./native-session";
import {
  createFeed,
  createGateway,
  gatewayAuth,
  json,
  noChanges,
  nodeDigest,
  page,
  sequentialIds,
} from "./native-session.test-fixtures";
import { NodeSqliteDriver } from "./node-sqlite-driver";

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

  test("explicitly rebootstraps when reachability has not published yet", async () => {
    const gateway = createGateway()
      .on("/replica/bootstrap", () =>
        json(page({ epoch: "replica-1", seq: 1 }))
      )
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })));
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => false,
      isNetworkWorkAllowed: async () => false,
    });
    try {
      expect((await session.status()).cursor).toBeNull();
      await session.rebootstrap({ force: true });
      expect((await session.status()).cursor).toStrictEqual({
        epoch: "replica-1",
        seq: 1,
      });
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

  test("settles the writes queued behind a failing head intent", async () => {
    const gateway = createGateway()
      .on("/replica/bootstrap", () =>
        json(page({ epoch: "replica-1", seq: 1 }))
      )
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })))
      .on("/replica/intents", () => json({ reason: "upstream" }, 500))
      .on("/replica/intents", () => json({ reason: "upstream" }, 500));
    let releaseHead: (() => void) | undefined;
    const heldHead = new Promise<void>((resolve) => {
      releaseHead = resolve;
    });
    let headHeld = false;
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: async (baseUrl, pathname, init) => {
        if (pathname.includes("/replica/intents") && !headHeld) {
          headHeld = true;
          await heldHead;
        }
        return gateway.fetcher(baseUrl, pathname, init);
      },
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      retryDelayMs: 60_000,
    });
    try {
      const head = session.write("photos", {
        action: "photos.favorite",
        input: { assetId: "asset-1", favorite: true },
      });
      await until(async () =>
        (await session.coordinator.intents.list()).some(
          (intent) => intent.state === "sending"
        )
      );
      const behind = session.write("photos", {
        action: "photos.favorite",
        input: { assetId: "asset-2", favorite: true },
      });
      await until(
        async () => (await session.coordinator.intents.list()).length === 2
      );
      releaseHead?.();

      const queued = {
        status: "queued",
        reason: "saved locally; retrying when the gateway is reachable",
      };
      await expect(head).resolves.toMatchObject({
        intentId: "intent-1",
        ...queued,
      });
      await expect(behind).resolves.toMatchObject({
        intentId: "intent-2",
        ...queued,
      });
    } finally {
      await session.close();
    }
  });

  test("rebootstrap aborts an in-flight walk so a post-write snapshot is not stuck behind it", async () => {
    const seeded = {
      shapeId: "shape-photos",
      entity: "core.content_item",
      rowId: "photo-seeded",
      values: {
        content_id: "photo-seeded",
        title: "Seeded after Home ready",
        deleted_at: null,
        created_at: "2026-08-29T10:00:00.000Z",
      },
    };
    const gateway = createGateway()
      .on("/replica/bootstrap", () =>
        json(page({ epoch: "replica-1", seq: 1 }))
      )
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })))
      .on("/replica/bootstrap", async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 40);
        });
        throw new Error("stale walk superseded");
      })
      .on("/replica/bootstrap", () =>
        json(page({ epoch: "replica-1", seq: 4 }, { rows: [seeded] }))
      )
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 4 })));
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
      expect((await session.status()).cursor).toStrictEqual({
        epoch: "replica-1",
        seq: 1,
      });
      session.requireBootstrap();
      await session.rebootstrap();
      expect((await session.status()).cursor).toStrictEqual({
        epoch: "replica-1",
        seq: 4,
      });
      const read = await session.read("photos", {
        entity: "core.content_item",
      });
      expect(read.rows.some((row) => row.rowId === "photo-seeded")).toBe(true);
    } finally {
      await session.close();
    }
  });

  test("rebootstrap is a no-op when the gateway is not connected", async () => {
    let connected = true;
    const gateway = createGateway()
      .on("/replica/bootstrap", () =>
        json(page({ epoch: "replica-1", seq: 1 }))
      )
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })));
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: createFeed(),
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => connected,
    });
    try {
      const boots = gateway.pathnames.filter((path) =>
        path.includes("/replica/bootstrap")
      ).length;
      expect(boots).toBeGreaterThan(0);
      connected = false;
      await session.rebootstrap();
      expect(
        gateway.pathnames.filter((path) => path.includes("/replica/bootstrap"))
      ).toHaveLength(boots);
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
