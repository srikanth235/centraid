import { describe, expect, test, vi } from "vitest";

import { createNativeReplicaSession, NOT_YET_SYNCED } from "./native-session";
import {
  createFeed,
  createGateway,
  gatewayAuth,
  json,
  noChanges,
  nodeDigest,
  sequentialIds,
} from "./native-session.test-fixtures";
import { NodeSqliteDriver } from "./node-sqlite-driver";
import {
  APP_ID,
  bootstrapPage,
  contentId,
  corpus,
  ENTITY,
  SCREEN_PAGE,
} from "./reconnect-to-fresh.fixture";

describe("a native session before its first bootstrap", () => {
  test("a session that has never bootstrapped is behind, not empty", async () => {
    let online = false;
    const gateway = createGateway()
      .on("/replica/bootstrap", () => json(bootstrapPage(corpus().slice(0, 1))))
      .on("/changes", () => json(noChanges({ epoch: "replica-1", seq: 1 })));
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: createFeed(),
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => online,
    });
    try {
      await expect(
        session.read(APP_ID, { entity: ENTITY, limit: SCREEN_PAGE })
      ).rejects.toThrow(/No offline shape/u);
      const admitted = await session.write("photos", {
        action: "trash",
        input: { content_id: contentId(0) },
      });
      expect("reason" in admitted && admitted.reason).toBe(NOT_YET_SYNCED);

      online = true;
      session.notifyReachable();
      await vi.waitFor(async () => {
        expect(
          (await session.read(APP_ID, { entity: ENTITY, limit: SCREEN_PAGE }))
            .rows.length
        ).toBeGreaterThan(0);
      });
    } finally {
      await session.close();
    }
  });
});
