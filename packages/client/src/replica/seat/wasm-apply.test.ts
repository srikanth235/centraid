// THE SAME PROGRAM, ON THE BROWSER'S SQLite (#996, wave 2).
//
// The applier is written once and has to behave identically on three builds:
// the gateway's 3.50 (`node:sqlite`), the browser's 3.53 (sqlite-wasm) and the
// phone's 3.49 (`SEAT_SQLITE_FLOOR`). Two of those exist in this suite, so two
// of them are checked here — same page, two drivers, byte-identical result —
// rather than asserted in prose and discovered on a member's device.
//
// It is also where the browser's apply RATE is measured. The rate is
// transaction-bound, not row-bound (R5 gives a seat one transaction per COMMIT
// with the cursor inside it), so the measurement below runs both shapes: many
// small commits, and one large one.

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { describe, expect, it } from "vitest";

import { encodeWireValue } from "@centraid/core/protocol";
import type { SeatLogPageWire, SeatLogRowWire } from "@centraid/core/protocol";

import { applySeatLogPage } from "./applier.js";
import { openSeatFile } from "./driver.js";
import type { SeatSqliteDriver } from "./driver.js";
import { NodeSeatDriver } from "./node-seat-driver.js";
import { initSeatState, readSeatState } from "./state.js";
import { WasmSeatDriver } from "./wasm-seat-driver.js";

const SCHEMA = `
CREATE TABLE note (
  note_id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT,
  row_version INTEGER NOT NULL DEFAULT 1, cover BLOB
) STRICT;
`;

async function wasmSeat(): Promise<SeatSqliteDriver> {
  const sqlite3 = await sqlite3InitModule();
  return new WasmSeatDriver(new sqlite3.oo1.DB(":memory:", "c"));
}

function prepare(driver: SeatSqliteDriver): SeatSqliteDriver {
  openSeatFile(driver);
  driver.exec(SCHEMA);
  initSeatState(driver, {
    vaultId: "vault-1",
    epoch: "e1",
    schemaEpoch: 2,
    appliedSeq: 0,
  });
  return driver;
}

function page(rows: SeatLogRowWire[]): SeatLogPageWire {
  return {
    vaultId: "vault-1",
    epoch: "e1",
    schemaEpoch: 2,
    ddlVersion: 0,
    floor: 0,
    watermark: rows.at(-1)?.seq ?? 0,
    next: rows.at(-1)?.seq ?? 0,
    hasMore: false,
    rows,
  };
}

function noteRow(
  seq: number,
  commitSeq: number,
  overrides: Partial<SeatLogRowWire> = {}
): SeatLogRowWire {
  return {
    seq,
    commitSeq,
    schemaEpoch: 2,
    ddlVersion: 0,
    table: "note",
    op: "insert",
    pk: [`n${seq}`],
    row: {
      note_id: `n${seq}`,
      title: `note ${seq}`,
      body: null,
      row_version: 1,
      cover: null,
    },
    producer: "gateway",
    committedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("the applier on the browser's SQLite build", () => {
  it("applies an insert, an update, a delete and a BLOB the same as node:sqlite", async () => {
    const cover = new Uint8Array([0, 1, 250, 255, 128]);
    const rows: SeatLogRowWire[] = [
      noteRow(1, 1),
      noteRow(2, 1, {
        pk: ["n2"],
        row: {
          note_id: "n2",
          title: "with bytes",
          body: null,
          row_version: 1,
          cover: encodeWireValue(cover),
        },
      }),
      noteRow(3, 2, {
        op: "update",
        pk: ["n1"],
        row: {
          note_id: "n1",
          title: "renamed",
          body: "and given a body",
          row_version: 2,
          cover: null,
        },
      }),
      noteRow(4, 3, {
        op: "delete",
        pk: ["n2"],
        row: { note_id: "n2" },
      }),
    ];

    const answers: unknown[] = [];
    const drivers = [prepare(new NodeSeatDriver()), prepare(await wasmSeat())];
    for (const driver of drivers) {
      const result = applySeatLogPage(driver, page(rows));
      answers.push({
        applied: result.applied,
        commitSeqs: [...result.commitSeqs],
        cursor: readSeatState(driver).appliedSeq,
        rows: driver
          .all<{ note_id: string; title: string; body: string | null }>(
            `SELECT note_id, title, body FROM note ORDER BY note_id`
          )
          .map((row) => ({ ...row })),
      });
    }
    // 3.50 and 3.53 agree, statement for statement.
    expect(answers[1]).toStrictEqual(answers[0]);
    expect(answers[0]).toMatchObject({
      applied: 4,
      commitSeqs: [1, 2, 3],
      cursor: 4,
      rows: [{ note_id: "n1", title: "renamed", body: "and given a body" }],
    });
    for (const driver of drivers) driver.close();
  }, 60_000);

  it("refuses a drifted page on the browser build too", async () => {
    const driver = prepare(await wasmSeat());
    expect(() =>
      applySeatLogPage(
        driver,
        page([noteRow(1, 1), noteRow(2, 2, { schemaEpoch: 3 })])
      )
    ).toThrow(/schema epoch 3/u);
    expect(driver.all(`SELECT note_id FROM note`)).toStrictEqual([]);
    driver.close();
  }, 60_000);

  it("applies at a rate that is bound by commits, not by rows", async () => {
    const driver = prepare(await wasmSeat());
    const ROWS = 2_000;
    // One commit per row: the worst shape, and the one R5's per-commit
    // transaction makes expensive on purpose.
    const many = Array.from({ length: ROWS }, (_value, index) =>
      noteRow(index + 1, index + 1)
    );
    const started = performance.now();
    const perCommit = applySeatLogPage(driver, page(many));
    const perCommitMs = performance.now() - started;
    expect(perCommit.applied).toBe(ROWS);

    const second = prepare(await wasmSeat());
    // The same rows in ONE commit: the best shape.
    const one = Array.from({ length: ROWS }, (_value, index) =>
      noteRow(index + 1, 1)
    );
    const startedOne = performance.now();
    const single = applySeatLogPage(second, page(one));
    const oneCommitMs = performance.now() - startedOne;
    expect(single.applied).toBe(ROWS);

    // The claim, not the clock: one transaction per commit is what costs, so
    // 2,000 commits is slower than one commit of 2,000 rows. A ratio rather
    // than a millisecond ceiling, because this runs on whatever the runner is.
    expect(perCommitMs).toBeGreaterThan(oneCommitMs);
    // And both finish: a wasm applier that had fallen off a cliff would not.
    expect(perCommitMs).toBeLessThan(60_000);
    driver.close();
    second.close();
  }, 120_000);
});
