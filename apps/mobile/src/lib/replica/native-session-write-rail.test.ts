// The session's durable local write rail. The online rails are
// `native-session.test.ts`; shared doubles are in
// `native-session.test-fixtures.ts`.
import { describe, expect, test, vi } from "vitest";

import { IntentQueue } from "@centraid/client/replica/native";

import { createNativeReplicaSession, NOT_YET_SYNCED } from "./native-session";
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
import { SqliteIntentStore } from "./sqlite-intent-store";

describe(createNativeReplicaSession, () => {
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

  test("durably queues a first-open offline write before bootstrap", async () => {
    const gateway = createGateway();
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => false,
    });
    try {
      await expect(
        session.write("photos", {
          action: "photos.favorite",
          input: { assetId: "asset-1", favorite: true },
        })
        // NOT "waiting for a connection": that row is on screen and unsent,
        // while this one has no projection to draw at all until bootstrap
        // supplies the shape catalog (#883 D1). The distinction, the durable
        // stand-in reason and the backfill are pinned by
        // `pending-write-visibility.test.ts`.
      ).resolves.toStrictEqual({
        intentId: "intent-1",
        status: "queued",
        reason: NOT_YET_SYNCED,
      });

      await expect(session.coordinator.intents.list()).resolves.toMatchObject([
        {
          intentId: "intent-1",
          state: "queued",
          input: { assetId: "asset-1", favorite: true },
          optimistic: [],
          reason: NOT_YET_SYNCED,
        },
      ]);
      expect(gateway.pathnames).toStrictEqual([]);
    } finally {
      await session.close();
    }
  });

  test("settles an awaited write as queued when the policy pauses sync", async () => {
    const gateway = createGateway();
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => true,
      isNetworkWorkAllowed: () => Promise.resolve(false),
    });
    try {
      await expect(
        session.write("photos", {
          action: "photos.favorite",
          input: { assetId: "asset-1", favorite: true },
        })
      ).resolves.toStrictEqual({
        intentId: "intent-1",
        status: "queued",
        reason: "saved locally; sync is paused on this network",
      });
      expect(gateway.pathnames).toStrictEqual([]);
    } finally {
      await session.close();
    }
  });

  test("cancelling a pending change retires it without a second dismissal", async () => {
    const gateway = createGateway();
    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: feed,
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => false,
    });
    try {
      const written = await session.write("photos", {
        action: "photos.favorite",
        input: { assetId: "asset-1", favorite: true },
      });
      await expect(session.cancelPendingChange(written.intentId)).resolves.toBe(
        true
      );

      await expect(session.pendingChanges()).resolves.toStrictEqual([]);
      await expect(session.coordinator.intents.list()).resolves.toStrictEqual(
        []
      );
      await expect(
        session.coordinator.intents.listSettled()
      ).resolves.toMatchObject([
        {
          intentId: written.intentId,
          status: "denied",
          reason: "Cancelled on this device",
        },
      ]);
    } finally {
      await session.close();
    }
  });

  test("startup finishes an interrupted replacement without stranding attention", async () => {
    const driver = new NodeSqliteDriver();
    const store = SqliteIntentStore.create(driver);
    const queue = new IntentQueue(store, {
      digest: nodeDigest,
      idFactory: () => "intent-replacement",
    });
    await queue.enqueue({
      intentId: "intent-original",
      appId: "photos",
      action: "photos.favorite",
      input: { assetId: "asset-1", favorite: true },
      optimistic: [
        {
          op: "upsert",
          shapeId: "shape-photos",
          entity: "core.content_item",
          rowId: "pending:intent-original:row",
          values: { content_id: "pending:intent-original:row" },
        },
      ],
    });
    await queue.claimNext();
    await queue.applyOutcomes([
      {
        intentId: "intent-original",
        status: "failed",
        reason: "gateway said no",
      },
    ]);
    // The crash window the supersession marker exists for: the successor is
    // durable, its predecessor is not settled yet.
    vi.spyOn(store, "settle").mockRejectedValueOnce(
      new Error("interrupted mid-handoff")
    );
    await expect(queue.retry("intent-original")).rejects.toThrow(
      "interrupted mid-handoff"
    );
    expect(store.attention()).toStrictEqual([]);

    const feed = createFeed();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: createGateway().fetcher,
      changeFeed: feed,
      driver,
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => false,
    });
    try {
      const pending = await session.pendingChanges();
      expect(pending.map((change) => change.intentId)).toStrictEqual([
        "intent-replacement",
      ]);
      expect(pending[0]).toMatchObject({
        status: "queued",
        attempts: 0,
        enqueuedAt: expect.any(String),
      });
      await expect(
        session.coordinator.intents.listSettled()
      ).resolves.toMatchObject([
        { intentId: "intent-original", status: "failed" },
      ]);
    } finally {
      await session.close();
    }
  });
});
