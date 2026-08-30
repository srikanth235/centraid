import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  OnlineOnlyError,
  ReplicaSqliteStore,
} from "@centraid/client/replica/native";
import type { ReplicaBindValue } from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { MOUNTED_READ_FALLBACKS } from "./mounted-read-scoping";
import { MultiVaultReplicaReader } from "./multi-vault-reader";
import { NodeSqliteDriver } from "./node-sqlite-driver";

const SHAPES = [
  {
    shapeId: "docs-default",
    appId: "docs",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "core.document",
        primaryKey: "document_id",
        columns: ["document_id", "title", "size", "created_at"],
      },
      {
        entity: "core.content_item",
        primaryKey: "content_id",
        columns: ["content_id", "title", "sha256"],
      },
    ],
  },
];

interface DocumentSeed {
  document_id: string;
  title: string | number;
  size: number | null;
  created_at: string;
}

/** Count what actually crosses the driver, which is what pushdown is about. */
class CountingDriver extends NodeSqliteDriver {
  rowsReturned = 0;

  override async allAsync<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): Promise<T[]> {
    const rows = await super.allAsync<T>(sql, bind);
    this.rowsReturned += rows.length;
    return rows;
  }
}

function seed(
  file: string,
  vaultId: string,
  documents: readonly DocumentSeed[],
  options: { oversizedTitleOn?: string } = {}
): void {
  const store = new ReplicaSqliteStore(new NodeSqliteDriver(file), vaultId);
  store.bootstrap({
    protocolVersion: 1,
    vaultId,
    schemaEpoch: "1",
    cursor: { epoch: `epoch-${vaultId}`, seq: documents.length },
    shapes: SHAPES.map((shape) => ({
      ...shape,
      entities: shape.entities.map((entity) => ({
        ...entity,
        columns: [...entity.columns],
      })),
    })),
    rows: [
      {
        shapeId: "docs-default",
        entity: "core.content_item",
        rowId: `content-${vaultId}`,
        values: {
          content_id: `content-${vaultId}`,
          title: "Shared bytes",
          sha256: "identical-bytes",
        },
      },
    ],
  });
  store.close();

  const database = new DatabaseSync(file);
  const insert = database.prepare(
    `INSERT INTO replica_row
       (shape_id, entity, row_id, payload_json, oversized_json)
     VALUES ('docs-default', 'core.document', ?, ?, ?)`
  );
  database.exec("BEGIN IMMEDIATE");
  for (const document of documents) {
    insert.run(
      document.document_id,
      JSON.stringify(document),
      options.oversizedTitleOn === document.document_id ? '["title"]' : "[]"
    );
  }
  database.exec("COMMIT");
  database.close();
}

function documentSeeds(vaultId: string, count: number): DocumentSeed[] {
  return Array.from({ length: count }, (_, index) => ({
    document_id: `${vaultId}-${index}`,
    title: index === 0 ? "Household plan" : `Archive ${index}`,
    size: index,
    created_at: `2026-01-0${(index % 9) + 1}T00:00:00.000Z`,
  }));
}

function mount(
  root: string,
  files: ReadonlyArray<{ vaultId: string; databaseName: string }>
): { reader: MultiVaultReplicaReader; driver: CountingDriver } {
  const driver = new CountingDriver(path.join(root, "mounted.db"));
  const reader = new MultiVaultReplicaReader(
    driver,
    files.map((file) => ({
      vaultId: file.vaultId,
      label: file.vaultId,
      canWrite: true as const,
      databaseName: file.databaseName,
    }))
  );
  return { reader, driver };
}

/**
 * The mounted reader answers from ONE composed plan (#883 D1): the shared read
 * grammar's compiler, unioned over every attached vault database. These are the
 * seams that plan cannot reach into SQL, and what the phone does at each.
 */
describe("the composed mounted plan", () => {
  test("a badge equality chooses vaults instead of filtering rows", async () => {
    const root = tempDirSync("centraid-mounted-provenance-");
    const personal = path.join(root, "personal.db");
    const family = path.join(root, "family.db");
    seed(personal, "personal", documentSeeds("personal", 4));
    seed(family, "family", documentSeeds("family", 4));
    const { reader } = mount(root, [
      { vaultId: "personal", databaseName: personal },
      { vaultId: "family", databaseName: family },
    ]);

    // `__centraidScopeId` is composed onto the envelope AFTER SQL runs, so a
    // pushed predicate would read NULL for every row. It is constant per
    // database, so the answer is which databases join the union at all.
    const family_only = await reader.read("docs", {
      entity: "core.document",
      where: [{ column: "__centraidScopeId", op: "eq", value: "family" }],
      limit: 100,
    });
    expect(
      new Set(family_only.rows.map((row) => row.values.__centraidScopeId))
    ).toStrictEqual(new Set(["family"]));
    expect(family_only.rows).toHaveLength(4);

    const neither = await reader.read("docs", {
      entity: "core.document",
      where: [{ column: "__centraidScopeId", op: "eq", value: "absent" }],
      limit: 100,
    });
    expect(neither.rows).toHaveLength(0);
    reader.close();
  });

  test("ordering or comparing a badge escalates instead of guessing", async () => {
    const root = tempDirSync("centraid-mounted-provenance-order-");
    const personal = path.join(root, "personal.db");
    seed(personal, "personal", documentSeeds("personal", 4));
    const { reader } = mount(root, [
      { vaultId: "personal", databaseName: personal },
    ]);

    await expect(
      reader.read("docs", {
        entity: "core.document",
        orderBy: { column: "__centraidScopeLabel", dir: "asc" },
        limit: 10,
      })
    ).rejects.toBeInstanceOf(OnlineOnlyError);
    await expect(
      reader.read("docs", {
        entity: "core.document",
        where: [{ column: "__centraidScopeId", op: "gt", value: "a" }],
        limit: 10,
      })
    ).rejects.toBeInstanceOf(OnlineOnlyError);
    reader.close();
  });

  test("the four shapes it cannot carry are the four it names", () => {
    // A fifth entry means the composed plan grew a hole; a missing one means a
    // shape stopped being reported. Both are worth failing a test over.
    expect(Object.keys(MOUNTED_READ_FALLBACKS).sort()).toStrictEqual([
      "content-hash-badges",
      "dedupe-collapse",
      "provenance-comparison",
      "provenance-order",
    ]);
  });

  test("a read that cost what it returned says nothing; a degraded one says why", async () => {
    const root = tempDirSync("centraid-mounted-degraded-");
    const personal = path.join(root, "personal.db");
    const family = path.join(root, "family.db");
    seed(personal, "personal", documentSeeds("personal", 4));
    seed(family, "family", documentSeeds("family", 4));
    const { reader } = mount(root, [
      { vaultId: "personal", databaseName: personal },
      { vaultId: "family", databaseName: family },
    ]);

    const bounded = await reader.read("docs", {
      entity: "core.document",
      orderBy: { column: "created_at", dir: "desc" },
      limit: 3,
    });
    expect(bounded.degraded).toBeUndefined();

    // `core.content_item` carries `sha256`, so equal bytes in two vaults
    // collapse into one badged row after the statement. The limit is therefore
    // not pushed — and the read SAYS so rather than quietly costing the set.
    const badged = await reader.read("docs", {
      entity: "core.content_item",
      limit: 1,
    });
    expect(badged.degraded).toStrictEqual([
      {
        fallback: "content-hash-badges",
        reason: MOUNTED_READ_FALLBACKS["content-hash-badges"],
      },
    ]);
    reader.close();
  });
});
