// THE PAGED HANDLER HOST, RED FIRST (#996 wave 4, R8).
//
// Every app handler on every seat runs through here, so the claims are the ones
// that have to hold for all of them at once rather than per app:
//
//   1. the keyset is a ROW VALUE over the handler's own ORDER BY columns, in
//      the handler's own direction — the one shape SQLite turns into a seek;
//   2. the host asks for the probe row, and the caller never sees it;
//   3. a window over the ceiling is CLAMPED, and the clamp is a work-counter
//      fact rather than a refusal shown to the member;
//   4. the rows a handler visited are counted, always, for every handler —
//      that is the gate R8 puts on the read path, and a handler that forgets to
//      declare it cannot, because it does not do the counting.

import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_PAGE_ROWS } from "@centraid/core/page";
import { zeroCounters } from "@centraid/core/protocol";

import { clientWorkCounters } from "../work-counters.js";
import type { SeatSqliteDriver } from "./driver.js";
import { seatPage } from "./paged-handler.js";

interface NoteRow {
  note_id: string;
  updated_at: string;
}

let db: DatabaseSync;
let driver: SeatSqliteDriver;
const statements: string[] = [];

const recent = {
  name: "notes.recent",
  sql: (keyset: string) =>
    `SELECT note_id, updated_at FROM note
      WHERE deleted_at IS NULL ${keyset}`,
  order: {
    sortColumn: "updated_at",
    pkColumn: "note_id",
    descending: true,
  },
  keyOf: (row: NoteRow) => ({ sortKey: row.updated_at, pk: row.note_id }),
} as const;

describe("the paged handler host", () => {
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(
      `CREATE TABLE note (note_id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, deleted_at TEXT);
       CREATE INDEX note_recent ON note(updated_at DESC, note_id DESC) WHERE deleted_at IS NULL;`
    );
    const insert = db.prepare(
      "INSERT INTO note (note_id, updated_at) VALUES (?, ?)"
    );
    // Two rows share a timestamp on purpose: the tiebreak is the reason the
    // primary key is in the key at all.
    for (let i = 0; i < 40; i += 1)
      insert.run(
        `n${String(i).padStart(3, "0")}`,
        `2026-01-${String(Math.floor(i / 2) + 1).padStart(2, "0")}T00:00:00Z`
      );
    statements.length = 0;
    driver = {
      run: (sql, bind = []) => {
        db.prepare(sql).run(...(bind as never[]));
      },
      all: <T extends object>(sql: string, bind: readonly unknown[] = []) => {
        statements.push(sql);
        return db.prepare(sql).all(...(bind as never[])) as T[];
      },
      exec: (sql) => {
        db.exec(sql);
      },
      close: () => {
        db.close();
      },
    };
  });

  afterEach(() => {
    db.close();
  });

  it("compares the keyset as a row value in the handler's direction", () => {
    const first = seatPage<NoteRow>(driver, recent, { limit: 10 });
    seatPage<NoteRow>(driver, recent, { limit: 10, after: first.next });
    expect(statements[1]).toContain("(updated_at, note_id) < (?, ?)");
    expect(statements[1]).toContain("ORDER BY updated_at DESC, note_id DESC");
    // The first page has no cursor to compare against, so it carries no
    // predicate at all rather than a tautological one.
    expect(statements[0]).not.toContain("(updated_at, note_id)");
  });

  it("walks the table exactly once across pages, ties included", () => {
    const seen: string[] = [];
    let after = undefined as ReturnType<typeof seatPage<NoteRow>>["next"];
    for (let guard = 0; guard < 20; guard += 1) {
      const page = seatPage<NoteRow>(driver, recent, { limit: 7, after });
      seen.push(...page.rows.map((row) => row.note_id));
      if (!page.next) break;
      after = page.next;
    }
    expect(seen).toHaveLength(40);
    expect(new Set(seen).size).toBe(40);
  });

  it("never hands the probe row to the caller", () => {
    const page = seatPage<NoteRow>(driver, recent, { limit: 7 });
    expect(page.rows).toHaveLength(7);
    expect(page.next).toStrictEqual({
      sortKey: page.rows[6]!.updated_at,
      pk: page.rows[6]!.note_id,
    });
  });

  it("clamps a window past the ceiling instead of refusing it", () => {
    const page = seatPage<NoteRow>(driver, recent, {
      limit: MAX_PAGE_ROWS * 10,
    });
    expect(page.rows).toHaveLength(40);
    expect(page.next).toBeUndefined();
  });

  it("counts the statement and the rows it visited", () => {
    const before = clientWorkCounters();
    seatPage<NoteRow>(driver, recent, { limit: 7 });
    const after = clientWorkCounters();
    expect(after.statements - before.statements).toBe(1);
    // Eight: the window plus the probe row the host dropped. The probe is work
    // the seat really did, so it is counted even though nobody saw it.
    expect(after.rowsScanned - before.rowsScanned).toBe(8);
    expect(Object.keys(after)).toStrictEqual(Object.keys(zeroCounters()));
  });
});
