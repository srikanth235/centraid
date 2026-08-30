/*
 * GOLDEN PARITY FOR THE MOUNTED READ, across SEVERAL vaults (#883). The
 * composed plan moves the cross-vault merge into SQLite's own collation, so
 * what is shown is that the MERGE did not change: same rows, same order, over
 * three vaults with colliding order keys, nulls in the ordered column, a
 * read-only source and a pending offline write.
 *
 * THE ORACLE IS THE REAL ENGINE, never a transcription: the expectation comes
 * from `evaluateReplicaRead` over per-vault rows composed, badged and deduped
 * exactly as the reader hands them. The six ruled divergences are asserted in
 * the client suite, not here.
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  applyOptimisticMutations,
  evaluateReplicaRead,
  presentPendingIntentMutation,
  ReplicaSqliteStore,
} from "@centraid/client/replica/native";
import type {
  OptimisticMutation,
  ReplicaEntitySchema,
  ReplicaIntent,
  ReplicaRowEnvelope,
} from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  dedupeReplicaRowsByContent,
  replicaScopeEnvelope,
  storedReplicaEnvelope,
} from "./multi-vault-provenance";
import { MultiVaultReplicaReader } from "./multi-vault-reader";
import type { MountedReplicaScope } from "./multi-vault-reader";
import type { NativeChangeFeed, NativeReadRequest } from "./native-session";
import { createNativeReplicaSession } from "./native-session";
import { NodeSqliteDriver } from "./node-sqlite-driver";

const SHAPE_ID = "docs-default";
const ENTITY = "core.document";
const APP_ID = "docs";
const COLUMNS = ["document_id", "title", "size", "created_at", "archived_at"];

const SCHEMA: ReplicaEntitySchema = {
  entity: ENTITY,
  primaryKey: "document_id",
  columns: COLUMNS,
};

/** Two writable, one shared read-only. */
const VAULTS = [
  { vaultId: "personal", label: "Personal", canWrite: true },
  { vaultId: "family", label: "Family", canWrite: true },
  { vaultId: "school", label: "School", canWrite: false },
] as const;

/** UTF-8 bytes ordering differently from UTF-16 units: BINARY, not `localeCompare`. */
const TITLES = ["Doc", "Éclair", "école", "日記", "Zebra", "𝟙 unit"];

interface DocumentSeed {
  document_id: string;
  title: string;
  size: number | null;
  created_at: string;
  archived_at: string | null;
}

/** Deliberately COLLIDING, so the primary-key tie-break has to decide. */
function seeds(vaultId: string, count: number): DocumentSeed[] {
  return Array.from({ length: count }, (_unused, index) => ({
    document_id: `${vaultId}-${String(index).padStart(3, "0")}`,
    title: TITLES[index % TITLES.length]!,
    // Nulls land where the evaluator sorts absent values first ASC.
    size: index % 4 === 0 ? null : index % 6,
    created_at: `2026-01-0${(index % 9) + 1}T0${index % 8}:00:00.000Z`,
    archived_at: index % 5 === 0 ? "2026-02-01T00:00:00.000Z" : null,
  }));
}

function seedVault(file: string, vaultId: string, rows: DocumentSeed[]): void {
  const store = new ReplicaSqliteStore(new NodeSqliteDriver(file), vaultId);
  store.bootstrap({
    protocolVersion: 1,
    vaultId,
    schemaEpoch: "1",
    cursor: { epoch: `epoch-${vaultId}`, seq: rows.length },
    shapes: [
      {
        shapeId: SHAPE_ID,
        appId: APP_ID,
        purpose: "dpv:ServiceProvision",
        entities: [
          { entity: ENTITY, primaryKey: "document_id", columns: [...COLUMNS] },
        ],
      },
    ],
    rows: [],
  });
  store.close();

  const database = new DatabaseSync(file);
  const insert = database.prepare(
    `INSERT INTO replica_row (shape_id, entity, row_id, payload_json, oversized_json)
     VALUES (?, ?, ?, ?, '[]')`
  );
  database.exec("BEGIN IMMEDIATE");
  for (const row of rows)
    insert.run(SHAPE_ID, ENTITY, row.document_id, JSON.stringify(row));
  database.exec("COMMIT");
  database.close();
}

/** One durable offline write, so the overlay is covered too. */
async function queueOfflineRename(
  file: string,
  vaultId: string,
  documentId: string,
  title: string
): Promise<void> {
  const changeFeed: NativeChangeFeed = {
    subscribe: () => () => undefined,
    setShapeIds: () => Promise.resolve(),
    resume: () => Promise.resolve(),
    setActive: () => undefined,
  };
  const session = await createNativeReplicaSession({
    gatewayAuth: {
      baseUrl: "http://127.0.0.1:1",
      gatewayId: "offline-gateway",
      vaultId,
    },
    fetcher: () =>
      Promise.reject(new Error("the parity fixture stays offline")),
    changeFeed,
    driver: new NodeSqliteDriver(file),
    isConnected: () => false,
    digest: () => Promise.resolve(`digest-${documentId}`),
    idFactory: () => `intent-${documentId}`,
  });
  await session.write(APP_ID, {
    action: "rename",
    input: { document_id: documentId, title },
  });
  await session.close();
}

/** The oracle: per-vault rows in `row_id` order, composed, badged, deduped. */
function oracle(
  scopes: readonly MountedReplicaScope[],
  request: NativeReadRequest
): ReplicaRowEnvelope[] {
  const badged: ReplicaRowEnvelope[] = [];
  for (const scope of scopes) {
    const database = new DatabaseSync(scope.databaseName, { readOnly: true });
    const stored = database
      .prepare(
        `SELECT row_id, payload_json, oversized_json, server_version, 0 AS has_unavailable_fields
           FROM replica_row WHERE shape_id = ? AND entity = ? ORDER BY row_id`
      )
      .all(SHAPE_ID, ENTITY) as Array<{
      row_id: string;
      payload_json: string;
      oversized_json: string;
      server_version: number;
      has_unavailable_fields: number;
    }>;
    const hasOutbox =
      (
        database
          .prepare(
            `SELECT 1 AS present FROM sqlite_master
              WHERE type = 'table' AND name = 'replica_intent_outbox'`
          )
          .all() as Array<{ present: number }>
      ).length > 0;
    const intents = (
      hasOutbox
        ? (database
            .prepare(
              `SELECT record_json FROM replica_intent_outbox
                WHERE state <> 'executed' ORDER BY created_order`
            )
            .all() as Array<{ record_json: string }>)
        : []
    ).map((row) => JSON.parse(row.record_json) as ReplicaIntent);
    database.close();
    const mutations: OptimisticMutation[] = intents.flatMap((intent) =>
      intent.optimistic
        .filter(
          (mutation) =>
            mutation.entity === ENTITY && mutation.shapeId === SHAPE_ID
        )
        .map((mutation) => presentPendingIntentMutation(mutation, intent))
    );
    badged.push(
      ...applyOptimisticMutations(
        stored.map((row) => storedReplicaEnvelope(row)),
        mutations,
        SCHEMA
      ).map((row) => replicaScopeEnvelope(scope, row))
    );
  }
  return evaluateReplicaRead(dedupeReplicaRowsByContent(badged), SCHEMA, {
    ...request,
    shapeId: SHAPE_ID,
  });
}

function shapeOf(rows: readonly ReplicaRowEnvelope[]): string[] {
  return rows.map(
    (row) =>
      `${row.rowId}|${String(row.values.title)}|${String(row.values.size)}|${String(row.values.created_at)}`
  );
}

async function household(): Promise<{
  scopes: MountedReplicaScope[];
  mount: (only?: readonly string[]) => MultiVaultReplicaReader;
}> {
  const root = tempDirSync("centraid-mounted-parity-");
  const scopes = VAULTS.map((vault) => ({
    ...vault,
    databaseName: path.join(root, `${vault.vaultId}.db`),
  })) as MountedReplicaScope[];
  const depths = [24, 19, 15];
  scopes.forEach((scope, index) =>
    seedVault(
      scope.databaseName,
      scope.vaultId,
      seeds(scope.vaultId, depths[index]!)
    )
  );
  // A queued rename sits inside the ordered set: the new title re-sorts its row.
  await queueOfflineRename(
    scopes[0]!.databaseName,
    "personal",
    "personal-007",
    "Aardvark"
  );
  return {
    scopes,
    mount: (only) =>
      new MultiVaultReplicaReader(
        new NodeSqliteDriver(
          path.join(root, `mounted-${only?.join("-") ?? "all"}.db`)
        ),
        only ? scopes.filter((scope) => only.includes(scope.vaultId)) : scopes
      ),
  };
}

/** Every shape both engines answer, over the same three vaults. */
const REQUESTS: Array<{ name: string; request: NativeReadRequest }> = [
  { name: "unfiltered page", request: { entity: ENTITY, limit: 10 } },
  { name: "unfiltered whole", request: { entity: ENTITY } },
  {
    name: "ordered by a colliding text key, ascending",
    request: {
      entity: ENTITY,
      orderBy: { column: "title", dir: "asc" },
      limit: 9,
    },
  },
  {
    name: "ordered by a colliding text key, descending",
    request: {
      entity: ENTITY,
      orderBy: { column: "title", dir: "desc" },
      limit: 9,
    },
  },
  {
    name: "ordered by a numeric key with nulls",
    request: {
      entity: ENTITY,
      orderBy: { column: "size", dir: "asc" },
      limit: 12,
    },
  },
  {
    name: "ordered by a timestamp, descending, unlimited",
    request: { entity: ENTITY, orderBy: { column: "created_at", dir: "desc" } },
  },
  {
    name: "ordered by the primary key itself",
    request: {
      entity: ENTITY,
      orderBy: { column: "document_id", dir: "asc" },
      limit: 5,
    },
  },
  {
    name: "an `in` list spanning all three vaults",
    request: {
      entity: ENTITY,
      where: [
        {
          column: "document_id",
          op: "in",
          value: [
            "personal-000",
            "personal-007",
            "family-003",
            "family-018",
            "school-001",
            "school-014",
            "absent-999",
          ],
        },
      ],
      orderBy: { column: "title", dir: "asc" },
      limit: 4,
    },
  },
  {
    name: "an `in` list on the ordered column",
    request: {
      entity: ENTITY,
      where: [
        { column: "title", op: "in", value: ["Éclair", "école", "日記"] },
      ],
      orderBy: { column: "title", dir: "asc" },
      limit: 8,
    },
  },
  {
    name: "a numeric range and a null test",
    request: {
      entity: ENTITY,
      where: [
        { column: "size", op: "gte", value: 2 },
        { column: "archived_at", op: "is-null" },
      ],
      orderBy: { column: "size", dir: "desc" },
      limit: 6,
    },
  },
  {
    name: "not-null with a limit of one",
    request: {
      entity: ENTITY,
      where: [{ column: "archived_at", op: "not-null" }],
      orderBy: { column: "created_at", dir: "asc" },
      limit: 1,
    },
  },
  {
    name: "a day range wide enough to hold the whole fixture",
    request: {
      entity: ENTITY,
      where: [{ column: "created_at", op: "within-days", value: 100_000 }],
      orderBy: { column: "created_at", dir: "desc" },
      limit: 11,
    },
  },
  {
    name: "the queued rename, filtered on the column it changed",
    request: {
      entity: ENTITY,
      where: [{ column: "title", op: "eq", value: "Aardvark" }],
      limit: 5,
    },
  },
];

describe("[golden] the composed mounted plan answers what the evaluator answered", () => {
  test("same rows, same order, over three mounted vaults", async () => {
    const { scopes, mount } = await household();
    const reader = mount();
    try {
      for (const entry of REQUESTS) {
        // Sequential on purpose: each case meets its own oracle run.
        // oxlint-disable-next-line no-await-in-loop
        const answered = await reader.read(APP_ID, entry.request);
        expect({
          case: entry.name,
          rows: shapeOf(answered.rows),
        }).toStrictEqual({
          case: entry.name,
          rows: shapeOf(oracle(scopes, entry.request)),
        });
      }
      // The fixture has to be big enough for a limit to actually cut.
      expect(oracle(scopes, { entity: ENTITY })).toHaveLength(58);
    } finally {
      reader.close();
    }
  });

  // DEMONSTRATED RED: the two ways a cross-vault merge breaks — a source left
  // out of the union, and a comparator that orders it the wrong way.
  test("SABOTAGE: dropping a vault from the merge, or flipping its order, fails parity", async () => {
    const { scopes, mount } = await household();
    const whole = mount();
    const sabotaged = mount(["personal", "family"]);
    try {
      // `size` descending puts rows from all three vaults inside one page, so
      // a vault missing from the union has to change the answer.
      const request: NativeReadRequest = {
        entity: ENTITY,
        orderBy: { column: "size", dir: "desc" },
        limit: 9,
      };
      const expected = shapeOf(oracle(scopes, request));
      expect(shapeOf((await whole.read(APP_ID, request)).rows)).toStrictEqual(
        expected
      );

      // One scope dropped: every assertion above would fail on it.
      const missing = shapeOf((await sabotaged.read(APP_ID, request)).rows);
      expect(missing).toHaveLength(9);
      expect(missing).not.toStrictEqual(expected);
      expect(
        expected.some((row) => row.startsWith("school:")),
        "the dropped vault must actually reach the page, or dropping it proves nothing"
      ).toBe(true);

      // Comparator flipped: the merge key decides the page.
      const flipped = shapeOf(
        (
          await whole.read(APP_ID, {
            ...request,
            orderBy: { column: "size", dir: "asc" },
          })
        ).rows
      );
      expect(flipped).not.toStrictEqual(expected);
    } finally {
      whole.close();
      sabotaged.close();
    }
  });
});
