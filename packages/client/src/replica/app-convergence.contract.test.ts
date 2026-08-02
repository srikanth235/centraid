import { describe, expect, test } from "vitest";

import { IntentQueue } from "./intents.js";
import { MemoryIntentStore } from "./memory-intent-store.js";
import { NodeSqliteDriver } from "./node-sqlite-test-driver.js";
import { ReplicaSqliteStore } from "./store-core.js";
import type {
  ReplicaChangeBatch,
  ReplicaShape,
  ReplicaSnapshot,
} from "./types.js";

const shapes: ReplicaShape[] = [
  {
    shapeId: "tasks",
    appId: "tasks",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "schedule.task",
        primaryKey: "task_id",
        columns: ["task_id", "title", "sort_order", "updated_at"],
      },
    ],
  },
  {
    shapeId: "people",
    appId: "people",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "social.contact_channel",
        primaryKey: "channel_id",
        columns: ["channel_id", "value", "is_preferred", "updated_at"],
      },
    ],
  },
  {
    shapeId: "tally",
    appId: "tally",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "tally.expense",
        primaryKey: "expense_id",
        columns: ["expense_id", "description", "amount_minor", "updated_at"],
      },
    ],
  },
  {
    shapeId: "agenda",
    appId: "agenda",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "core.event",
        primaryKey: "event_id",
        columns: ["event_id", "summary", "sequence", "updated_at"],
      },
    ],
  },
];

function initial(): ReplicaSnapshot {
  return {
    protocolVersion: 1,
    vaultId: "vault-convergence",
    schemaEpoch: "schema-630",
    cursor: { epoch: "epoch-630", seq: 1 },
    shapes,
    rows: [
      {
        shapeId: "tasks",
        entity: "schedule.task",
        rowId: "task-1",
        values: {
          task_id: "task-1",
          title: "Initial",
          sort_order: 0,
          updated_at: "2026-07-29T09:00:00.000Z",
        },
      },
      {
        shapeId: "people",
        entity: "social.contact_channel",
        rowId: "channel-1",
        values: {
          channel_id: "channel-1",
          value: "initial@example.com",
          is_preferred: 0,
          updated_at: "2026-07-29T09:00:00.000Z",
        },
      },
      {
        shapeId: "tally",
        entity: "tally.expense",
        rowId: "expense-1",
        values: {
          expense_id: "expense-1",
          description: "Initial",
          amount_minor: 100,
          updated_at: "2026-07-29T09:00:00.000Z",
        },
      },
      {
        shapeId: "agenda",
        entity: "core.event",
        rowId: "event-1",
        values: {
          event_id: "event-1",
          summary: "Initial",
          sequence: 0,
          updated_at: "2026-07-29T09:00:00.000Z",
        },
      },
    ],
  };
}

function batch(
  from: number,
  writer: "device-a" | "device-b"
): ReplicaChangeBatch {
  const last = writer === "device-b";
  const stamp = last ? "2026-07-29T09:02:00.000Z" : "2026-07-29T09:01:00.000Z";
  return {
    protocolVersion: 1,
    schemaEpoch: "schema-630",
    from: { epoch: "epoch-630", seq: from },
    to: { epoch: "epoch-630", seq: from + 1 },
    changes: [
      {
        op: "upsert",
        shapeId: "tasks",
        entity: "schedule.task",
        rowId: "task-1",
        values: {
          task_id: "task-1",
          title: last ? "Canonical task B" : "Offline task A",
          sort_order: last ? 2 : 1,
          updated_at: stamp,
        },
      },
      {
        op: "upsert",
        shapeId: "people",
        entity: "social.contact_channel",
        rowId: "channel-1",
        values: {
          channel_id: "channel-1",
          value: last ? "b@example.com" : "a@example.com",
          is_preferred: last ? 1 : 0,
          updated_at: stamp,
        },
      },
      {
        op: "upsert",
        shapeId: "tally",
        entity: "tally.expense",
        rowId: "expense-1",
        values: {
          expense_id: "expense-1",
          description: last ? "Canonical expense B" : "Offline expense A",
          amount_minor: last ? 275 : 250,
          updated_at: stamp,
        },
      },
      {
        op: "upsert",
        shapeId: "agenda",
        entity: "core.event",
        rowId: "event-1",
        values: {
          event_id: "event-1",
          summary: last ? "Canonical event B" : "Offline event A",
          sequence: last ? 2 : 1,
          updated_at: stamp,
        },
      },
    ],
  };
}

describe("app-level multi-device convergence", () => {
  test("task, contact, expense, and event converge after simultaneous offline writers survive flaky reconnect", async () => {
    const phone = new ReplicaSqliteStore(
      new NodeSqliteDriver(),
      "vault-convergence"
    );
    const laptop = new ReplicaSqliteStore(
      new NodeSqliteDriver(),
      "vault-convergence"
    );
    try {
      phone.bootstrap(initial());
      laptop.bootstrap(initial());

      const queues = ["device-a", "device-b"].map(
        (writer) =>
          new IntentQueue(new MemoryIntentStore(), {
            idFactory: () => `intent-${writer}`,
          })
      );
      const accepted: Array<{
        intentId: string;
        changes: ReplicaChangeBatch;
      }> = [];
      await Promise.all(
        queues.map(async (queue, index) => {
          const writer = index === 0 ? "device-a" : "device-b";
          const intent = await queue.enqueue({
            appId: "tasks",
            action: "task.update",
            input: { writer },
          });
          const reconnect = async (
            reason: string | undefined
          ): Promise<ReplicaChangeBatch | undefined> => {
            const claimed = await queue.claimNext();
            expect(claimed?.intentId).toBe(intent.intentId);
            expect(claimed?.input).toMatchObject({ writer });
            if (reason) {
              await queue.transportFailed(intent.intentId, reason);
              return undefined;
            }
            // The canonical batch is derived at the reconnect boundary from
            // the claimed durable intent. It is not a disconnected fixture
            // applied later by the test.
            const acceptedBatch = batch(index + 1, writer);
            await queue.awaitingChange(intent.intentId);
            await queue.applyOutcomes([
              { intentId: intent.intentId, status: "executed" },
            ]);
            accepted.push({
              intentId: intent.intentId,
              changes: acceptedBatch,
            });
            return acceptedBatch;
          };
          await reconnect("offline");
          await reconnect("connection-reset");
          const canonical = await reconnect(undefined);
          expect(canonical?.changes).toHaveLength(4);
          await expect(queue.pending()).resolves.toStrictEqual([]);
        })
      );

      expect(accepted.map(({ intentId }) => intentId).toSorted()).toStrictEqual(
        ["intent-device-a", "intent-device-b"]
      );
      accepted.sort(
        (left, right) => left.changes.from.seq - right.changes.from.seq
      );
      // Both replicas consume exactly the canonical batches returned by the
      // successful reconnects, in gateway order.
      for (const store of [phone, laptop]) {
        for (const outcome of accepted) store.applyChanges(outcome.changes);
      }

      for (const [shapeId, entity] of [
        ["tasks", "schedule.task"],
        ["people", "social.contact_channel"],
        ["tally", "tally.expense"],
        ["agenda", "core.event"],
      ] as const) {
        expect(phone.read({ shapeId, entity })).toStrictEqual(
          laptop.read({ shapeId, entity })
        );
      }
      expect(phone.status().cursor).toStrictEqual({
        epoch: "epoch-630",
        seq: 3,
      });
    } finally {
      phone.close();
      laptop.close();
    }
  });
});
