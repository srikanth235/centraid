import { describe, expect, test } from "vitest";

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
  test("task, contact, expense, and event converge after simultaneous offline writers replay the canonical log", () => {
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

      // Both offline writes may be visible optimistically on their source
      // device, but the gateway serializes their accepted commands once. Every
      // replica then consumes that same cursor-ordered truth.
      for (const store of [phone, laptop]) {
        store.applyChanges(batch(1, "device-a"));
        store.applyChanges(batch(2, "device-b"));
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
