/**
 * THE PARITY HARNESS: one corpus, two engines, one comparison (#883 C3). The
 * oracle is the real `evaluateReplicaRead`, fed the whole entity in `row_id`
 * order — the pre-pushdown read exactly; it survives only for this comparison.
 */
import { NodeSqliteDriver } from "./node-sqlite-test-driver.js";
import { evaluateReplicaRead } from "./query.js";
import { ReplicaSqliteStore } from "./store-core.js";
import { REPLICA_PROTOCOL_VERSION } from "./types.js";
import type {
  OptimisticMutation,
  ReplicaEntitySchema,
  ReplicaReadRequest,
  ReplicaRowEnvelope,
  ReplicaShape,
  ReplicaSnapshot,
  ReplicaSnapshotRow,
} from "./types.js";

/** Parity is a property of the grammar, not of the row count. */
export const PARITY_ROWS = 2000;
export const PARITY_IN_IDS = 200;
export const NOW = new Date("2026-08-28T12:00:00.000Z");

export type Outcome =
  | { kind: "rows"; rows: ReplicaRowEnvelope[] }
  | { kind: "threw"; name: string; message: string };

export function outcome(run: () => ReplicaRowEnvelope[]): Outcome {
  try {
    return { kind: "rows", rows: run() };
  } catch (error) {
    const thrown = error as Error;
    return { kind: "threw", name: thrown.name, message: thrown.message };
  }
}

export function evaluated(
  rows: readonly ReplicaSnapshotRow[],
  schema: ReplicaEntitySchema,
  request: ReplicaReadRequest,
  mutations: OptimisticMutation[]
): Outcome {
  const canonical = [...rows]
    .sort((left, right) => (left.rowId < right.rowId ? -1 : 1))
    .map((row) => ({
      rowId: row.rowId,
      values: row.values,
      oversizedFields: row.oversizedFields ?? [],
      hasUnavailableFields: schema.hasUnavailableFields === true,
      ...(row.rowVersion === undefined ? {} : { rowVersion: row.rowVersion }),
    }));
  return outcome(() =>
    evaluateReplicaRead(canonical, schema, request, mutations, NOW)
  );
}

export interface Fixture {
  store: ReplicaSqliteStore;
  /** For the sabotage proof below. */
  driver: NodeSqliteDriver;
  schema: ReplicaEntitySchema;
  both: (
    request: ReplicaReadRequest,
    mutations?: OptimisticMutation[]
  ) => { pushed: Outcome; oracle: Outcome };
}

export function openFixture(snapshot: ReplicaSnapshot): Fixture {
  const driver = new NodeSqliteDriver();
  const store = new ReplicaSqliteStore(driver, snapshot.vaultId);
  store.bootstrap(snapshot);
  const schema = snapshot.shapes[0]!.entities[0]!;
  return {
    store,
    driver,
    schema,
    both: (request, mutations = []) => ({
      pushed: outcome(() => store.read(request, mutations, NOW).rows),
      oracle: evaluated(snapshot.rows, schema, request, mutations),
    }),
  };
}

export function rowIds(result: Outcome): string[] {
  if (result.kind !== "rows")
    throw new Error(`expected rows, got ${result.name}`);
  return result.rows.map((row) => row.rowId);
}

export function adversarialSnapshot(): ReplicaSnapshot {
  const shape: ReplicaShape = {
    shapeId: "shape-adversarial",
    appId: "parity",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "core.item",
        primaryKey: "item_id",
        columns: [
          "item_id",
          "label",
          "rank",
          "flag",
          "captured_at",
          "structured",
          "sparse",
          "mixed",
        ],
      },
    ],
  };
  const row = (
    rowId: string,
    values: ReplicaSnapshotRow["values"]
  ): ReplicaSnapshotRow => ({
    shapeId: shape.shapeId,
    entity: "core.item",
    rowId,
    values: { item_id: rowId, ...values },
  });
  return {
    protocolVersion: REPLICA_PROTOCOL_VERSION,
    vaultId: "vault-adversarial",
    schemaEpoch: "schema-1",
    cursor: { epoch: "replica-1", seq: 1 },
    shapes: [shape],
    rows: [
      // JSON null, ABSENT, and present are three different things.
      row("a-null", { label: null, rank: 1, captured_at: null }),
      row("b-absent", { rank: 2 }),
      row("c-plain", { label: "plain", rank: 3, flag: true, sparse: "here" }),
      // Case folding and an astral pair: where UTF-8 BINARY order diverges.
      row("d-upper", { label: "Alpha", rank: 4 }),
      row("e-lower", { label: "alpha", rank: 5 }),
      row("f-astral", { label: "\u{10000}", rank: 6 }),
      row("g-private", { label: "", rank: 7 }),
      row("h-emoji", { label: "\u{1F600}️", rank: 8 }),
      // Ties the exposed primary key must break.
      row("i-tied", { label: "tied", rank: 3 }),
      row("j-tied", { label: "tied", rank: 3 }),
      // Canonical and non-canonical stamps.
      row("k-stamped", { captured_at: "2026-08-27T00:00:00.000Z", rank: 9 }),
      row("l-loose", { captured_at: "2026-08-27T00:00:00Z", rank: 10 }),
      // Structured values, which `scalar()` refuses.
      row("m-object", { structured: { nested: 1 }, rank: 11 }),
      row("n-array", { structured: [1, 2], rank: 12 }),
      // Booleans and reals beside integers.
      row("o-real", { rank: 3.5, flag: false }),
      // ONE column carrying both comparison classes.
      row("p-mixed-text", { mixed: "seven", rank: 13 }),
      row("q-mixed-number", { mixed: 7, rank: 14 }),
    ],
  };
}
