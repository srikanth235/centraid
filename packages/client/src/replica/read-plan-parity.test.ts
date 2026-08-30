/**
 * GOLDEN PARITY: the compiled SQL plan against the evaluator it replaced
 * (#883 C3) — same corpus, same request, same rows in the same order, and the
 * same refusal on the same input.
 *
 * The corpus is the scale rig's own, dialled down: parity is not a property of
 * volume, and the nightly rig keeps the volume. Ruled divergences are asserted
 * in the terms `REPLICA_PUSHDOWN_DIVERGENCES` states them.
 */
import { describe, expect, test } from "vitest";

import {
  buildCorpus,
  buildSnapshot,
  inFilterIds,
  READ_REQUESTS,
} from "../../../../tests/scale/browser-replica-query.fixture.js";
import {
  adversarialSnapshot,
  NOW,
  openFixture,
  PARITY_IN_IDS,
  PARITY_ROWS,
  rowIds,
} from "./read-plan-parity.test-fixtures.js";
import { planReplicaRead } from "./read-plan.js";
import type { OptimisticMutation, ReplicaReadRequest } from "./types.js";

describe("replica read pushdown parity", () => {
  const fixtureSnapshot = buildSnapshot(buildCorpus(PARITY_ROWS));

  test("answers the scale rig's own three reads exactly as the evaluator did", () => {
    const fixture = openFixture(fixtureSnapshot);
    const requests: ReplicaReadRequest[] = [
      READ_REQUESTS.fullEntity!,
      READ_REQUESTS.filteredSorted!,
      {
        ...READ_REQUESTS.inFilter!,
        where: [
          {
            column: "content_id",
            op: "in",
            value: inFilterIds(PARITY_IN_IDS, PARITY_ROWS),
          },
        ],
        limit: PARITY_IN_IDS,
      },
    ];
    for (const request of requests) {
      const { pushed, oracle } = fixture.both(request);
      expect(oracle.kind).toBe("rows");
      expect(pushed).toStrictEqual(oracle);
    }
    // Anti-vacuity: identical EMPTY answers would satisfy the loop above.
    expect(fixture.both(READ_REQUESTS.fullEntity!).pushed).toMatchObject({
      kind: "rows",
    });
    expect(
      fixture.store.read(READ_REQUESTS.filteredSorted!, [], NOW).rows
    ).toHaveLength(200);
    fixture.store.close();
  });

  /**
   * THE ORACLE HAS TEETH. Two hand-edits, each removing one mechanism the
   * pushdown depends on and each still valid SQL, caught by the same
   * comparison the passing assertions use.
   */
  test("a deliberately broken plan fails this same comparison", () => {
    const snapshot = adversarialSnapshot();
    const fixture = openFixture(snapshot);
    const shapeId = snapshot.shapes[0]!.shapeId;

    // (1) ESCALATION-FIRST ORDERING. `mixed` straddles the classes, so this
    // read must refuse — but the row that proves it sorts second under the
    // caller's ORDER BY, so a page of one would miss it.
    const escalating: ReplicaReadRequest = {
      shapeId,
      entity: "core.item",
      where: [{ column: "mixed", op: "eq", value: "seven" }],
      orderBy: { column: "rank", dir: "asc" },
      limit: 1,
    };
    const refused = fixture.both(escalating);
    expect(refused.oracle.kind).toBe("threw");
    expect(refused.pushed).toStrictEqual(refused.oracle);
    const escalationPlan = planReplicaRead(fixture.schema, escalating, NOW);
    const unguarded = escalationPlan.sql.replace("(verdict = 0) ASC, ", "");
    expect(unguarded).not.toBe(escalationPlan.sql);
    const answered = fixture.driver.all<{ row_id: string; verdict: number }>(
      unguarded,
      escalationPlan.binds
    );
    expect(answered).toHaveLength(1);
    // Verdict zero: no evidence on the page, so `assertReplicaPage` lets it by.
    expect(answered[0]!.verdict).toBe(0);

    // (2) ORDER DIRECTION — the cheapest plan bug, caught on rows alone.
    const ordered: ReplicaReadRequest = {
      shapeId,
      entity: "core.item",
      orderBy: { column: "rank", dir: "desc" },
      limit: 3,
    };
    const honest = fixture.both(ordered);
    expect(honest.pushed).toStrictEqual(honest.oracle);
    const orderPlan = planReplicaRead(fixture.schema, ordered, NOW);
    const flipped = orderPlan.sql.replace(
      "json_extract(payload_json, '$.rank') DESC",
      "json_extract(payload_json, '$.rank') ASC"
    );
    expect(flipped).not.toBe(orderPlan.sql);
    expect(
      fixture.driver
        .all<{ row_id: string }>(flipped, orderPlan.binds)
        .map((row) => row.row_id)
    ).not.toStrictEqual(rowIds(honest.oracle));
    fixture.store.close();
  });

  test.each([
    ["no clauses at all", { limit: 5 }],
    [
      "a JSON null versus an absent field",
      { where: [{ column: "label", op: "is-null" }] },
    ],
    [
      "the complement of that",
      { where: [{ column: "label", op: "not-null" }] },
    ],
    [
      "equality on an absent field",
      { where: [{ column: "sparse", op: "eq", value: "here" }] },
    ],
    [
      "a null clause value",
      { where: [{ column: "label", op: "eq", value: null }] },
    ],
    [
      "a boolean against a JSON boolean",
      { where: [{ column: "flag", op: "eq", value: true }] },
    ],
    [
      "a real against integers",
      { where: [{ column: "rank", op: "gt", value: 3 }] },
    ],
    [
      "inequality, which keeps nulls out",
      { where: [{ column: "label", op: "ne", value: "plain" }] },
    ],
    [
      "UTF-8 BINARY ordering over case folding and the astral plane",
      { orderBy: { column: "label", dir: "asc" }, limit: 50 },
    ],
    [
      "that ordering reversed",
      { orderBy: { column: "label", dir: "desc" }, limit: 50 },
    ],
    [
      "ties broken by the exposed primary key, under a limit",
      { orderBy: { column: "rank", dir: "asc" }, limit: 4 },
    ],
    [
      "ordering by the primary key itself",
      { orderBy: { column: "item_id", dir: "desc" }, limit: 3 },
    ],
    ["a limit past the end of the entity", { limit: 100 }],
    [
      "duplicate ids in an `in` list",
      {
        where: [
          {
            column: "item_id",
            op: "in",
            value: ["c-plain", "c-plain", "d-upper"],
          },
        ],
      },
    ],
    [
      "ids that match nothing",
      { where: [{ column: "item_id", op: "in", value: ["nope"] }] },
    ],
    [
      "a null-only `in` list",
      { where: [{ column: "label", op: "in", value: [null] }] },
    ],
    [
      "`in` over a column with absent values",
      { where: [{ column: "sparse", op: "in", value: ["here"] }] },
    ],
    [
      "a structured value under a filter",
      { where: [{ column: "structured", op: "is-null" }] },
    ],
    [
      "a structured value under ORDER BY",
      { orderBy: { column: "structured" } },
    ],
    [
      "a mixed-type comparison",
      { where: [{ column: "label", op: "eq", value: 1 }] },
    ],
    [
      "ORDER BY over a mixed-type column",
      { orderBy: { column: "mixed" }, limit: 20 },
    ],
    [
      "a filter over a mixed-type column",
      { where: [{ column: "mixed", op: "eq", value: "seven" }] },
    ],
    [
      "ORDER BY over a uniformly textual column with nulls",
      { orderBy: { column: "captured_at" }, limit: 20 },
    ],
    [
      "a day range over canonical and loose stamps",
      { where: [{ column: "captured_at", op: "within-days", value: 3 }] },
    ],
    [
      "a forward day range",
      { where: [{ column: "captured_at", op: "within-next-days", value: 3 }] },
    ],
    [
      "a non-positive day range",
      { where: [{ column: "captured_at", op: "within-days", value: 0 }] },
    ],
    ["an unknown column", { where: [{ column: "nope", op: "eq", value: 1 }] }],
    ["an unknown ORDER BY column", { orderBy: { column: "nope" } }],
    ["a fractional limit", { limit: 1.5 }],
    ["a zero limit, which the floor lifts to one", { limit: 0 }],
  ] as [string, Partial<ReplicaReadRequest>][])(
    "matches the evaluator on %s",
    (_name, partial) => {
      const snapshot = adversarialSnapshot();
      const fixture = openFixture(snapshot);
      const { pushed, oracle } = fixture.both({
        shapeId: snapshot.shapes[0]!.shapeId,
        entity: "core.item",
        ...partial,
      } as ReplicaReadRequest);
      expect(pushed).toStrictEqual(oracle);
      fixture.store.close();
    }
  );

  test("matches the evaluator with a durable outbox composed over the read", () => {
    const snapshot = adversarialSnapshot();
    const fixture = openFixture(snapshot);
    const mutations: OptimisticMutation[] = [
      {
        op: "upsert",
        shapeId: snapshot.shapes[0]!.shapeId,
        entity: "core.item",
        rowId: "c-plain",
        values: { label: "edited", rank: 99 },
      },
      {
        op: "delete",
        shapeId: snapshot.shapes[0]!.shapeId,
        entity: "core.item",
        rowId: "d-upper",
      },
      {
        op: "upsert",
        shapeId: snapshot.shapes[0]!.shapeId,
        entity: "core.item",
        rowId: "z-new",
        values: { item_id: "z-new", label: "created", rank: 0 },
      },
    ];
    for (const request of [
      { orderBy: { column: "rank", dir: "asc" as const }, limit: 20 },
      { where: [{ column: "label", op: "eq" as const, value: "edited" }] },
      {
        where: [
          {
            column: "item_id",
            op: "in" as const,
            value: ["z-new", "c-plain", "d-upper"],
          },
        ],
      },
      { limit: 50 },
    ]) {
      const { pushed, oracle } = fixture.both(
        {
          shapeId: snapshot.shapes[0]!.shapeId,
          entity: "core.item",
          ...request,
        } as ReplicaReadRequest,
        mutations
      );
      expect(oracle.kind).toBe("rows");
      expect(pushed).toStrictEqual(oracle);
    }
    fixture.store.close();
  });
});
