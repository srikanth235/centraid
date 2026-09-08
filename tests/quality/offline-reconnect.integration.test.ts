import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { IntentQueue } from "../../packages/client/src/replica/intents.js";
import { NodeSeatDriver } from "../../packages/client/src/replica/seat/node-seat-driver.js";
import { SeatIntentStore } from "../../packages/client/src/replica/seat/seat-intent-store.js";
import type { IntentOutcome } from "../../packages/client/src/replica/types.js";
import {
  Dispatcher,
  Registry,
} from "../../packages/server/src/engine/index.js";
import { handleReplicaIntent } from "../../packages/server/src/routes/replica-intent-route.js";
import type { ReplicaIntentDispatcher } from "../../packages/server/src/routes/replica-intent-route.js";
import { replicaDispatchOutcome } from "../../packages/server/src/serve/build-gateway.js";
import { openVaultPlane } from "../../packages/server/src/serve/vault-plane.js";
import { forEachSequentially } from "../../packages/test-kit/src/sequential.js";
import { tempDir } from "../../packages/test-kit/src/temp-dir.js";

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe("R2 product offline/reconnect transport", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  // NO INDEXEDDB STUB SINCE #996 W5. Both queues in this case are SQLite now —
  // the browser's outbox was a second database beside the replica and went with
  // it — so the only global this ever needed is gone with the store.
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  test("PWA IndexedDB and mobile SQLite queues cross real HTTP and converge once after drops", async () => {
    const vaultDir = await tempDir("quality-r2-vault-");
    const registryDir = await tempDir("quality-r2-registry-");
    const codeDir = await tempDir("quality-r2-code-");
    cleanups.push(
      () => fs.rm(codeDir, { recursive: true, force: true }),
      () => fs.rm(registryDir, { recursive: true, force: true }),
      () => fs.rm(vaultDir, { recursive: true, force: true })
    );
    const plane = openVaultPlane({
      bootstrap: true,
      dir: vaultDir,
      logger,
      enableWalShipper: false,
    });
    cleanups.push(() => plane.stop());
    plane.recordAppInstall("planner", {
      scopes: [{ schema: "schedule", verbs: "act" }],
    });
    await fs.mkdir(path.join(codeDir, "actions"), { recursive: true });
    await fs.writeFile(
      path.join(codeDir, "app.json"),
      JSON.stringify({
        manifestVersion: 1,
        id: "planner",
        name: "Planner",
        version: "0.1.0",
        actionSideEffect: "vault-write",
        actions: [
          {
            name: "add_task",
            confirmation: "none",
            input: {
              type: "object",
              required: ["title"],
              properties: { title: { type: "string" } },
              additionalProperties: false,
            },
            writes: ["schedule.task"],
          },
        ],
        queries: [],
      })
    );
    await fs.writeFile(
      path.join(codeDir, "actions", "add_task.js"),
      `export default async ({ body, ctx }) => ({ status: 200, body: await ctx.vault.invoke({ command: 'schedule.add_task', input: { title: body.title } }) });\n`
    );
    const registry = new Registry(registryDir);
    await registry.load();
    await registry.ensureUploaded("planner");
    const dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async () => codeDir,
      vaultFor: () => plane.bridgeFor("planner"),
    });
    const dispatch: ReplicaIntentDispatcher = async (body) =>
      replicaDispatchOutcome(
        await dispatcher.write({
          app: body.appId,
          action: body.action,
          input: body.input,
          intentId: body.intentId,
        })
      );
    let resetNext = false;
    const server = createServer((req, res) => {
      if (resetNext) {
        resetNext = false;
        req.socket.destroy();
        return;
      }
      void handleReplicaIntent(req, res, {
        plane,
        access: {
          canWrite: true,
          rememberDevice: true,
          deviceId: String(req.headers["x-device-id"]),
          appId: "planner",
        },
        dispatch,
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        })
    );
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // TWO SEATS, ONE STORE CLASS (#996 W5). This used to be two outbox
    // implementations — IndexedDB on the browser, SQLite on the phone — and
    // the claim was that both reconnect the same way. The outbox is a table in
    // the seat's own file on both hosts now, so what differs between these two
    // devices is the FILE, which is what the claim was ever about.
    const pwaStore = SeatIntentStore.create(new NodeSeatDriver(":memory:"));
    const mobileStore = SeatIntentStore.create(new NodeSeatDriver(":memory:"));
    // NO CURSOR BEHIND THESE TWO, AND THEY SAY SO (#996, R24). A seat store
    // parks an executed answer on its `commit_seq` and waits for the applier to
    // reach it — correct on a real device, and a queue with no applier would
    // hold `awaiting-change` forever. This case is about the TRANSPORT: a
    // reconnect that sends the same intent twice must settle it once. So the
    // wiring is stated rather than inherited, exactly as `IntentQueueOptions`
    // provides for.
    const noCursor = { settlesByCommitSeq: false };
    const queues = [
      { deviceId: "pwa-device", queue: new IntentQueue(pwaStore, noCursor) },
      {
        deviceId: "mobile-device",
        queue: new IntentQueue(mobileStore, noCursor),
      },
    ];

    await forEachSequentially(queues, async (target, index) => {
      const intent = await target.queue.enqueue({
        intentId: `quality-r2-${target.deviceId}`,
        appId: "planner",
        action: "add_task",
        input: { title: `Offline ${index + 1}` },
      });
      expect((await target.queue.claimNext())?.intentId).toBe(intent.intentId);
      await target.queue.transportFailed(intent.intentId, "offline");
      const claimed = await target.queue.claimNext();
      expect(claimed?.intentId).toBe(intent.intentId);
      resetNext = true;
      await expect(
        fetch(`${base}/centraid/_vault/replica/intents`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-device-id": target.deviceId,
          },
          body: JSON.stringify(claimed),
        })
      ).rejects.toThrow(/fetch failed|socket|other side closed/u);
      await target.queue.transportFailed(intent.intentId, "connection-reset");
      const retry = await target.queue.claimNext();
      const response = await fetch(`${base}/centraid/_vault/replica/intents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": target.deviceId,
        },
        body: JSON.stringify(retry),
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as {
        outcome: IntentOutcome;
      };
      expect(result.outcome, JSON.stringify(result.outcome)).toMatchObject({
        intentId: intent.intentId,
        status: "executed",
      });
      await target.queue.awaitingChange(intent.intentId);
      await target.queue.applyOutcomes([result.outcome]);
      await expect(target.queue.pending()).resolves.toStrictEqual([]);

      const replay = await fetch(`${base}/centraid/_vault/replica/intents`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": target.deviceId,
        },
        body: JSON.stringify(retry),
      });
      expect(replay.status).toBe(200);
    });

    const canonical = plane.db.vault
      .prepare(
        "SELECT title FROM schedule_task WHERE title LIKE 'Offline %' ORDER BY title"
      )
      .all() as Array<{ title: string }>;
    expect(canonical.map(({ title }) => title)).toStrictEqual([
      "Offline 1",
      "Offline 2",
    ]);
    expect(
      plane.db.vault
        .prepare(
          "SELECT count(*) AS n FROM replica_intent_outcome WHERE status = 'executed'"
        )
        .get()
    ).toMatchObject({ n: 2 });
  });
});
