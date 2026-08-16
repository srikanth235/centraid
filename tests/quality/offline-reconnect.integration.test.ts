import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SqliteIntentStore } from "../../apps/mobile/src/lib/replica/sqlite-intent-store.js";
import { IndexedDbIntentStore } from "../../packages/client/src/replica/intent-store.js";
import { IntentQueue } from "../../packages/client/src/replica/intents.js";
import { NodeSqliteDriver } from "../../packages/client/src/replica/node-sqlite-test-driver.js";
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

  beforeEach(() => vi.stubGlobal("IDBKeyRange", IDBKeyRange));

  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
    vi.unstubAllGlobals();
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
    plane.approveGrant("planner", {
      purpose: "dpv:ServiceProvision",
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
      `export default async ({ body, ctx }) => ({ status: 200, body: await ctx.vault.invoke({ command: 'schedule.add_task', input: { title: body.title }, purpose: 'dpv:ServiceProvision' }) });\n`
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
    const pwaStore = await IndexedDbIntentStore.open(
      `quality-r2-${crypto.randomUUID()}`,
      new IDBFactory()
    );
    const mobileStore = SqliteIntentStore.create(new NodeSqliteDriver());
    const queues = [
      { deviceId: "pwa-device", queue: new IntentQueue(pwaStore) },
      { deviceId: "mobile-device", queue: new IntentQueue(mobileStore) },
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
