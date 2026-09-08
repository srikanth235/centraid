// THE PRECONDITION A QUEUED WRITE STATES (#996, R24; #922 G5).
//
// A base version is what turns a lost edit into a CONFLICT the member is shown.
// Three ways it goes wrong quietly, and each is a case here:
//
//   1. capturing from the OVERLAY rather than the file — a queued edit becomes
//      its own base version, so it can never conflict with anything;
//   2. a row that is not there answering `0` instead of nothing — a create
//      would then claim a precondition, and the gateway would refuse it;
//   3. reading the key from a registry instead of the FILE, which drifts.

import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { OptimisticMutation } from "../types.js";
import { SeatRowKeys, seatBaseVersions } from "./base-versions.js";
import type { SeatQueryPort } from "./seat-page-reader.js";
import type { SeatWorkerQuery } from "./worker-protocol.js";

function port(db: DatabaseSync): SeatQueryPort & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    query: <T extends object>(request: SeatWorkerQuery): Promise<T[]> => {
      asked.push(request.sql);
      return Promise.resolve(
        db.prepare(request.sql).all(...((request.bind ?? []) as never[])) as T[]
      );
    },
  };
}

function seat(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE schedule_task (
      task_id TEXT PRIMARY KEY, title TEXT, row_version INTEGER NOT NULL);
    CREATE TABLE core_tag (
      target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      row_version INTEGER NOT NULL, PRIMARY KEY (target_type, target_id));
    INSERT INTO schedule_task VALUES ('t1', 'Ferry', 4);
    INSERT INTO schedule_task VALUES ('t2', 'Milk', 9);
  `);
  return db;
}

function upsert(entity: string, rowId: string): OptimisticMutation {
  return { op: "upsert", shapeId: "shape-x", entity, rowId, values: {} };
}

describe("the base versions a seat captures", () => {
  it("reads the row's version out of the file", async () => {
    const db = seat();
    try {
      const p = port(db);
      const captured = await seatBaseVersions(p, new SeatRowKeys(p), [
        upsert("schedule.task", "t1"),
        upsert("schedule.task", "t2"),
      ]);
      expect(captured.map((v) => [v.rowId, v.version]).sort()).toStrictEqual([
        ["t1", 4],
        ["t2", 9],
      ]);
      // NEVER THE OVERLAY: no query this capture makes carries one.
      expect(p.asked.every((sql) => !sql.includes("seat_outbox"))).toBe(true);
    } finally {
      db.close();
    }
  });

  it("states no precondition for a row that is not there", async () => {
    const db = seat();
    try {
      const p = port(db);
      // A create: the row id is minted by the projection and nothing holds it.
      await expect(
        seatBaseVersions(p, new SeatRowKeys(p), [
          upsert("schedule.task", "not-yet"),
        ])
      ).resolves.toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it("asks the FILE for the key, once per entity", async () => {
    const db = seat();
    try {
      const p = port(db);
      const keys = new SeatRowKeys(p);
      await seatBaseVersions(p, keys, [upsert("schedule.task", "t1")]);
      await seatBaseVersions(p, keys, [upsert("schedule.task", "t2")]);
      const pragmas = p.asked.filter((sql) =>
        sql.includes("pragma_table_info")
      );
      // Two per capture would be a round trip per write for a schema that
      // cannot move under an open seat.
      expect(pragmas).toHaveLength(2);
      expect(pragmas[0]).toContain("pragma_table_info");
    } finally {
      db.close();
    }
  });

  it("captures nothing for a table addressed by a composite key", async () => {
    const db = seat();
    try {
      const p = port(db);
      // A row a projection addresses by ONE id cannot live in such a table, so
      // half a key would be a precondition against the wrong row.
      await expect(
        seatBaseVersions(p, new SeatRowKeys(p), [
          upsert("core.tag", "media.asset"),
        ])
      ).resolves.toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it("captures nothing for a table this seat's file does not hold", async () => {
    const db = seat();
    try {
      const p = port(db);
      await expect(
        seatBaseVersions(p, new SeatRowKeys(p), [upsert("locker.item", "i1")])
      ).resolves.toStrictEqual([]);
    } finally {
      db.close();
    }
  });

  it("states one precondition for a row a write touches twice", async () => {
    const db = seat();
    try {
      const p = port(db);
      const captured = await seatBaseVersions(p, new SeatRowKeys(p), [
        upsert("schedule.task", "t1"),
        upsert("schedule.task", "t1"),
      ]);
      expect(captured).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
