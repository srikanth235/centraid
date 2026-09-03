/**
 * NO SILENT TRUNCATION, AT THE REPLICA LAYER (#922 0a).
 *
 * The 1,000-row default is kept as a bound; what is deleted is its silence.
 * The three cases that matter are the three a wrong screen comes from: the
 * default cap fills, a declared window fills, and a short page that hid
 * nothing must not claim it did — an over-reporting notice is as dishonest as
 * a missing one, and is the failure a naive `rows.length === limit` check
 * produces on a set of exactly `limit` rows.
 */
import { describe, expect, test } from "vitest";

import { NodeSqliteDriver } from "./node-sqlite-test-driver.js";
import {
  planReplicaRead,
  REPLICA_DEFAULT_LOCAL_ROWS,
  trimReplicaPage,
  UnboundedReplicaReadError,
  assertBoundedReplicaRead,
} from "./read-plan.js";
import { REPLICA_DEFAULT_SEARCH_ROWS } from "./search.js";
import { ReplicaSqliteStore } from "./store-core.js";
import { REPLICA_PROTOCOL_VERSION } from "./types.js";
import type {
  ReplicaShape,
  ReplicaSnapshot,
  ReplicaSnapshotRow,
} from "./types.js";

const SHAPE: ReplicaShape = {
  shapeId: "shape-truncation",
  appId: "parity",
  purpose: "dpv:ServiceProvision",
  entities: [
    { entity: "core.item", primaryKey: "item_id", columns: ["item_id", "n"] },
    // A locally searchable entity, so the FTS window has something to fill.
    {
      entity: "knowledge.annotation",
      primaryKey: "annotation_id",
      columns: ["annotation_id", "body_text"],
    },
  ],
};

function searchSnapshot(rowCount: number): ReplicaSnapshot {
  const base = snapshot(0);
  const rows: ReplicaSnapshotRow[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const rowId = `note-${String(index).padStart(6, "0")}`;
    rows.push({
      shapeId: SHAPE.shapeId,
      entity: "knowledge.annotation",
      rowId,
      // One shared term so every row is a hit, ranked and bounded together.
      values: { annotation_id: rowId, body_text: `lease clause ${index}` },
    });
  }
  return { ...base, rows };
}

function openSearch(rowCount: number): ReplicaSqliteStore {
  const store = new ReplicaSqliteStore(
    new NodeSqliteDriver(),
    "vault-truncation"
  );
  store.bootstrap(searchSnapshot(rowCount));
  return store;
}

function snapshot(rowCount: number): ReplicaSnapshot {
  const rows: ReplicaSnapshotRow[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    // Zero-padded so BINARY row_id order is numeric order.
    const rowId = `item-${String(index).padStart(6, "0")}`;
    rows.push({
      shapeId: SHAPE.shapeId,
      entity: "core.item",
      rowId,
      values: { item_id: rowId, n: index },
    });
  }
  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    vaultId: "vault-truncation",
    schemaEpoch: "schema-1",
    cursor: { epoch: "replica-1", seq: 1 },
    shapes: [SHAPE],
    rows,
  };
}

function open(rowCount: number): ReplicaSqliteStore {
  const store = new ReplicaSqliteStore(
    new NodeSqliteDriver(),
    "vault-truncation"
  );
  store.bootstrap(snapshot(rowCount));
  return store;
}

describe("replica read truncation", () => {
  test("the default cap filling is reported, with the limit that was applied", () => {
    const store = open(REPLICA_DEFAULT_LOCAL_ROWS + 1);
    const result = store.read({
      shapeId: SHAPE.shapeId,
      entity: "core.item",
      acceptTruncation: true,
    });
    expect(result.rows).toHaveLength(REPLICA_DEFAULT_LOCAL_ROWS);
    expect(result.truncated).toBe(true);
    expect(result.appliedLimit).toBe(REPLICA_DEFAULT_LOCAL_ROWS);
    store.close();
  });

  test("a page under the cap is not truncated", () => {
    const store = open(12);
    const result = store.read({
      shapeId: SHAPE.shapeId,
      entity: "core.item",
      acceptTruncation: true,
    });
    expect(result.rows).toHaveLength(12);
    expect(result.truncated).toBeUndefined();
    expect(result.appliedLimit).toBeUndefined();
    store.close();
  });

  test("a set of exactly the cap fills the window without hiding a row", () => {
    // The over-report a `rows.length === limit` check produces. The probe row
    // is what makes this case answerable at all.
    const store = open(REPLICA_DEFAULT_LOCAL_ROWS);
    const result = store.read({
      shapeId: SHAPE.shapeId,
      entity: "core.item",
      acceptTruncation: true,
    });
    expect(result.rows).toHaveLength(REPLICA_DEFAULT_LOCAL_ROWS);
    expect(result.truncated).toBeUndefined();
    store.close();
  });

  test("an explicit window that fills reports that window, not the default", () => {
    const store = open(50);
    const result = store.read({
      shapeId: SHAPE.shapeId,
      entity: "core.item",
      limit: 10,
    });
    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.appliedLimit).toBe(10);
    store.close();
  });

  test("the plan over-fetches by exactly one and names its own window", () => {
    const plan = planReplicaRead(
      SHAPE.entities[0]!,
      { shapeId: SHAPE.shapeId, entity: "core.item", limit: 25 },
      new Date()
    );
    expect(plan.limit).toBe(25);
    expect(plan.limitDefaulted).toBe(false);
    expect(plan.binds.at(-1)).toBe(26);
    const defaulted = planReplicaRead(
      SHAPE.entities[0]!,
      { shapeId: SHAPE.shapeId, entity: "core.item" },
      new Date()
    );
    expect(defaulted.limit).toBe(REPLICA_DEFAULT_LOCAL_ROWS);
    expect(defaulted.limitDefaulted).toBe(true);
    // The probe never reaches a caller.
    const page = trimReplicaPage(
      Array.from({ length: 26 }, (_, i) => i),
      plan
    );
    expect(page.rows).toHaveLength(25);
    expect(page.truncated).toBe(true);
  });
});

describe("the bounded-read boundary rule", () => {
  test("refuses a read that declares neither a window nor acceptance", () => {
    const refusal = (() => {
      try {
        assertBoundedReplicaRead({ entity: "core.party" });
      } catch (error) {
        return error as UnboundedReplicaReadError;
      }
      return undefined;
    })();
    expect(refusal).toBeInstanceOf(UnboundedReplicaReadError);
    expect(refusal?.code).toBe("UNBOUNDED_READ");
    expect(refusal?.entity).toBe("core.party");
    // Names the entity and both fixes, so the message IS the work order.
    expect(refusal?.message).toContain("core.party");
    expect(refusal?.message).toContain("limit");
    expect(refusal?.message).toContain("acceptTruncation");
  });

  test("admits a declared window, and an accepted default", () => {
    expect(() =>
      assertBoundedReplicaRead({ entity: "core.party", limit: 5000 })
    ).not.toThrow();
    expect(() =>
      assertBoundedReplicaRead({ entity: "core.party", acceptTruncation: true })
    ).not.toThrow();
  });
});

/**
 * THE FTS PATH KEPT THE SILENCE THE READ PATH LOST (#922 0a, verifier follow-up
 * 1). Same three cases, same "exactly at the cap is not truncated" rule, over
 * the real SQLite FTS index rather than a stub — a ranked page is where an
 * over-report would be easiest to write and hardest to notice.
 */
describe("replica search truncation", () => {
  test("the default search cap filling is reported, with the limit applied", () => {
    const store = openSearch(REPLICA_DEFAULT_SEARCH_ROWS + 1);
    const result = store.search({
      shapeId: SHAPE.shapeId,
      entity: "knowledge.annotation",
      query: "lease",
    });
    expect(result.rows).toHaveLength(REPLICA_DEFAULT_SEARCH_ROWS);
    expect(result.truncated).toBe(true);
    expect(result.appliedLimit).toBe(REPLICA_DEFAULT_SEARCH_ROWS);
    store.close();
  });

  test("a page under the cap is not truncated", () => {
    const store = openSearch(7);
    const result = store.search({
      shapeId: SHAPE.shapeId,
      entity: "knowledge.annotation",
      query: "lease",
    });
    expect(result.rows).toHaveLength(7);
    expect(result.truncated).toBeUndefined();
    expect(result.appliedLimit).toBeUndefined();
    store.close();
  });

  test("a set of exactly the cap fills the window without hiding a hit", () => {
    const store = openSearch(REPLICA_DEFAULT_SEARCH_ROWS);
    const result = store.search({
      shapeId: SHAPE.shapeId,
      entity: "knowledge.annotation",
      query: "lease",
    });
    expect(result.rows).toHaveLength(REPLICA_DEFAULT_SEARCH_ROWS);
    expect(result.truncated).toBeUndefined();
    store.close();
  });

  test("an explicit window that fills reports that window, not the default", () => {
    const store = openSearch(30);
    const result = store.search({
      shapeId: SHAPE.shapeId,
      entity: "knowledge.annotation",
      query: "lease",
      limit: 10,
    });
    expect(result.rows).toHaveLength(10);
    expect(result.truncated).toBe(true);
    expect(result.appliedLimit).toBe(10);
    store.close();
  });
});
