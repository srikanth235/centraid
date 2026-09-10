import { describe, expect, it } from "vitest";

import { encodeWireValue } from "@centraid/core/protocol";
import type { SeatLogPageWire, SeatLogRowWire } from "@centraid/core/protocol";

import { applySeatLogPage } from "./applier.js";
import { openSeatFile } from "./driver.js";
import { NodeSeatDriver } from "./node-seat-driver.js";
import { SeatDriftError } from "./seat-drift-error.js";
import { initSeatState, readSeatState } from "./state.js";
import { seatWatermark, seatWatermarkLine } from "./watermark.js";

const VAULT = "vault-1";
const EPOCH = "e1";

function seat(): NodeSeatDriver {
  const driver = new NodeSeatDriver();
  openSeatFile(driver);
  driver.exec(`
    CREATE TABLE note (
      note_id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT,
      row_version INTEGER NOT NULL DEFAULT 1, cover BLOB, bytes INTEGER
    ) STRICT;
    CREATE TABLE tag (note_id TEXT NOT NULL, label TEXT NOT NULL,
      PRIMARY KEY (note_id, label)) STRICT;
  `);
  initSeatState(driver, {
    vaultId: VAULT,
    epoch: EPOCH,
    schemaEpoch: 2,
    appliedSeq: 10,
  });
  return driver;
}

let nextSeq = 10;
function row(
  partial: Partial<SeatLogRowWire> & Pick<SeatLogRowWire, "table" | "op">
): SeatLogRowWire {
  nextSeq += 1;
  return {
    seq: nextSeq,
    commitSeq: 100,
    schemaEpoch: 2,
    ddlVersion: 0,
    pk: [],
    producer: "test",
    committedAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function page(
  rows: SeatLogRowWire[],
  overrides: Partial<SeatLogPageWire> = {}
): SeatLogPageWire {
  const last = rows.at(-1);
  return {
    vaultId: VAULT,
    epoch: EPOCH,
    schemaEpoch: 2,
    ddlVersion: 0,
    floor: 0,
    watermark: last?.seq ?? 10,
    next: last?.seq ?? 10,
    hasMore: false,
    rows,
    ...overrides,
  };
}

function insertNote(
  id: string,
  title: string,
  commitSeq = 100
): SeatLogRowWire {
  return row({
    table: "note",
    op: "insert",
    commitSeq,
    pk: [id],
    row: {
      note_id: id,
      title,
      body: null,
      row_version: 1,
      cover: null,
      bytes: null,
    },
  });
}

describe("the seat applier", () => {
  it("upserts a row image and moves the cursor in the same transaction", () => {
    nextSeq = 10;
    const driver = seat();
    const first = insertNote("n1", "first");
    const result = applySeatLogPage(driver, page([first]));
    expect(result.applied).toBe(1);
    expect(result.tables).toStrictEqual(["note"]);
    expect(result.commitSeqs).toStrictEqual([100]);
    expect(readSeatState(driver).appliedSeq).toBe(first.seq);
    expect(readSeatState(driver).appliedCommitSeq).toBe(100);
    expect(
      driver.all<{ title: string }>(
        `SELECT title FROM note WHERE note_id = 'n1'`
      )
    ).toStrictEqual([{ title: "first" }]);
    driver.close();
  });

  it("updates in place rather than replacing, so a row keeps columns the image repeats", () => {
    nextSeq = 10;
    const driver = seat();
    applySeatLogPage(driver, page([insertNote("n1", "first")]));
    const update = row({
      table: "note",
      op: "update",
      commitSeq: 101,
      pk: ["n1"],
      row: {
        note_id: "n1",
        title: "second",
        body: "text",
        row_version: 2,
        cover: null,
        bytes: null,
      },
    });
    applySeatLogPage(driver, page([update]));
    expect(
      driver.all<{ title: string; body: string; row_version: number }>(
        `SELECT title, body, row_version FROM note`
      )
    ).toStrictEqual([{ title: "second", body: "text", row_version: 2 }]);
    driver.close();
  });

  it("is idempotent on duplicate delivery — the same page twice changes nothing", () => {
    nextSeq = 10;
    const driver = seat();
    const rows = [insertNote("n1", "first"), insertNote("n2", "second", 101)];
    const first = applySeatLogPage(driver, page(rows));
    expect(first.applied).toBe(2);
    expect(first.duplicate).toBe(0);
    // A delete, then the SAME page redelivered: an upsert that "happens to be
    // harmless" would resurrect the deleted row.
    const remove = row({
      table: "note",
      op: "delete",
      commitSeq: 102,
      pk: ["n1"],
      row: { note_id: "n1" },
    });
    applySeatLogPage(driver, page([remove]));
    const again = applySeatLogPage(driver, page(rows));
    expect(again.applied).toBe(0);
    expect(again.duplicate).toBe(2);
    expect(
      driver.all(`SELECT note_id FROM note ORDER BY note_id`)
    ).toStrictEqual([{ note_id: "n2" }]);
    driver.close();
  });

  it("carries a BLOB and a 64-bit integer through the wire unchanged", () => {
    nextSeq = 10;
    const driver = seat();
    const cover = new Uint8Array([0, 1, 250, 255, 128]);
    const bytes = 9_007_199_254_740_997n;
    applySeatLogPage(
      driver,
      page([
        row({
          table: "note",
          op: "insert",
          pk: ["n1"],
          row: {
            note_id: "n1",
            title: "wide",
            body: null,
            row_version: 1,
            cover: encodeWireValue(cover),
            bytes: encodeWireValue(bytes),
          },
        }),
      ])
    );
    // Read back as TEXT: `node:sqlite` refuses to materialise an integer past
    // 2^53 as a JS number, which is exactly the loss the `{i: "…"}` encoding
    // exists to avoid — so the assertion asks SQLite for the digits rather
    // than asking the binding to lose them.
    const held = driver.all<{ cover: Uint8Array; bytes: string }>(
      `SELECT cover, CAST(bytes AS TEXT) AS bytes FROM note`
    )[0]!;
    expect([...held.cover]).toStrictEqual([...cover]);
    expect(BigInt(held.bytes)).toBe(bytes);
    driver.close();
  });

  it("refuses a page whose row carries a later schema epoch, and applies nothing", () => {
    nextSeq = 10;
    const driver = seat();
    const drifted = [
      insertNote("n1", "before"),
      row({
        table: "note",
        op: "insert",
        commitSeq: 101,
        pk: ["n2"],
        schemaEpoch: 3,
        row: {
          note_id: "n2",
          title: "after",
          body: null,
          row_version: 1,
          cover: null,
          bytes: null,
        },
      }),
    ];
    const refused = ((): SeatDriftError => {
      try {
        applySeatLogPage(driver, page(drifted));
      } catch (error) {
        return error as SeatDriftError;
      }
      throw new Error("the drifted page was applied");
    })();
    expect(refused).toBeInstanceOf(SeatDriftError);
    expect(refused.reason).toBe("schema-epoch");
    expect(refused.recovery).toBe("rebootstrap");
    // Nothing landed: the row IN FRONT of the drifted one is not applied
    // either, or the seat would be left at a cursor its file does not match.
    expect(driver.all(`SELECT note_id FROM note`)).toStrictEqual([]);
    expect(readSeatState(driver).appliedSeq).toBe(10);
    driver.close();
  });

  it("refuses a page from another epoch or another vault", () => {
    nextSeq = 10;
    const driver = seat();
    expect(() =>
      applySeatLogPage(driver, page([insertNote("n1", "x")], { epoch: "e2" }))
    ).toThrow(/epoch e2/u);
    expect(() =>
      applySeatLogPage(
        driver,
        page([insertNote("n2", "x")], { vaultId: "other" })
      )
    ).toThrow(/vault other/u);
    driver.close();
  });

  it("applies a ddl row as DDL and carries the file to its version", () => {
    nextSeq = 10;
    const driver = seat();
    applySeatLogPage(
      driver,
      page([
        row({
          table: "note",
          op: "ddl",
          ddlVersion: 1,
          pk: ["note"],
          row: { sql: "ALTER TABLE note ADD COLUMN pinned INTEGER" },
        }),
      ])
    );
    expect(readSeatState(driver).ddlVersion).toBe(1);
    driver.run(
      `INSERT INTO note (note_id, title, pinned) VALUES ('n1', 't', 1)`
    );
    driver.close();
  });

  it("stops at an over-threshold commit rather than stepping over it", () => {
    nextSeq = 10;
    const driver = seat();
    const big = [
      { ...insertNote("n1", "big"), deferred: true as const },
      { ...insertNote("n2", "big"), deferred: true as const },
    ];
    const after = insertNote("n3", "small", 101);
    const result = applySeatLogPage(driver, page([...big, after]), {
      deferOverThreshold: true,
    });
    expect(result.deferred).toBe(2);
    expect(result.applied).toBe(0);
    expect(result.deferredFrom).toBe(big[0]!.seq);
    // NOTHING BEHIND THE SPAN EITHER (#1014, C1). The cursor used to jump to
    // the deferred commit's last seq, and rule 3 then dropped those rows on
    // every later delivery — the span was permanently absent from a seat that
    // reported itself up to date. The cursor stays before it instead.
    expect(driver.all(`SELECT note_id FROM note`)).toStrictEqual([]);
    expect(readSeatState(driver).appliedSeq).toBe(10);
    expect(readSeatState(driver).deferredFrom).toBe(big[0]!.seq);
    driver.close();
  });

  it("applies the owed span on the next pull once the seat is not metered", () => {
    nextSeq = 10;
    const driver = seat();
    const big = [
      { ...insertNote("n1", "big"), deferred: true as const },
      { ...insertNote("n2", "big"), deferred: true as const },
    ];
    const after = insertNote("n3", "small", 101);
    const spans = page([...big, after]);
    applySeatLogPage(driver, spans, { deferOverThreshold: true });
    expect(seatWatermark(readSeatState(driver)).behind).toBeGreaterThan(0);

    // Wifi. The seat asks from the same position and takes the whole thing.
    const result = applySeatLogPage(driver, spans);
    expect(result.applied).toBe(3);
    expect(result.deferred).toBe(0);
    expect(
      driver.all(`SELECT note_id FROM note ORDER BY note_id`)
    ).toStrictEqual([{ note_id: "n1" }, { note_id: "n2" }, { note_id: "n3" }]);
    const state = readSeatState(driver);
    expect(state.appliedSeq).toBe(after.seq);
    // And the flag the member was shown goes with the rows.
    expect(state.deferredFrom).toBeUndefined();
    expect(seatWatermarkLine(seatWatermark(state))).toBe("up to date");
    driver.close();
  });

  it("never defers a commit that carries schema", () => {
    nextSeq = 10;
    const driver = seat();
    // A ddl row is not bytes the member can wait for: every later row binds
    // against the column it adds (#1014, C2). Deferring this wedged the seat
    // with a bare SQLite error the loop could not recognise as drift.
    const result = applySeatLogPage(
      driver,
      page([
        {
          ...row({
            table: "note",
            op: "ddl",
            ddlVersion: 1,
            pk: ["note"],
            row: { sql: "ALTER TABLE note ADD COLUMN pinned INTEGER" },
          }),
          deferred: true as const,
        },
      ]),
      { deferOverThreshold: true }
    );
    expect(result.deferred).toBe(0);
    expect(result.ddl).toBe(1);
    expect(readSeatState(driver).ddlVersion).toBe(1);
    // The column is really there, so the rows that follow it bind.
    driver.run(
      `INSERT INTO note (note_id, title, pinned) VALUES ('n1', 't', 1)`
    );
    driver.close();
  });

  it("takes the same commit when the seat is not metered", () => {
    nextSeq = 10;
    const driver = seat();
    const result = applySeatLogPage(
      driver,
      page([{ ...insertNote("n1", "big"), deferred: true as const }])
    );
    expect(result.deferred).toBe(0);
    expect(result.applied).toBe(1);
    expect(readSeatState(driver).deferredFrom).toBeUndefined();
    driver.close();
  });

  it("rolls a failing commit back whole, cursor included", () => {
    nextSeq = 10;
    const driver = seat();
    const good = insertNote("n1", "fine");
    const bad = row({
      table: "note",
      op: "insert",
      commitSeq: 101,
      pk: ["n2"],
      // `title` is NOT NULL: the second commit cannot land.
      row: {
        note_id: "n2",
        title: null,
        body: null,
        row_version: 1,
        cover: null,
        bytes: null,
      },
    });
    expect(() => applySeatLogPage(driver, page([good, bad]))).toThrow(
      /NOT NULL/u
    );
    // The first commit is durable, the second left nothing, and the cursor
    // names the last commit that actually landed.
    expect(driver.all(`SELECT note_id FROM note`)).toStrictEqual([
      { note_id: "n1" },
    ]);
    expect(readSeatState(driver).appliedSeq).toBe(good.seq);
    driver.close();
  });

  it("applies a composite key and reports the gateway head from an empty page", () => {
    nextSeq = 10;
    const driver = seat();
    applySeatLogPage(
      driver,
      page([
        row({
          table: "tag",
          op: "insert",
          pk: ["n1", "red"],
          row: { note_id: "n1", label: "red" },
        }),
      ])
    );
    expect(driver.all(`SELECT * FROM tag`)).toStrictEqual([
      { note_id: "n1", label: "red" },
    ]);
    const empty = applySeatLogPage(driver, page([], { watermark: 5_000 }));
    expect(empty.gatewayWatermark).toBe(5_000);
    expect(readSeatState(driver).gatewayWatermark).toBe(5_000);
    driver.close();
  });

  it("notifies the shell once per batch, naming the tables it must re-read", () => {
    nextSeq = 10;
    const driver = seat();
    const notices: string[][] = [];
    applySeatLogPage(
      driver,
      page([
        insertNote("n1", "a"),
        row({
          table: "tag",
          op: "insert",
          commitSeq: 101,
          pk: ["n1", "red"],
          row: { note_id: "n1", label: "red" },
        }),
      ]),
      { onChange: (notice) => notices.push([...notice.tables]) }
    );
    expect(notices).toStrictEqual([["note", "tag"]]);
    driver.close();
  });
});
