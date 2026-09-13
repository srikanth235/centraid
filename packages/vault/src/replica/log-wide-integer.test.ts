// A WIDE INTEGER SURVIVES THE CAPTURE (#1020, R-1020-35).
//
// Split out of `log.test.ts` only because that file is at its line ceiling;
// the claim belongs to the same plane.

import { describe, expect, test } from "vitest";

import { openVaultDb } from "../db.js";
import { applyReplicaLog } from "./apply.js";
import { readReplicaLog } from "./log.js";
import { capturedCommit, tableDigest } from "./replica-log.test-fixtures.js";
import type { Sqlite } from "./replica-log.test-fixtures.js";

// A WIDE INTEGER IS CAPTURED, NOT REFUSED (#1020, R-1020-35).
//
// `decodeChangeset` reads each changed row back with a real statement, and
// without `setReadBigInts(true)` `node:sqlite` refuses an INTEGER above 2^53
// with `ERR_OUT_OF_RANGE`. That throw happens inside the capture, inside the
// invocation's transaction, so the whole commit rolls back: the member's write
// is REFUSED, silently, and no wrong number ever appears to show it. A byte
// count reaches that magnitude, and the log's value encoding has carried the
// `{ i: "<decimal>" }` form for exactly this case all along — the producer
// simply could never emit one.
describe("the gateway log - a value wider than a JavaScript number", () => {
  const WIDE = 9_007_199_254_740_993n; // 2^53 + 1, the first inexact integer.

  function insertWideContent(vault: Sqlite, id: string, bytes: bigint): void {
    vault
      .prepare(
        `INSERT INTO core_content_item
           (content_id, content_uri, sha256, byte_size, created_at, updated_at)
         VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z',
                 '2026-01-01T00:00:00.000Z')`
      )
      .run(
        id,
        `file:///${id}`,
        "a".repeat(63) + (id.endsWith("1") ? "1" : "2"),
        bytes
      );
  }

  test("commits, and the log row carries it exactly", () => {
    const db = openVaultDb();
    try {
      // Red before the fix: this threw `ERR_OUT_OF_RANGE` — "Value is too
      // large to be represented as a JavaScript number" — out of
      // `endReplicaCommit`, and `capturedCommit` rolled the row back.
      const captured = capturedCommit(db, "test", (vault) => {
        insertWideContent(vault, "wide-1", WIDE);
      });
      expect(captured).toBeDefined();
      const wideRead = db.vault.prepare(
        `SELECT byte_size AS n FROM core_content_item
         WHERE content_id = 'wide-1'`
      );
      wideRead.setReadBigInts(true);
      expect((wideRead.get() as { n: bigint }).n).toBe(WIDE);
      // The wire image keeps the value as decimal text rather than losing the
      // low bit to a double.
      const page = readReplicaLog(db.vault, { limit: 10 });
      const row = page.rows.find(
        (candidate) => candidate.table === "core_content_item"
      );
      expect(row!.row!["byte_size"]).toStrictEqual({
        i: "9007199254740993",
      });
    } finally {
      db.close();
    }
  });

  test("a replica applying that log row lands the same integer", () => {
    const origin = openVaultDb();
    const seat = openVaultDb();
    try {
      capturedCommit(origin, "test", (vault) => {
        insertWideContent(vault, "wide-2", WIDE);
      });
      const page = readReplicaLog(origin.vault, { limit: 100 });
      applyReplicaLog(seat.vault, page.rows, {
        expectedEpoch: page.rows[0]!.epoch,
      });
      expect(tableDigest(seat.vault, "core_content_item")).toBe(
        tableDigest(origin.vault, "core_content_item")
      );
    } finally {
      seat.close();
      origin.close();
    }
  });
});
