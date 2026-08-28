// Home cold start (#880). The springboard fires nine reads the moment the app
// opens, three of them "the newest N". Before the mounted reader could page an
// ordered read inside SQLite, each of those three selected every row of its
// entity out of every attached vault and sorted 50,000 payloads in JavaScript
// to show twelve — the `limit` bounded the answer and nothing else.
//
// These tests hold the tile reads against the real reader over a four-scope
// fixture and read the SQL back off the driver. What they pin is not "the
// numbers are small" but the SHAPE of the work: a per-scope `ORDER BY … LIMIT`
// on the ordered tiles, a pushed `IN` predicate on the body lookups, and a row
// count that tracks the page rather than the library.
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

/** The canonical page statement: the only read that carries an `ORDER BY`. */
function pagedRead(driver: RecordingDriver): { sql: string; rows: number } {
  const paged = driver.reads.filter((read) =>
    read.sql.includes("ORDER BY json_extract")
  );
  expect(paged).toHaveLength(1);
  return paged[0]!;
}

function rowReads(driver: RecordingDriver): Array<{
  sql: string;
  rows: number;
}> {
  return driver.reads.filter((read) =>
    read.sql.includes("r.payload_json, r.oversized_json")
  );
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

    // Proof first: the reader refuses an ordered page unless one aggregate
    // pass shows the order column type-uniform and disclosed everywhere.
    expect(
      driver.reads.some((read) => read.sql.includes("AS order_withheld"))
    ).toBe(true);
    const paged = pagedRead(driver);
    expect(paged.sql).toContain(
      `ORDER BY json_extract(r.payload_json, '$.${tile.column}') DESC`
    );
    // Per SCOPE, not across the union: one wrapped arm per attached vault.
    expect(paged.sql.match(/LIMIT \?/gu)).toHaveLength(SCOPES.length);
    expect(paged.rows).toBe(tile.limit * SCOPES.length);

    expect(page.rows).toHaveLength(tile.limit);
    // Four scopes share one day sequence, so the global newest `limit` rows
    // are exactly the newest `limit / 4` days of all four.
    const oldest = page.rows
      .map((row) => String(row.values[tile.column]))
      .sort()[0];
    expect(oldest).toBe(stamp(DAYS - tile.limit / SCOPES.length));
    reader.close();
  });

  test("an unordered tile read is still one bounded page per scope", async () => {
    const { driver, reader } = household();

    const page = await reader.read("tasks", HOME_TILE_READS.tasks);

    const rows = rowReads(driver);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sql.match(/LIMIT \?/gu)).toHaveLength(SCOPES.length);
    expect(rows[0]!.rows).toBe(HOME_TILE_LIMITS.tasks * SCOPES.length);
    expect(page.rows).toHaveLength(HOME_TILE_LIMITS.tasks);
    reader.close();
  });

  // `core.content_item` carries `sha256`, so the reader may NOT page it across
  // scopes — a per-scope page could drop the duplicate that supplies a source
  // badge. The body lookup is bounded by its pushed predicate instead, which
  // is why the tiles fetch bodies by id rather than ordering this entity.
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

    const rows = rowReads(driver);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sql).toContain(
      "json_extract(r.payload_json, '$.content_id')"
    );
    expect(rows[0]!.sql).not.toContain("LIMIT ?");
    // One scope holds these ids; the other three answer with nothing. The
    // whole entity is 2,000 rows.
    expect(rows[0]!.rows).toBe(ids.length);
    expect(page.rows).toHaveLength(ids.length);
    reader.close();
  });
});
