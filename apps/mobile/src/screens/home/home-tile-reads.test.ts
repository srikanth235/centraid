/*
 * HOME COLD START, AS PAGES OVER THE SEAT (#880, #883 D1; #996 wave 5, R8).
 *
 * Nine reads fire when the springboard opens. What this file holds is the
 * SHAPE of the work each one asks SQLite for, against a real file through the
 * SAME assembler the phone runs (`seatWorkerPage`):
 *
 *   a tile is ONE page, and it crosses the driver at `limit + 1` — the window
 *   plus the single probe row that tells a filled window apart from a set that
 *   merely ends there, dropped before the tile sees it;
 *
 *   "the newest N" is SQLite's ordering, not a re-sort of an arbitrary page,
 *   so the rows the tile draws are the newest rows in the file;
 *
 *   a body lookup costs the ids it asks for: the `IN` is the predicate, never
 *   a slice of the entity taken afterwards.
 *
 * The old store's union arms, its order-guard census and its
 * `json_extract(payload_json, …)` are all absent because the plane is: a page
 * row IS the table's columns.
 */
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, test } from "vitest";

import { seatWorkerPage } from "@centraid/client/replica/native";
import type { SeatWorkerQuery } from "@centraid/client/replica/native";
import type { Page, PageCursor, PageQuery } from "@centraid/core/page";
import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { seedSeatTables } from "../../lib/replica/seat-fixture.test-fixtures";
import {
  expenseTileRead,
  HOME_BODY_LOOKUP,
  HOME_ORDERED_TILE_READS,
  HOME_TILE_LIMITS,
  HOME_TILE_READS,
  idList,
} from "./home-tile-reads";

/** Past the largest tile window (500), so no window ends where the file does. */
const DAYS = 700;
const DAY_MS = 86_400_000;

function stamp(day: number): string {
  return new Date(Date.UTC(2016, 0, 1) + day * DAY_MS).toISOString();
}

const pad = (day: number): string => String(day).padStart(4, "0");

/**
 * The seat's `page` over a real file, with every statement and its row count
 * recorded. `SeatPageFixture` beside this carries no recorder — the airplane
 * oracles assert on ANSWERS, and what this file asserts on is the WORK.
 */
class RecordingSeat {
  readonly reads: Array<{ sql: string; rows: number }> = [];
  readonly #db: DatabaseSync;

  constructor(file: string) {
    this.#db = new DatabaseSync(file, { readOnly: true });
  }

  readonly query = <T extends object>(
    request: SeatWorkerQuery
  ): Promise<T[]> => {
    const rows = (
      this.#db.prepare(request.sql).all(...(request.bind ?? [])) as T[]
    ).map((row) => ({ ...row }));
    this.reads.push({ sql: request.sql, rows: rows.length });
    return Promise.resolve(rows);
  };

  page<Row extends object>(request: {
    query: PageQuery<Row>;
    limit: number;
    after?: PageCursor;
  }): Promise<Page<Row>> {
    return seatWorkerPage(this, request.query, {
      limit: request.limit,
      ...(request.after ? { after: request.after } : {}),
    });
  }

  close(): void {
    this.#db.close();
  }
}

const opened: RecordingSeat[] = [];

function seat(): RecordingSeat {
  const dir = tempDirSync("home-tiles-");
  const file = path.join(dir, "vault.db");
  seedSeatTables(file, [
    {
      entity: "media.asset",
      primaryKey: "asset_id",
      columns: ["asset_id", "content_id", "kind", "captured_at", "deleted_at"],
      rows: Array.from({ length: DAYS }, (_, day) => ({
        asset_id: `asset-${pad(day)}`,
        content_id: `content-${pad(day)}`,
        kind: "photo",
        captured_at: stamp(day),
        deleted_at: null,
      })),
    },
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
      rows: Array.from({ length: DAYS }, (_, day) => ({
        document_id: `document-${pad(day)}`,
        title: `Household plan ${String(day)}`,
        current_content_id: `content-${pad(day)}`,
        updated_at: stamp(day),
        deleted_at: null,
      })),
    },
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
      rows: Array.from({ length: DAYS }, (_, day) => ({
        note_id: `note-${pad(day)}`,
        title: `Note ${String(day)}`,
        body_content_id: `content-${pad(day)}`,
        updated_at: stamp(day),
        deleted_at: null,
      })),
    },
    {
      entity: "core.content_item",
      primaryKey: "content_id",
      columns: ["content_id", "content_uri", "byte_size"],
      rows: Array.from({ length: DAYS }, (_, day) => ({
        content_id: `content-${pad(day)}`,
        content_uri: `data:text/markdown,line-${String(day)}`,
        byte_size: 64 + day,
      })),
    },
    {
      entity: "schedule.task",
      primaryKey: "task_id",
      columns: ["task_id", "title", "status", "completed_at", "sort_order"],
      rows: Array.from({ length: DAYS }, (_, day) => ({
        task_id: `task-${pad(day)}`,
        title: `Task ${String(day)}`,
        status: "needs-action",
        completed_at: null,
        sort_order: day,
      })),
    },
    {
      entity: "tally.expense",
      primaryKey: "expense_id",
      columns: ["expense_id", "amount_minor", "spent_on", "deleted_at"],
      rows: Array.from({ length: DAYS }, (_, day) => ({
        expense_id: `expense-${pad(day)}`,
        amount_minor: 100 + day,
        spent_on: stamp(day).slice(0, 10),
        deleted_at: null,
      })),
    },
  ]);
  const fixture = new RecordingSeat(file);
  opened.push(fixture);
  return fixture;
}

const ORDERED = [
  {
    tile: "photos",
    query: HOME_ORDERED_TILE_READS.photos,
    column: "captured_at",
    limit: HOME_TILE_LIMITS.photos,
  },
  {
    tile: "documents",
    query: HOME_ORDERED_TILE_READS.documents,
    column: "updated_at",
    limit: HOME_TILE_LIMITS.documents,
  },
  {
    tile: "notes",
    query: HOME_ORDERED_TILE_READS.notes,
    column: "updated_at",
    limit: HOME_TILE_LIMITS.notes,
  },
] as const;

describe("Home tile reads", () => {
  afterEach(() => {
    for (const fixture of opened.splice(0)) fixture.close();
  });

  test.each(ORDERED)(
    "the $tile tile is one page of the newest N",
    async (tile) => {
      const fixture = seat();

      const page = await fixture.page({ query: tile.query, limit: tile.limit });

      // ONE statement: a tile is a window, and a window is never a walk.
      expect(fixture.reads).toHaveLength(1);
      expect(fixture.reads[0]?.sql).toContain(`ORDER BY ${tile.column} DESC`);
      expect(fixture.reads[0]?.sql).not.toContain("payload_json");
      // The answer plus exactly one probe row, dropped before the tile sees it.
      expect(fixture.reads[0]?.rows).toBe(tile.limit + 1);
      expect(page.rows).toHaveLength(tile.limit);
      // A cursor, because the library ran past the window — this is what the
      // tile draws as `countCapped`.
      expect(page.next).toBeDefined();
      // One row per day, so the newest `limit` rows are the newest `limit` days.
      const oldest = page.rows
        .map((row) => String((row as Record<string, unknown>)[tile.column]))
        .sort()[0];
      expect(oldest).toBe(stamp(DAYS - tile.limit));
    }
  );

  test("an unordered tile read is one bounded page", async () => {
    const fixture = seat();

    const page = await fixture.page({
      query: HOME_TILE_READS.tasks,
      limit: HOME_TILE_LIMITS.tasks,
    });

    expect(fixture.reads).toHaveLength(1);
    expect(fixture.reads[0]?.rows).toBe(HOME_TILE_LIMITS.tasks + 1);
    expect(page.rows).toHaveLength(HOME_TILE_LIMITS.tasks);
  });

  test("the month's expenses are bounded by the predicate, not the window", async () => {
    const fixture = seat();
    const from = stamp(DAYS - 30).slice(0, 10);

    const page = await fixture.page({
      query: expenseTileRead(from),
      limit: HOME_TILE_LIMITS.expenses,
    });

    expect(fixture.reads[0]?.sql).toContain("spent_on >= ?");
    // Thirty days out of 700: the predicate is what makes the read cheap.
    expect(page.rows).toHaveLength(30);
    expect(page.next).toBeUndefined();
  });

  test("the body lookup costs the ids it asks for", async () => {
    const fixture = seat();
    const ids = Array.from(
      { length: 12 },
      (_, index) => `content-${pad(699 - index)}`
    );

    const query = idList(HOME_BODY_LOOKUP, ids);
    const page = await fixture.page({ query: query!, limit: 500 });

    expect(fixture.reads[0]?.sql).toContain("content_id IN (");
    // Twelve ids cost twelve rows out of a table of 700.
    expect(fixture.reads[0]?.rows).toBe(ids.length);
    expect(page.rows).toHaveLength(ids.length);
  });

  test("an empty id set is not a read at all", () => {
    // `IN ()` matches nothing, which is the right ANSWER and the wrong SHAPE:
    // the screen has not got its input yet, so the hook holds `loading`.
    expect(idList(HOME_BODY_LOOKUP, [])).toBeUndefined();
  });
});
