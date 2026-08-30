// Home cold start (#880, #883 D1). Nine reads fire at open, three of them "the
// newest N". These hold the tile reads against the real reader over a
// four-scope fixture and read the SQL back off the driver, pinning the SHAPE of
// the work: one composed statement per read that orders and limits the union of
// every attached vault, a pushed `IN` on body lookups, and a page that crosses
// the driver at `limit`, not `limit x scopes`.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { ReplicaSqliteStore } from "@centraid/client/replica/native";
import type { ReplicaBindValue } from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { MultiVaultReplicaReader } from "../../lib/replica/multi-vault-reader";
import { NodeSqliteDriver } from "../../lib/replica/node-sqlite-driver";
import {
  HOME_ORDERED_TILE_READS,
  HOME_TILE_LIMITS,
  HOME_TILE_READS,
  idFilter,
} from "./home-tile-reads";

/** Days per scope. Four scopes × one row per day is the whole library. */
const DAYS = 500;
const DAY_MS = 86_400_000;
const SCOPES = ["personal", "family", "school", "club"] as const;

const SHAPES = [
  {
    shapeId: "photos-default",
    appId: "photos",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "media.asset",
        primaryKey: "asset_id",
        columns: [
          "asset_id",
          "content_id",
          "captured_at",
          "favorite",
          "archived_at",
          "deleted_at",
        ],
      },
    ],
  },
  {
    shapeId: "docs-default",
    appId: "docs",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "core.document",
        primaryKey: "document_id",
        columns: [
          "document_id",
          "title",
          "current_content_id",
          "created_at",
          "updated_at",
          "deleted_at",
        ],
      },
      {
        // The content-hashed entity: equal bytes in two vaults collapse into
        // one badged row, so this one is never given a per-scope page.
        entity: "core.content_item",
        primaryKey: "content_id",
        columns: ["content_id", "title", "sha256", "byte_size", "deleted_at"],
      },
    ],
  },
  {
    shapeId: "notes-default",
    appId: "notes",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "knowledge.note",
        primaryKey: "note_id",
        columns: [
          "note_id",
          "title",
          "body_content_id",
          "created_at",
          "updated_at",
          "deleted_at",
        ],
      },
    ],
  },
  {
    shapeId: "tasks-default",
    appId: "tasks",
    purpose: "dpv:ServiceProvision",
    entities: [
      {
        entity: "schedule.task",
        primaryKey: "task_id",
        columns: ["task_id", "title", "status", "completed_at", "deleted_at"],
      },
    ],
  },
] as const;

function stamp(day: number): string {
  return new Date(Date.UTC(2016, 0, 1) + day * DAY_MS).toISOString();
}

/** Record what each read asked SQLite for, and how much it got back. */
class RecordingDriver extends NodeSqliteDriver {
  readonly reads: Array<{ sql: string; rows: number }> = [];

  override async allAsync<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): Promise<T[]> {
    const rows = await super.allAsync<T>(sql, bind);
    this.reads.push({ sql, rows: rows.length });
    return rows;
  }
}

/**
 * One vault's slice of a household library: the same day sequence in every
 * scope, so the global newest page spans all four and the fixed primary-key
 * tie-break is exercised on every tied day.
 */
function seedScope(file: string, vaultId: string): void {
  const store = new ReplicaSqliteStore(new NodeSqliteDriver(file), vaultId);
  store.bootstrap({
    protocolVersion: 1,
    vaultId,
    schemaEpoch: "1",
    cursor: { epoch: `epoch-${vaultId}`, seq: DAYS },
    shapes: SHAPES.map((shape) => ({
      ...shape,
      entities: shape.entities.map((entity) => ({
        ...entity,
        columns: [...entity.columns],
      })),
    })),
    rows: [],
  });
  store.close();

  const database = new DatabaseSync(file);
  const insert = database.prepare(
    `INSERT INTO replica_row
       (shape_id, entity, row_id, payload_json, oversized_json)
     VALUES (?, ?, ?, ?, '[]')`
  );
  database.exec("BEGIN IMMEDIATE");
  for (let day = 0; day < DAYS; day += 1) {
    const suffix = `${vaultId}-${String(day).padStart(4, "0")}`;
    const at = stamp(day);
    insert.run(
      "photos-default",
      "media.asset",
      `asset-${suffix}`,
      JSON.stringify({
        asset_id: `asset-${suffix}`,
        content_id: `content-${suffix}`,
        captured_at: at,
        favorite: 0,
        archived_at: null,
        deleted_at: null,
      })
    );
    insert.run(
      "docs-default",
      "core.document",
      `document-${suffix}`,
      JSON.stringify({
        document_id: `document-${suffix}`,
        title: `Household plan ${day}`,
        current_content_id: `content-${suffix}`,
        created_at: at,
        updated_at: at,
        deleted_at: null,
      })
    );
    insert.run(
      "docs-default",
      "core.content_item",
      `content-${suffix}`,
      JSON.stringify({
        content_id: `content-${suffix}`,
        title: `Household plan ${day}`,
        sha256: `sha-${suffix}`,
        byte_size: 42,
        deleted_at: null,
      })
    );
    insert.run(
      "notes-default",
      "knowledge.note",
      `note-${suffix}`,
      JSON.stringify({
        note_id: `note-${suffix}`,
        title: `Note ${day}`,
        body_content_id: `content-${suffix}`,
        created_at: at,
        updated_at: at,
        deleted_at: null,
      })
    );
    insert.run(
      "tasks-default",
      "schedule.task",
      `task-${suffix}`,
      JSON.stringify({
        task_id: `task-${suffix}`,
        title: `Task ${day}`,
        status: "open",
        completed_at: null,
        deleted_at: null,
      })
    );
  }
  database.exec("COMMIT");
  database.close();
}

interface Household {
  driver: RecordingDriver;
  reader: MultiVaultReplicaReader;
}

function household(): Household {
  const root = tempDirSync("centraid-home-tiles-");
  const scopes = SCOPES.map((vaultId) => ({
    vaultId,
    label: vaultId,
    canWrite: vaultId === "personal",
    databaseName: path.join(root, `${vaultId}.db`),
  }));
  for (const scope of scopes) seedScope(scope.databaseName, scope.vaultId);
  const driver = new RecordingDriver(path.join(root, "mounted.db"));
  return { driver, reader: new MultiVaultReplicaReader(driver, scopes) };
}

/** The composed page: the one statement a read compiles its grammar into. */
function pageReads(driver: RecordingDriver): Array<{
  sql: string;
  rows: number;
}> {
  return driver.reads.filter((read) => read.sql.includes("AS verdict"));
}

function onePage(driver: RecordingDriver): { sql: string; rows: number } {
  const pages = pageReads(driver);
  expect(pages).toHaveLength(1);
  return pages[0]!;
}

describe("Home tile reads", () => {
  const ordered = [
    {
      name: "photos",
      appId: "photos",
      request: HOME_ORDERED_TILE_READS.photos,
      column: "captured_at",
      limit: HOME_TILE_LIMITS.photos,
    },
    {
      name: "documents",
      appId: "docs",
      request: HOME_ORDERED_TILE_READS.documents,
      column: "updated_at",
      limit: HOME_TILE_LIMITS.documents,
    },
    {
      name: "notes",
      appId: "notes",
      request: HOME_ORDERED_TILE_READS.notes,
      column: "updated_at",
      limit: HOME_TILE_LIMITS.notes,
    },
  ];

  test.each(ordered)("the $name tile pages inside SQLite", async (tile) => {
    const { driver, reader } = household();

    const page = await reader.read(tile.appId, tile.request);

    const paged = onePage(driver);
    // Escalating rows lead the page, then the caller's own key.
    expect(paged.sql).toContain(
      `ORDER BY (verdict = 0) ASC, json_extract(payload_json, '$.${tile.column}') DESC`
    );
    // The refusal guards ride the same pass: the order column has to be
    // type-uniform and disclosed across EVERY attached vault, not merely on
    // the page, and that is a window column rather than a second statement.
    expect(paged.sql).toContain("order_oversized");
    expect(paged.sql).toContain("order_straddle");
    // One arm per attached vault, one page across their union.
    expect(paged.sql.match(/UNION ALL/gu)).toHaveLength(SCOPES.length - 1);
    expect(paged.sql.match(/LIMIT \?/gu)).toHaveLength(1);
    // The page is the answer: nothing is fetched only to be discarded.
    expect(paged.rows).toBe(tile.limit);

    expect(page.rows).toHaveLength(tile.limit);
    // Four scopes share one day sequence, so the global newest `limit` rows
    // are exactly the newest `limit / 4` days of all four.
    const oldest = page.rows
      .map((row) => String(row.values[tile.column]))
      .sort()[0];
    expect(oldest).toBe(stamp(DAYS - tile.limit / SCOPES.length));
    reader.close();
  });

  test("an unordered tile read is one bounded page over the union", async () => {
    const { driver, reader } = household();

    const page = await reader.read("tasks", HOME_TILE_READS.tasks);

    const paged = onePage(driver);
    expect(paged.sql.match(/LIMIT \?/gu)).toHaveLength(1);
    expect(paged.rows).toBe(HOME_TILE_LIMITS.tasks);
    expect(page.rows).toHaveLength(HOME_TILE_LIMITS.tasks);
    reader.close();
  });

  // `core.content_item` carries `sha256`, so no limit may be carried into a
  // cross-scope read of it: the collapse runs after the statement and could
  // drop the duplicate supplying a source badge. Tiles fetch bodies by id
  // instead, bounded by the pushed predicate.
  test("the document body lookup costs the ids it asks for", async () => {
    const { driver, reader } = household();
    const ids = Array.from({ length: 12 }, (_, index) =>
      index === 0
        ? `content-personal-0499`
        : `content-personal-${String(499 - index).padStart(4, "0")}`
    );

    const page = await reader.read(
      "docs",
      idFilter("core.content_item", "content_id", ids)
    );

    const paged = onePage(driver);
    expect(paged.sql).toContain("json_extract(payload_json, '$.content_id')");
    // The read still says it could not carry the caller's limit, rather than
    // quietly costing the entity (`mounted-read-scoping.ts`).
    expect(page.degraded?.map((entry) => entry.fallback)).toStrictEqual([
      "content-hash-badges",
    ]);
    // One scope holds these ids; the other three answer with nothing. The
    // whole entity is 2,000 rows.
    expect(paged.rows).toBe(ids.length);
    expect(page.rows).toHaveLength(ids.length);
    reader.close();
  });
});
