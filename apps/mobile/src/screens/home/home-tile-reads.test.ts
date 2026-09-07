// Home cold start (#880, #883 D1, narrowed by #996 wave 3). Nine reads fire at
// open, three of them "the newest N". These hold the tile reads against the
// real store and read the SQL back off the driver, pinning the SHAPE of the
// work: one composed statement per read that orders and limits INSIDE SQLite,
// a pushed `IN` on body lookups, and a page that crosses the driver at
// `limit + 1` — the answer plus the one probe row that makes truncation
// visible.
//
// The union arms are gone with the mount plane. A seat opens ONE file, so
// there is one arm, and the claim that survives is the one that always
// mattered: the tile does not pay for the entity to draw its newest N.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { ReplicaSqliteStore } from "@centraid/client/replica/native";
import type { ReplicaBindValue } from "@centraid/client/replica/native";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { NativeReplicaStore } from "../../lib/replica/native-replica-store";
import { NodeSqliteDriver } from "../../lib/replica/node-sqlite-driver";
import { VaultReadPlane } from "../../lib/replica/vault-read-plane";
import {
  HOME_ORDERED_TILE_READS,
  HOME_TILE_LIMITS,
  HOME_TILE_READS,
  idFilter,
} from "./home-tile-reads";

/** Days in the fixture; one row per day per entity is the whole library. */
// PAST THE LARGEST TILE LIMIT (500). The fixture used to seed 500 days into
// each of four vaults and page across their union, so every tile's window sat
// well inside the library; one open file has to hold that much on its own, or
// a page that ends where the window ends would pass for a page that filled it.
const DAYS = 700;
const DAY_MS = 86_400_000;
const VAULT_ID = "personal";

const SHAPES = [
  {
    shapeId: "photos-default",
    appId: "photos",
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

  // SYNCHRONOUS `all`, not `allAsync`. The mounted reader took the driver's
  // off-thread read; the seat's store is synchronous by construction (#996
  // wave 3 — its whole correctness argument is one transaction per commit),
  // so the statements it issues arrive here.
  override all<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): T[] {
    const rows = super.all<T>(sql, bind);
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
  reader: VaultReadPlane;
}

function household(): Household {
  const root = tempDirSync("centraid-home-tiles-");
  const databaseName = path.join(root, `${VAULT_ID}.db`);
  seedScope(databaseName, VAULT_ID);
  const driver = new RecordingDriver(databaseName);
  return {
    driver,
    reader: new VaultReadPlane(NativeReplicaStore.create(driver, VAULT_ID), {
      vaultId: VAULT_ID,
      label: "Personal",
      canWrite: true,
    }),
  };
}

/** The composed page: the one statement a read compiles its grammar into. */
function pageReads(driver: RecordingDriver): Array<{
  sql: string;
  rows: number;
}> {
  // The ORDER GUARD CENSUS is its own statement since #922 C3, and it also
  // selects over the union; the PAGE is the one that orders and limits.
  return driver.reads.filter(
    (read) => read.sql.includes("AS verdict") && read.sql.includes("LIMIT ?")
  );
}

function censusReads(driver: RecordingDriver): string[] {
  return driver.reads
    .map((read) => read.sql)
    .filter((sql) => sql.includes("order_straddle"));
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
    // The refusal guards ride their OWN statement (#922 C3): as `OVER ()`
    // window columns on this one they forced SQLite to materialize the whole
    // entity before returning a row, so neither the limit nor an index could
    // bound the work.
    expect(paged.sql).not.toContain("OVER ()");
    const census = censusReads(driver);
    expect(census).toHaveLength(1);
    expect(census[0]).toContain("order_oversized");
    expect(census[0]).toContain("order_straddle");
    expect(paged.sql.match(/LIMIT \?/gu)).toHaveLength(1);
    // The page is the answer, plus ONE probe row and no more: the statement
    // over-fetches by exactly one so a filled window can be told apart from a
    // set that merely ends there, and that row is dropped before the caller
    // sees it (#922 0a). Anything beyond `limit + 1` would be fetched only to
    // be discarded.
    expect(paged.rows).toBe(tile.limit + 1);

    expect(page.rows).toHaveLength(tile.limit);
    // One row per day, so the newest `limit` rows are exactly the newest
    // `limit` days.
    const oldest = page.rows
      .map((row) => String(row.values[tile.column]))
      .sort()[0];
    expect(oldest).toBe(stamp(DAYS - tile.limit));
    reader.close();
  });

  test("an unordered tile read is one bounded page", async () => {
    const { driver, reader } = household();

    const page = await reader.read("tasks", HOME_TILE_READS.tasks);

    const paged = onePage(driver);
    expect(paged.sql.match(/LIMIT \?/gu)).toHaveLength(1);
    // `limit + 1`: the one probe row that makes truncation visible (#922 0a).
    expect(paged.rows).toBe(HOME_TILE_LIMITS.tasks + 1);
    expect(page.rows).toHaveLength(HOME_TILE_LIMITS.tasks);
    reader.close();
  });

  // Tiles fetch bodies by id, bounded by the pushed predicate — never by
  // asking for the entity and slicing. The cross-scope content-hash collapse
  // that used to forbid a limit here went with the mount plane; the pushdown
  // is what actually keeps the read cheap, and it is what this holds.
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
    // The predicate is what bounds the read: twelve ids cost twelve rows out
    // of an entity of 2,000.
    expect(paged.rows).toBe(ids.length);
    expect(page.rows).toHaveLength(ids.length);
    reader.close();
  });
});
