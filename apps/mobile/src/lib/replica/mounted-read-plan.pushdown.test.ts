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
import type { NativeChangeFeed } from "./native-session";
import { createNativeReplicaSession } from "./native-session";
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

interface ContentSeed {
  content_id: string;
  title: string;
  sha256: string;
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

function seedContentItems(file: string, items: readonly ContentSeed[]): void {
  const database = new DatabaseSync(file);
  const insert = database.prepare(
    `INSERT INTO replica_row
       (shape_id, entity, row_id, payload_json, oversized_json)
     VALUES ('docs-default', 'core.content_item', ?, ?, '[]')`
  );
  database.exec("BEGIN IMMEDIATE");
  for (const item of items) insert.run(item.content_id, JSON.stringify(item));
  database.exec("COMMIT");
  database.close();
}

/** Scripts whose UTF-8 bytes order differently from their code points. */
const TITLES = ["Doc", "Éclair", "école", "日記", "Zebra"];

/**
 * Ties on every ordered column, holes where the evaluator sorts nulls, and the
 * same shape in two vaults: the fixture a per-scope page can only survive by
 * paging on the evaluator's own total key, under its own BINARY collation.
 */
function orderedSeeds(vaultId: string, count: number): DocumentSeed[] {
  return Array.from({ length: count }, (_, index) => ({
    document_id: `${vaultId}-${String(index).padStart(3, "0")}`,
    title: `${TITLES[index % TITLES.length]!} ${String(index).padStart(3, "0")}`,
    size: index % 5 === 0 ? null : index % 7,
    created_at: `2026-01-0${(index % 9) + 1}T00:00:00.000Z`,
  }));
}

function documentSeeds(vaultId: string, count: number): DocumentSeed[] {
  return Array.from({ length: count }, (_, index) => ({
    document_id: `${vaultId}-${index}`,
    title: index === 0 ? "Household plan" : `Archive ${index}`,
    size: index,
    created_at: `2026-01-0${(index % 9) + 1}T00:00:00.000Z`,
  }));
}

async function enqueueOfflineRename(
  file: string,
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
      vaultId: "personal",
    },
    fetcher: () => Promise.reject(new Error("pushdown test stays offline")),
    changeFeed,
    driver: new NodeSqliteDriver(file),
    isConnected: () => false,
    digest: () => Promise.resolve("rename-digest"),
    idFactory: () => "intent-rename",
  });
  await session.write("docs", {
    action: "rename",
    input: { document_id: documentId, title },
  });
  await session.close();
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

  test("an overlay adds only its addressed canonical row to a pushed page", async () => {
    const root = tempDirSync("centraid-pushdown-overlay-");
    const personal = path.join(root, "personal.db");
    seed(personal, "personal", documentSeeds("personal", 500));
    await enqueueOfflineRename(personal, "personal-499", "Household plan");
    const { reader, driver } = mount(root, [
      { vaultId: "personal", databaseName: personal },
    ]);

    const filtered = await reader.read("docs", {
      entity: "core.document",
      where: [{ column: "title", op: "eq", value: "Household plan" }],
      limit: 100,
    });

    expect(
      filtered.rows
        .map((row) => row.values.document_id)
        .sort((left, right) => String(left).localeCompare(String(right)))
    ).toStrictEqual(["personal-0", "personal-499"]);
    // Metadata, one pushed canonical hit, and one mutation-addressed base cross
    // the driver. The other 498 vault rows remain inside SQLite.
    expect(driver.rowsReturned).toBeLessThan(12);
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

  test("a page that dedupe collapses is re-read whole, not answered short", async () => {
    const root = tempDirSync("centraid-pushdown-saturated-");
    const personal = path.join(root, "personal.db");
    seed(personal, "personal", documentSeeds("personal", 3));
    // `seed` already stored one `identical-bytes` row; four more make the first
    // page of three collapse into a single badged row.
    seedContentItems(personal, [
      ...Array.from({ length: 4 }, (_, index) => ({
        content_id: `same-${index}`,
        title: `Same ${index}`,
        sha256: "identical-bytes",
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        content_id: `unique-${index}`,
        title: `Unique ${index}`,
        sha256: `distinct-${index}`,
      })),
    ]);
    const { reader } = mount(root, [
      { vaultId: "personal", databaseName: personal },
    ]);

    const page = await reader.read("docs", {
      entity: "core.content_item",
      limit: 3,
    });

    expect(page.rows).toHaveLength(3);
    // And it says what the short first page cost it, rather than paying for
    // the whole matching set in silence.
    expect(page.degraded).toStrictEqual([
      {
        fallback: "dedupe-collapse",
        reason: MOUNTED_READ_FALLBACKS["dedupe-collapse"],
      },
    ]);
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

describe("ordered mounted reads with pushdown", () => {
  test("a paged ordered read answers exactly what the whole-entity evaluator answers", async () => {
    const root = tempDirSync("centraid-pushdown-order-");
    const personal = path.join(root, "personal.db");
    const family = path.join(root, "family.db");
    seed(personal, "personal", orderedSeeds("personal", 40));
    seed(family, "family", orderedSeeds("family", 40));
    const { reader } = mount(root, [
      { vaultId: "personal", databaseName: personal },
      { vaultId: "family", databaseName: family },
    ]);

    const orders = [
      { column: "size", dir: "asc" as const },
      { column: "size", dir: "desc" as const },
      { column: "created_at", dir: "desc" as const },
      { column: "title", dir: "asc" as const },
    ];
    const compared = await Promise.all(
      orders.map(async (orderBy) => {
        // Both vaults hold fewer rows than the grammar's default page, so
        // the unlimited read is the whole merged answer.
        const [whole, paged] = await Promise.all([
          reader.read("docs", { entity: "core.document", orderBy }),
          reader.read("docs", { entity: "core.document", orderBy, limit: 7 }),
        ]);
        return {
          orderBy,
          whole: whole.rows.length,
          paged: paged.rows.map((row) => row.rowId),
          expected: whole.rows.slice(0, 7).map((row) => row.rowId),
        };
      })
    );

    for (const outcome of compared) {
      expect(outcome.whole).toBe(80);
      expect({ order: outcome.orderBy, rows: outcome.paged }).toStrictEqual({
        order: outcome.orderBy,
        rows: outcome.expected,
      });
    }
    reader.close();
  });

  test("an ordered page crosses the driver as a page, not as the whole entity", async () => {
    const root = tempDirSync("centraid-pushdown-order-cost-");
    const personal = path.join(root, "personal.db");
    seed(personal, "personal", orderedSeeds("personal", 500));
    const { reader, driver } = mount(root, [
      { vaultId: "personal", databaseName: personal },
    ]);

    const recent = await reader.read("docs", {
      entity: "core.document",
      orderBy: { column: "created_at", dir: "desc" },
      limit: 10,
    });

    expect(recent.rows).toHaveLength(10);
    // Shape metadata, one aggregate probe verdict, and the ten-row page. The
    // other 490 documents are ordered and dropped inside SQLite.
    expect(driver.rowsReturned).toBeLessThan(20);
    reader.close();
  });

  test("a paged ordered read cannot page past the row the evaluator escalates on", async () => {
    const root = tempDirSync("centraid-pushdown-order-mixed-");
    const personal = path.join(root, "personal.db");
    seed(personal, "personal", [
      ...documentSeeds("personal", 6),
      {
        document_id: "personal-numeric",
        title: 42,
        size: 6,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const { reader } = mount(root, [
      { vaultId: "personal", databaseName: personal },
    ]);

    // SQLite sorts a numeric title below every text one, so a DESC page of two
    // would leave it behind and quietly answer a question the evaluator refuses.
    await expect(
      reader.read("docs", {
        entity: "core.document",
        orderBy: { column: "title", dir: "desc" },
        limit: 2,
      })
    ).rejects.toBeInstanceOf(OnlineOnlyError);
    reader.close();
  });

  test("a paged ordered read still escalates on a field dropped for size", async () => {
    const root = tempDirSync("centraid-pushdown-order-oversized-");
    const personal = path.join(root, "personal.db");
    seed(personal, "personal", documentSeeds("personal", 6), {
      oversizedTitleOn: "personal-5",
    });
    const { reader } = mount(root, [
      { vaultId: "personal", databaseName: personal },
    ]);

    // `personal-5` sorts outside an ASC page of two; the order column has to be
    // disclosed on every row of the set, not merely on the page.
    await expect(
      reader.read("docs", {
        entity: "core.document",
        orderBy: { column: "title", dir: "asc" },
        limit: 2,
      })
    ).rejects.toBeInstanceOf(OnlineOnlyError);
    reader.close();
  });

  test("an ordered page of a content-hashed entity keeps every source badge", async () => {
    const root = tempDirSync("centraid-pushdown-order-badges-");
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
      orderBy: { column: "title", dir: "asc" },
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
