import { describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import { NodeSqliteDriver } from "./node-sqlite-test-driver.js";
import { ReplicaSqliteStore } from "./store-core.js";
import type {
  ReplicaChange,
  ReplicaChangeBatch,
  ReplicaShape,
  ReplicaSnapshot,
} from "./types.js";

const VAULT_ID = "vault-convergence-properties";
const EPOCH = "epoch-892";
const SCHEMA_EPOCH = "schema-892";
const ROW_IDS = ["row-1", "row-2", "row-3"] as const;

const SHAPES: ReplicaShape[] = [
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
];

function snapshot(): ReplicaSnapshot {
  return {
    protocolVersion: 1,
    vaultId: VAULT_ID,
    schemaEpoch: SCHEMA_EPOCH,
    cursor: { epoch: EPOCH, seq: 0 },
    shapes: SHAPES,
    rows: [
      {
        shapeId: "tasks",
        entity: "schedule.task",
        rowId: ROW_IDS[0],
        values: {
          task_id: ROW_IDS[0],
          title: "Seed",
          sort_order: 0,
          updated_at: "2026-01-01T00:00:00.000Z",
        },
      },
    ],
  };
}

interface Op {
  rowId: string;
  title: string | null;
  sortOrder: number;
}

const opArbitrary = fc.record({
  rowId: fc.constantFrom(...ROW_IDS),
  title: fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: null }),
  sortOrder: fc.integer({ min: 0, max: 5 }),
});

function toChange(op: Op, seq: number): ReplicaChange {
  if (op.title === null) {
    return {
      op: "delete",
      shapeId: "tasks",
      entity: "schedule.task",
      rowId: op.rowId,
    } as ReplicaChange;
  }
  return {
    op: "upsert",
    shapeId: "tasks",
    entity: "schedule.task",
    rowId: op.rowId,
    values: {
      task_id: op.rowId,
      title: op.title,
      sort_order: op.sortOrder,
      updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    },
  } as ReplicaChange;
}

function toBatches(
  changes: ReplicaChange[],
  cuts: number[]
): ReplicaChangeBatch[] {
  const boundaries = [
    ...new Set(cuts.filter((cut) => cut > 0 && cut < changes.length)),
  ].sort((left, right) => left - right);
  const batches: ReplicaChangeBatch[] = [];
  let start = 0;
  for (const end of [...boundaries, changes.length]) {
    if (end <= start) continue;
    batches.push({
      protocolVersion: 1,
      schemaEpoch: SCHEMA_EPOCH,
      from: { epoch: EPOCH, seq: start },
      to: { epoch: EPOCH, seq: end },
      changes: changes.slice(start, end),
    });
    start = end;
  }
  return batches;
}

function open(): ReplicaSqliteStore {
  const store = new ReplicaSqliteStore(new NodeSqliteDriver(), VAULT_ID);
  store.bootstrap(snapshot());
  return store;
}

describe("replica convergence", () => {
  test("two replicas fed the same canonical batches hold identical rows", () => {
    fc.assert(
      fc.property(
        fc.array(opArbitrary, { minLength: 1, maxLength: 12 }),
        fc.array(fc.nat({ max: 12 }), { maxLength: 4 }),
        fc.array(fc.nat({ max: 12 }), { maxLength: 4 }),
        (ops, cutsA, cutsB) => {
          const changes = ops.map((op, index) => toChange(op, index + 1));
          const left = open();
          const right = open();
          try {
            for (const batch of toBatches(changes, cutsA))
              left.applyChanges(batch);
            for (const batch of toBatches(changes, cutsB))
              right.applyChanges(batch);

            expect(
              left.read({ shapeId: "tasks", entity: "schedule.task" })
            ).toStrictEqual(
              right.read({ shapeId: "tasks", entity: "schedule.task" })
            );
            expect(left.status().cursor).toStrictEqual(right.status().cursor);
          } finally {
            left.close();
            right.close();
          }
        }
      ),
      { numRuns: 40, seed: 892 }
    );
  });

  test("the last canonical write for a row is the one that survives", () => {
    fc.assert(
      fc.property(
        fc.array(opArbitrary, { minLength: 2, maxLength: 12 }),
        (ops) => {
          const changes = ops.map((op, index) => toChange(op, index + 1));
          const store = open();
          try {
            for (const batch of toBatches(changes, []))
              store.applyChanges(batch);
            const { rows } = store.read({
              shapeId: "tasks",
              entity: "schedule.task",
            });
            const actual = new Map(
              rows.map((row) => [row.rowId, String(row.values.title ?? "")])
            );

            const model = new Map<string, string>([[ROW_IDS[0], "Seed"]]);
            for (const op of ops) {
              if (op.title === null) model.delete(op.rowId);
              else model.set(op.rowId, op.title);
            }

            const byRowId = (
              left: [string, string],
              right: [string, string]
            ): number => left[0].localeCompare(right[0]);
            expect(
              [...actual.entries()].toSorted(byRowId),
              "the replica's rows against a replay of the canonical log"
            ).toStrictEqual([...model.entries()].toSorted(byRowId));
          } finally {
            store.close();
          }
        }
      ),
      { numRuns: 40, seed: 892 }
    );
  });
});
