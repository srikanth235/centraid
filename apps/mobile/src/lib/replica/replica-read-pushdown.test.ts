import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import {
  OnlineOnlyError,
  ReplicaSqliteStore,
} from "@centraid/client/replica/native";
import type { ReplicaBindValue } from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { MultiVaultReplicaReader } from "./multi-vault-reader";
import { NodeSqliteDriver } from "./node-sqlite-driver";
import { planReplicaRead } from "./replica-read-pushdown";

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
  size: number;
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
      role: "admin" as const,
      databaseName: file.databaseName,
    }))
  );
  return { reader, driver };
}

describe(planReplicaRead, () => {
  test("pages each scope only when dedupe cannot merge rows across scopes", () => {
    const request = { limit: 25 };
    expect(
      planReplicaRead({ request, contentHashed: false, scopeCount: 4 })
        .perScopeLimit
    ).toBe(25);
    // A shape with a content hash merges equal bytes into one badged row, so a
    // per-scope page could drop the badge its duplicate supplies.
    expect(
      planReplicaRead({ request, contentHashed: true, scopeCount: 4 })
        .perScopeLimit
    ).toBeUndefined();
    expect(
      planReplicaRead({ request, contentHashed: true, scopeCount: 1 })
        .perScopeLimit
    ).toBe(25);
  });

  test("refuses to page when a clause or an order stays in JavaScript", () => {
    expect(
      planReplicaRead({
        request: {
          limit: 25,
          where: [{ column: "created_at", op: "within-days", value: 30 }],
        },
        contentHashed: false,
        scopeCount: 1,
      }).perScopeLimit
    ).toBeUndefined();
    expect(
      planReplicaRead({
        request: { limit: 25, orderBy: { column: "created_at", dir: "desc" } },
        contentHashed: false,
        scopeCount: 1,
      }).perScopeLimit
    ).toBeUndefined();
  });
});

describe("mounted reads with pushdown", () => {
  test("an equality filter answers from SQL instead of parsing every row", async () => {
    const root = tempDirSync("centraid-pushdown-");
    const personal = path.join(root, "personal.db");
    seed(personal, "personal", documentSeeds("personal", 500));
    const { reader, driver } = mount(root, [
      { vaultId: "personal", databaseName: personal },
    ]);

    const filtered = await reader.read("docs", {
      entity: "core.document",
      where: [{ column: "title", op: "eq", value: "Household plan" }],
      limit: 100,
    });

    expect(filtered.rows.map((row) => row.values.document_id)).toStrictEqual([
      "personal-0",
    ]);
    // One shape-metadata row plus the single matching document.
    expect(driver.rowsReturned).toBeLessThan(5);
    reader.close();
  });

  test("an `in` filter and a numeric comparison keep the evaluator's answer", async () => {
    const root = tempDirSync("centraid-pushdown-in-");
    const personal = path.join(root, "personal.db");
    seed(personal, "personal", documentSeeds("personal", 50));
    const { reader } = mount(root, [
      { vaultId: "personal", databaseName: personal },
    ]);

    const chosen = await reader.read("docs", {
      entity: "core.document",
      where: [
        {
          column: "document_id",
          op: "in",
          value: ["personal-3", "personal-7"],
        },
      ],
      limit: 100,
    });
    expect(chosen.rows.map((row) => row.values.document_id)).toStrictEqual([
      "personal-3",
      "personal-7",
    ]);

    const large = await reader.read("docs", {
      entity: "core.document",
      where: [{ column: "size", op: "gte", value: 47 }],
      limit: 100,
    });
    expect(large.rows.map((row) => row.values.size)).toStrictEqual([
      47, 48, 49,
    ]);
    reader.close();
  });

  test("a mixed-type column still goes online instead of being filtered away", async () => {
    const root = tempDirSync("centraid-pushdown-mixed-");
    const personal = path.join(root, "personal.db");
    seed(personal, "personal", [
      ...documentSeeds("personal", 3),
      {
        document_id: "personal-numeric",
        title: 42,
        size: 3,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { reader } = mount(root, [
      { vaultId: "personal", databaseName: personal },
    ]);

    await expect(
      reader.read("docs", {
        entity: "core.document",
        where: [{ column: "title", op: "gt", value: "A" }],
        limit: 100,
      })
    ).rejects.toBeInstanceOf(OnlineOnlyError);
    reader.close();
  });

  test("a field dropped for size still escalates rather than silently missing", async () => {
    const root = tempDirSync("centraid-pushdown-oversized-");
    const personal = path.join(root, "personal.db");
    seed(personal, "personal", documentSeeds("personal", 5), {
      oversizedTitleOn: "personal-4",
    });
    const { reader } = mount(root, [
      { vaultId: "personal", databaseName: personal },
    ]);

    await expect(
      reader.read("docs", {
        entity: "core.document",
        where: [{ column: "title", op: "eq", value: "Household plan" }],
        limit: 100,
      })
    ).rejects.toBeInstanceOf(OnlineOnlyError);
    reader.close();
  });

  test("equal bytes in two vaults keep both source badges", async () => {
    const root = tempDirSync("centraid-pushdown-badges-");
    const personal = path.join(root, "personal.db");
    const family = path.join(root, "family.db");
    seed(personal, "personal", documentSeeds("personal", 5));
    seed(family, "family", documentSeeds("family", 5));
    const { reader } = mount(root, [
      { vaultId: "personal", databaseName: personal },
      { vaultId: "family", databaseName: family },
    ]);

    const contents = await reader.read("docs", {
      entity: "core.content_item",
      limit: 1,
    });
    expect(contents.rows).toHaveLength(1);
    expect(contents.rows[0]!.values.__centraidScopeIds).toStrictEqual([
      "personal",
      "family",
    ]);
    reader.close();
  });
});
