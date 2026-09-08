// SEARCH, OVER THE SEAT'S OWN FILE (#996, ruling W5-D1).
//
// The claim is that a seat can answer a search without a second index and
// without the gateway: the vault's FTS shadow tables came across in the
// bootstrap copy, the same triggers keep them, and the statement is the
// gateway's. So the fixture here is the vault's OWN DDL shape — a base table,
// an `fts_` shadow over it, and the AFTER-triggers that keep the two in step —
// rather than a hand-filled index, because a suite that populated the shadow
// itself would prove nothing about a row that changed after the copy landed.
//
// The year-3 measurement — that the seat's answer IS the gateway's answer, row
// for row, on a real corpus — is `tests/quality/seat-replay-parity.test.ts`.
// This suite is the grammar: what the statement selects, what it excludes, and
// what it refuses.

import { describe, expect, it } from "vitest";

import { OnlineOnlyError } from "../online-only-error.js";
import { ReplicaProtocolError } from "../replica-protocol-error.js";
import { NodeSeatDriver } from "./node-seat-driver.js";
import {
  seatSearchStatement,
  seatSearchUnavailable,
  seatSearchWindow,
  seatWorkerSearch,
} from "./search-page.js";
import type { SeatQueryPort } from "./seat-page-reader.js";
import type { SeatWorkerQuery } from "./worker-protocol.js";

/** `schedule.task` as the vault builds it: table, shadow, triggers. */
function taskSeat(): NodeSeatDriver {
  const driver = new NodeSeatDriver();
  driver.exec(`
    CREATE TABLE schedule_task (
      task_id TEXT PRIMARY KEY,
      title TEXT,
      description TEXT,
      deleted_at TEXT
    ) STRICT;
    CREATE VIRTUAL TABLE fts_schedule_task USING fts5(
      task_id UNINDEXED, title, description,
      tokenize = "unicode61 remove_diacritics 2"
    );
    CREATE TRIGGER fts_schedule_task_ai AFTER INSERT ON schedule_task BEGIN
      INSERT INTO fts_schedule_task(rowid, task_id, title, description)
      SELECT new.rowid, new."task_id", new."title", new."description"
       WHERE new."deleted_at" IS NULL;
    END;
    CREATE TRIGGER fts_schedule_task_au AFTER UPDATE ON schedule_task BEGIN
      DELETE FROM fts_schedule_task WHERE rowid = old.rowid;
      INSERT INTO fts_schedule_task(rowid, task_id, title, description)
      SELECT new.rowid, new."task_id", new."title", new."description"
       WHERE new."deleted_at" IS NULL;
    END;
  `);
  return driver;
}

/** The one method `seatWorkerSearch` needs, over a driver in this process. */
function port(driver: NodeSeatDriver): SeatQueryPort {
  return {
    query: <T extends object>(request: SeatWorkerQuery): Promise<T[]> =>
      Promise.resolve(driver.all<T>(request.sql, request.bind ?? [])),
  };
}

function add(
  driver: NodeSeatDriver,
  id: string,
  title: string,
  description = ""
): void {
  driver.run(
    `INSERT INTO schedule_task (task_id, title, description) VALUES (?, ?, ?)`,
    [id, title, description]
  );
}

describe("a seat searches its own copy of the vault", () => {
  it("ranks the rows the vault's shadow table holds, and projects the base row", async () => {
    const driver = taskSeat();
    add(driver, "t1", "Book the ferry", "ferry to the island");
    add(driver, "t2", "Ferry tickets");
    add(driver, "t3", "Buy milk");
    const { rows } = await seatWorkerSearch<{
      task_id: string;
      title: string;
      _snippet: string;
    }>(port(driver), { entity: "schedule.task", query: "ferry" });
    expect(rows.map((row) => row.task_id).toSorted()).toStrictEqual([
      "t1",
      "t2",
    ]);
    // The BASE row, not the shadow's columns: every caller reads `title` and
    // the ids beside it off the row the search answered.
    expect(rows.every((row) => typeof row.title === "string")).toBe(true);
    // And the match context the old plane already answered under this name.
    expect(rows.some((row) => row._snippet.includes("⟦"))).toBe(true);
    driver.close();
  });

  it("a row soft-deleted after the copy landed leaves the index, and the answer", async () => {
    const driver = taskSeat();
    add(driver, "t1", "Ferry tickets");
    driver.run(`UPDATE schedule_task SET deleted_at = ? WHERE task_id = ?`, [
      "2026-09-08T00:00:00Z",
      "t1",
    ]);
    const { rows } = await seatWorkerSearch(port(driver), {
      entity: "schedule.task",
      query: "ferry",
    });
    expect(rows).toStrictEqual([]);
    driver.close();
  });

  it("honours the window it was asked for, and clamps past the ceiling", () => {
    // The gateway's own arithmetic (`vault/src/gateway/search.ts`), edge for
    // edge: a window nobody could mean is clamped, never refused.
    expect(seatSearchWindow(undefined)).toBe(100);
    expect(seatSearchWindow(6)).toBe(6);
    expect(seatSearchWindow(50_000)).toBe(1_000);
    expect(seatSearchWindow(0)).toBe(1);
  });

  it("names the vault's own tables, and binds the prefix match the gateway compiles", () => {
    const statement = seatSearchStatement({
      entity: "people.profile",
      query: "ada love",
      limit: 6,
    });
    expect(statement.sql).toContain("fts_people_profile");
    expect(statement.sql).toContain(`JOIN "people_profile" b`);
    expect(statement.sql).toContain('b."profile_id" = fts_people_profile');
    // The deterministic tiebreak the gateway also orders by: bm25 rank ties,
    // and two seats that broke a tie differently would page differently.
    expect(statement.sql).toContain(
      'ORDER BY fts_people_profile.rank, b."profile_id"'
    );
    expect(statement.bind).toStrictEqual(['"ada"* "love"*', 6]);
  });

  it("refuses an entity the seat holds no eager search surface for", () => {
    expect(() =>
      seatSearchStatement({ entity: "core.vault", query: "anything" })
    ).toThrow(OnlineOnlyError);
  });

  it("refuses a query with no searchable words rather than matching everything", () => {
    expect(() =>
      seatSearchStatement({ entity: "schedule.task", query: "   " })
    ).toThrow(ReplicaProtocolError);
  });

  it("a seat with no file is online-only, not broken", () => {
    expect(seatSearchUnavailable("tasks/schedule.task")).toBeInstanceOf(
      OnlineOnlyError
    );
  });
});
