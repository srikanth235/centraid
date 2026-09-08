/**
 * PARITY ON THE REFUSALS, AND ON THE RULED DIVERGENCES (#883 C3).
 *
 * The other half of `read-plan-parity.test.ts`. Where that suite proves the two
 * engines return the same ROWS, this one proves they refuse the same INPUTS —
 * withheld and oversized fields, an unbreakable ORDER BY tie under an opaque
 * primary key — which is the harder half, because a pushdown that quietly
 * answered those would look correct on every row-count assertion ever written.
 *
 * And where the engines are RULED to differ, the divergence is asserted here in
 * the same terms `REPLICA_PUSHDOWN_DIVERGENCES` states it, so a silent change
 * of mind about one fails a test rather than passing review.
 */
import { describe, expect, test } from "vitest";

import { OnlineOnlyError, ReplicaProtocolError } from "./errors.js";
import {
  adversarialSnapshot,
  openFixture,
  rowIds,
} from "./read-plan-parity.test-fixtures.js";
import { REPLICA_PUSHDOWN_DIVERGENCES } from "./read-plan.js";
import { REPLICA_PROTOCOL_VERSION } from "./types.js";
import type {
  OptimisticMutation,
  ReplicaReadRequest,
  ReplicaShape,
  ReplicaSnapshot,
  ReplicaSnapshotRow,
} from "./types.js";

describe("replica read pushdown refusals", () => {
  test("refuses withheld and oversized fields exactly where the evaluator did", () => {
    const shape: ReplicaShape = {
      shapeId: "shape-masked",
      appId: "parity",
      entities: [
        {
          entity: "core.masked",
          primaryKey: "masked_id",
          columns: ["masked_id", "title", "body"],
          hasUnavailableFields: true,
        },
      ],
    };
    const snapshot: ReplicaSnapshot = {
      protocolVersion: REPLICA_PROTOCOL_VERSION,
      vaultId: "vault-masked",
      schemaEpoch: "schema-1",
      cursor: { epoch: "replica-1", seq: 1 },
      shapes: [shape],
      rows: [
        {
          shapeId: shape.shapeId,
          entity: "core.masked",
          rowId: "a",
          values: { masked_id: "a", title: "A" },
          oversizedFields: ["body"],
        },
        {
          shapeId: shape.shapeId,
          entity: "core.masked",
          rowId: "b",
          values: { masked_id: "b", title: "B", body: "small" },
          oversizedFields: [],
        },
      ],
    };
    const fixture = openFixture(snapshot);
    for (const partial of [
      { where: [{ column: "body", op: "not-null" as const }] },
      { where: [{ column: "title", op: "eq" as const, value: "A" }] },
      { orderBy: { column: "body" } },
      { orderBy: { column: "title" } },
    ]) {
      const { pushed, oracle } = fixture.both({
        shapeId: shape.shapeId,
        entity: "core.masked",
        ...partial,
      } as ReplicaReadRequest);
      expect(pushed).toStrictEqual(oracle);
    }
    // Anti-vacuity: the masked reads really do refuse rather than answer.
    expect(
      fixture.both({
        shapeId: shape.shapeId,
        entity: "core.masked",
        where: [{ column: "body", op: "not-null" }],
      }).pushed.kind
    ).toBe("threw");
    fixture.store.close();
  });

  test("refuses an unbreakable tie under an opaque primary key, as before", () => {
    const shape: ReplicaShape = {
      shapeId: "shape-opaque",
      appId: "parity",
      entities: [
        {
          entity: "core.opaque",
          primaryKey: "__centraid_row_id",
          columns: ["__centraid_row_id", "rank"],
        },
      ],
    };
    const rows = (ranks: number[]): ReplicaSnapshotRow[] =>
      ranks.map((rank, index) => ({
        shapeId: shape.shapeId,
        entity: "core.opaque",
        rowId: `opaque-${index}`,
        values: { __centraid_row_id: `opaque-${index}`, rank },
      }));
    for (const [ranks, refuses] of [
      [[1, 1], true],
      [[1, 2], false],
    ] as [number[], boolean][]) {
      const fixture = openFixture({
        protocolVersion: REPLICA_PROTOCOL_VERSION,
        vaultId: "vault-opaque",
        schemaEpoch: "schema-1",
        cursor: { epoch: "replica-1", seq: 1 },
        shapes: [shape],
        rows: rows(ranks),
      });
      const { pushed, oracle } = fixture.both({
        shapeId: shape.shapeId,
        entity: "core.opaque",
        orderBy: { column: "rank" },
        limit: 1,
      });
      expect(pushed).toStrictEqual(oracle);
      expect(pushed.kind).toBe(refuses ? "threw" : "rows");
      fixture.store.close();
    }
  });

  describe("ruled divergences", () => {
    test("D1 a malformed request raises against an empty entity", () => {
      const snapshot = adversarialSnapshot();
      const fixture = openFixture({ ...snapshot, rows: [] });
      const request: ReplicaReadRequest = {
        shapeId: snapshot.shapes[0]!.shapeId,
        entity: "core.item",
        where: [{ column: "rank", op: "in", value: [] }],
      };
      const { pushed, oracle } = fixture.both(request);
      expect(oracle).toStrictEqual({ kind: "rows", rows: [] });
      expect(pushed).toMatchObject({
        kind: "threw",
        name: new ReplicaProtocolError("x").name,
      });
      fixture.store.close();
    });

    test("D2 a heterogeneous `in` list escalates instead of reading candidate order", () => {
      const snapshot = adversarialSnapshot();
      const fixture = openFixture(snapshot);
      const request: ReplicaReadRequest = {
        shapeId: snapshot.shapes[0]!.shapeId,
        entity: "core.item",
        where: [{ column: "label", op: "in", value: ["plain", 7] }],
      };
      const { pushed, oracle } = fixture.both(request);
      // The evaluator's answer here is a function of the ARRAY ORDER: "plain"
      // matches before 7 is ever compared for the row that has it.
      expect(oracle.kind).toBe("threw");
      expect(pushed).toMatchObject({
        kind: "threw",
        name: new OnlineOnlyError("x").name,
      });
      fixture.store.close();
    });

    test("D4 an expanded-year stamp escalates rather than being compared", () => {
      const snapshot = adversarialSnapshot();
      const fixture = openFixture({
        ...snapshot,
        rows: [
          {
            shapeId: snapshot.shapes[0]!.shapeId,
            entity: "core.item",
            rowId: "far",
            values: {
              item_id: "far",
              captured_at: new Date(8.64e15).toISOString(),
            },
          },
        ],
      });
      const { pushed, oracle } = fixture.both({
        shapeId: snapshot.shapes[0]!.shapeId,
        entity: "core.item",
        where: [{ column: "captured_at", op: "within-next-days", value: 1 }],
      });
      expect(oracle).toStrictEqual({ kind: "rows", rows: [] });
      expect(pushed).toMatchObject({
        kind: "threw",
        name: new OnlineOnlyError("x").name,
      });
      fixture.store.close();
    });

    test("D6 a newly created optimistic row sorts by primary key, not last", () => {
      const snapshot = adversarialSnapshot();
      const fixture = openFixture(snapshot);
      const mutations: OptimisticMutation[] = [
        {
          op: "upsert",
          shapeId: snapshot.shapes[0]!.shapeId,
          entity: "core.item",
          rowId: "a-created",
          values: { item_id: "a-created", label: "created" },
        },
      ];
      const request: ReplicaReadRequest = {
        shapeId: snapshot.shapes[0]!.shapeId,
        entity: "core.item",
        limit: 2,
      };
      const { pushed, oracle } = fixture.both(request, mutations);
      expect(rowIds(pushed)).toStrictEqual(["a-created", "a-null"]);
      expect(rowIds(oracle)).toStrictEqual(["a-null", "b-absent"]);
      fixture.store.close();
    });

    test("the ruled list is the one this suite covers", () => {
      expect(REPLICA_PUSHDOWN_DIVERGENCES).toHaveLength(6);
    });
  });
});
