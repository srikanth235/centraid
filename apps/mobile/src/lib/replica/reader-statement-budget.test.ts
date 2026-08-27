// How many SQLite statements one mounted read costs (#880).
//
// `tests/experience-budgets/client-query-counts.json` fences the gateway's
// vault plane by intercepting `DatabaseSync.prepare` and counting statements
// per screen (tests/quality/first-paint-query-counts.test.ts). The phone had no
// counterpart: its reads never touch that plane, they go to the mounted
// multi-vault reader, and nothing said how many statements a screen's worth of
// them costs. A read that quietly grew a per-scope round trip — one more
// existence probe, one more metadata lookup — would have shown up only as a
// slower Home on somebody's device.
//
// This budget is stated in STATEMENTS, not milliseconds, and therefore does not
// belong in tests/experience-budgets/mobile.json: that directory is "what the
// vault owner feels", and its README is explicit that a machine-cost number
// belongs with the machine-cost budgets instead. So the ceiling lives here,
// next to the reader it fences, and this test is its whole enforcement.
//
// What the shape is, per read, over S mounted scopes:
//
//   1  entity-schema union      (one statement across all scopes)
//   1  content-hash lookup      (cached per app+purpose+entity after the first)
//   S  pending-overlay probes   (one `sqlite_master` existence check per scope)
//   1  order-pushdown probe     (ordered reads only; refused ones never probe)
//   1  canonical page           (one UNION, per-scope `ORDER BY … LIMIT` inside)
//   S  source-state reads       (cursor + coverage, one per scope)
//
// So a read costs `2S + k`, k small — linear in MOUNTED VAULTS and constant in
// LIBRARY SIZE. That second half is the load-bearing claim: the fixture below
// saturates every ordered page, so the numbers are measured on the path a real
// library takes, not on an empty vault.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { ReplicaSqliteStore } from "@centraid/client/replica/native";
import type { ReplicaBindValue } from "@centraid/client/replica/native";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  expenseTileRead,
  HOME_ORDERED_TILE_READS,
  HOME_TILE_LIMITS,
  HOME_TILE_READS,
  idFilter,
} from "../../screens/home/home-tile-reads";
import { MultiVaultReplicaReader } from "./multi-vault-reader";
import { NodeSqliteDriver } from "./node-sqlite-driver";
import { MAX_MOUNTED_NATIVE_SCOPES } from "./offline-budgets";

// The worst case a phone can be in: the mount planner attaches no more than
// this, so a budget measured here is a budget for every household.
const SCOPES = ["personal", "family", "school", "club"] as const;
const DAY_MS = 86_400_000;

/**
 * Deep enough that every ordered tile fills its page in every scope (the
 * largest per-scope page Home asks for is 500), so no read can pass this
 * budget by finding an empty vault.
 */
const DEEP_ROWS = 520;
const SHALLOW_ROWS = 8;

interface SeedEntity {
  entity: string;
  primaryKey: string;
  columns: string[];
  deep?: true;
  row: (suffix: string, at: string) => Record<string, unknown>;
}

const SHAPES: Array<{
  shapeId: string;
  appId: string;
  entities: SeedEntity[];
}> = [
  {
    shapeId: "photos-default",
    appId: "photos",
    entities: [
      {
        entity: "media.asset",
        primaryKey: "asset_id",
        columns: ["asset_id", "content_id", "captured_at", "deleted_at"],
        deep: true,
        row: (suffix, at) => ({
          asset_id: `asset-${suffix}`,
          content_id: `content-${suffix}`,
          captured_at: at,
          deleted_at: null,
        }),
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
          "updated_at",
          "deleted_at",
        ],
        deep: true,
        row: (suffix, at) => ({
          document_id: `document-${suffix}`,
          title: `Plan ${suffix}`,
          current_content_id: `content-${suffix}`,
          updated_at: at,
          deleted_at: null,
        }),
      },
      {
        // The content-hashed entity: never given a per-scope page, so Home
        // fetches its bodies by id instead of ordering them.
        entity: "core.content_item",
        primaryKey: "content_id",
        columns: ["content_id", "title", "sha256", "deleted_at"],
        row: (suffix) => ({
          content_id: `content-${suffix}`,
          title: `Plan ${suffix}`,
          sha256: `sha-${suffix}`,
          deleted_at: null,
        }),
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
          "updated_at",
          "deleted_at",
        ],
        deep: true,
        row: (suffix, at) => ({
          note_id: `note-${suffix}`,
          title: `Note ${suffix}`,
          body_content_id: `content-${suffix}`,
          updated_at: at,
          deleted_at: null,
        }),
      },
      {
        entity: "core.content_item",
        primaryKey: "content_id",
        columns: ["content_id", "title", "sha256", "deleted_at"],
        row: (suffix) => ({
          content_id: `content-${suffix}`,
          title: `Note ${suffix}`,
          sha256: `sha-${suffix}`,
          deleted_at: null,
        }),
      },
    ],
  },
  {
    shapeId: "agenda-default",
    appId: "agenda",
    entities: [
      {
        entity: "core.event",
        primaryKey: "event_id",
        columns: ["event_id", "summary", "dtstart"],
        row: (suffix, at) => ({
          event_id: `event-${suffix}`,
          summary: `Event ${suffix}`,
          dtstart: at,
        }),
      },
      {
        entity: "schedule.recurrence_exception",
        primaryKey: "exception_id",
        columns: ["exception_id", "event_id"],
        row: (suffix) => ({
          exception_id: `exception-${suffix}`,
          event_id: `event-${suffix}`,
        }),
      },
    ],
  },
  {
    shapeId: "people-default",
    appId: "people",
    entities: [
      {
        entity: "people.profile",
        primaryKey: "profile_id",
        columns: ["profile_id", "party_id"],
        row: (suffix) => ({
          profile_id: `profile-${suffix}`,
          party_id: `party-${suffix}`,
        }),
      },
      {
        entity: "core.party",
        primaryKey: "party_id",
        columns: ["party_id", "display_name"],
        row: (suffix) => ({
          party_id: `party-${suffix}`,
          display_name: `Person ${suffix}`,
        }),
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
        columns: ["task_id", "title", "status", "deleted_at"],
        row: (suffix) => ({
          task_id: `task-${suffix}`,
          title: `Task ${suffix}`,
          status: "open",
          deleted_at: null,
        }),
      },
    ],
  },
  {
    shapeId: "tally-default",
    appId: "tally",
    entities: [
      {
        entity: "tally.expense",
        primaryKey: "expense_id",
        columns: ["expense_id", "spent_on", "amount", "deleted_at"],
        row: (suffix, at) => ({
          expense_id: `expense-${suffix}`,
          spent_on: at.slice(0, 10),
          amount: 100,
          deleted_at: null,
        }),
      },
      {
        entity: "core.vault",
        primaryKey: "vault_id",
        columns: ["vault_id", "label"],
        row: (suffix) => ({
          vault_id: `vault-${suffix}`,
          label: `Vault ${suffix}`,
        }),
      },
    ],
  },
];

/** Every statement the reader hands SQLite, in order. */
class CountingDriver extends NodeSqliteDriver {
  readonly statements: string[] = [];

  // `allAsync` delegates to `all`, so overriding this one method counts the
  // off-thread path the reader actually takes exactly once.
  override all<T extends object>(
    sql: string,
    bind: readonly ReplicaBindValue[] = []
  ): T[] {
    this.statements.push(sql);
    return super.all<T>(sql, bind);
  }
}

function stamp(day: number): string {
  return new Date(Date.UTC(2016, 0, 1) + day * DAY_MS).toISOString();
}

function seedScope(file: string, vaultId: string): void {
  const store = new ReplicaSqliteStore(new NodeSqliteDriver(file), vaultId);
  store.bootstrap({
    protocolVersion: 1,
    vaultId,
    schemaEpoch: "1",
    cursor: { epoch: `epoch-${vaultId}`, seq: DEEP_ROWS },
    shapes: SHAPES.map((shape) => ({
      shapeId: shape.shapeId,
      appId: shape.appId,
      purpose: "dpv:ServiceProvision",
      entities: shape.entities.map((entity) => ({
        entity: entity.entity,
        primaryKey: entity.primaryKey,
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
  for (const shape of SHAPES) {
    for (const entity of shape.entities) {
      const count = entity.deep ? DEEP_ROWS : SHALLOW_ROWS;
      for (let day = 0; day < count; day += 1) {
        const suffix = `${vaultId}-${String(day).padStart(4, "0")}`;
        const values = entity.row(suffix, stamp(day));
        insert.run(
          shape.shapeId,
          entity.entity,
          String(values[entity.primaryKey]),
          JSON.stringify(values)
        );
      }
    }
  }
  database.exec("COMMIT");
  database.close();
}

function household(): {
  driver: CountingDriver;
  reader: MultiVaultReplicaReader;
} {
  const root = tempDirSync("centraid-reader-statements-");
  const scopes = SCOPES.map((vaultId) => ({
    vaultId,
    label: vaultId,
    canWrite: vaultId === "personal",
    databaseName: path.join(root, `${vaultId}.db`),
  }));
  for (const scope of scopes) seedScope(scope.databaseName, scope.vaultId);
  const driver = new CountingDriver(path.join(root, "mounted.db"));
  return { driver, reader: new MultiVaultReplicaReader(driver, scopes) };
}

/** Classify one statement into the six kinds a read is made of. */
function bucket(sql: string): string {
  if (sql.includes("sqlite_master")) return "overlayProbe";
  if (sql.includes("replica_intent_outbox")) return "overlayRows";
  if (sql.includes("AS order_withheld")) return "orderProbe";
  if (sql.includes("r.payload_json, r.oversized_json")) return "rows";
  if (sql.includes("replica_bootstrap_progress")) return "state";
  if (sql.includes("replica_entity_schema AS es")) return "schema";
  return "other";
}

function shapeOf(statements: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const sql of statements) {
    const kind = bucket(sql);
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

/**
 * Home's cold start, as the springboard fires it (`useSpringboardTiles`): three
 * ordered tiles, two id-filtered body lookups, one id-filtered party lookup,
 * and six bounded reads.
 */
const HOME_COLD_START: Array<{
  appId: string;
  request: Parameters<MultiVaultReplicaReader["read"]>[1];
}> = [
  { appId: "photos", request: HOME_ORDERED_TILE_READS.photos },
  { appId: "docs", request: HOME_ORDERED_TILE_READS.documents },
  {
    appId: "docs",
    request: idFilter("core.content_item", "content_id", [
      "content-personal-0519",
      "content-family-0519",
    ]),
  },
  { appId: "notes", request: HOME_ORDERED_TILE_READS.notes },
  {
    appId: "notes",
    request: idFilter("core.content_item", "content_id", [
      "content-personal-0519",
    ]),
  },
  { appId: "agenda", request: HOME_TILE_READS.events },
  { appId: "agenda", request: HOME_TILE_READS.exceptions },
  { appId: "people", request: HOME_TILE_READS.profiles },
  {
    appId: "people",
    request: idFilter("core.party", "party_id", ["party-personal-0001"]),
  },
  { appId: "tasks", request: HOME_TILE_READS.tasks },
  { appId: "tally", request: expenseTileRead("2016-01-01") },
  { appId: "tally", request: HOME_TILE_READS.vault },
];

describe("mounted reader statement budget (#880)", () => {
  test("one ordered read is 2 statements per scope plus a constant", async () => {
    expect(SCOPES).toHaveLength(MAX_MOUNTED_NATIVE_SCOPES);
    const { driver, reader } = household();
    try {
      const page = await reader.read("photos", HOME_ORDERED_TILE_READS.photos);
      // Measured on a saturating page, not an empty vault.
      expect(page.rows).toHaveLength(HOME_TILE_LIMITS.photos);
      expect(shapeOf(driver.statements)).toStrictEqual({
        schema: 2,
        overlayProbe: SCOPES.length,
        orderProbe: 1,
        rows: 1,
        state: SCOPES.length,
      });
      // `schema: 2` is the entity-schema union plus the content-hash lookup,
      // which reads the same table; the second is cached from here on.
      expect(driver.statements).toHaveLength(2 * SCOPES.length + 4);
    } finally {
      reader.close();
    }
  });

  test("an id-filtered read on a content-hashed entity never probes an order", async () => {
    const { driver, reader } = household();
    try {
      await reader.read(
        "docs",
        idFilter("core.content_item", "content_id", ["content-personal-0001"])
      );
      const counts = shapeOf(driver.statements);
      expect(counts["orderProbe"]).toBeUndefined();
      expect(counts["rows"]).toBe(1);
    } finally {
      reader.close();
    }
  });

  /**
   * THE CEILING. 12 reads over 4 mounted vaults.
   *
   * Observed 2026-08-27, Node SQLite driver over the production reader: 135
   * statements — exactly `12 x (1 schema + 4 overlay probes + 1 page + 4
   * states) + 12 content-hash lookups + 3 order probes`, with no residue. The
   * ceiling is that number plus ~12% headroom, so one more tile (11) lands
   * without a fight while a new per-scope round trip inside the reader (12 at
   * once, and 12 more for every mounted vault a household adds) does not. It
   * may only fall.
   */
  test("Home's cold start stays inside its statement ceiling", async () => {
    const HOME_COLD_START_STATEMENT_CEILING = 152;
    const { driver, reader } = household();
    try {
      // Sequential on purpose: the reader caches the content-hash lookup per
      // app+purpose+entity, so racing the twelve reads would count a different
      // number of them each run and the ceiling would mean nothing.
      await forEachSequentially(HOME_COLD_START, async (read) => {
        await reader.read(read.appId, read.request);
      });
      expect(driver.statements.length).toBeLessThanOrEqual(
        HOME_COLD_START_STATEMENT_CEILING
      );
      // Linear in mounted vaults, constant in library size: every statement
      // belongs to one of the six known kinds, and none of them repeats per
      // row or per page.
      expect(shapeOf(driver.statements)["other"]).toBeUndefined();
      expect(shapeOf(driver.statements)["rows"]).toBe(HOME_COLD_START.length);
    } finally {
      reader.close();
    }
  });
});
