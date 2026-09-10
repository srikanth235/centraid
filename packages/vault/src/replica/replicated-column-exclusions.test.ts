// WHAT REPLICATES BUT NOT WHOLE — THE CANARY (#1014, G14).
//
// `access_receipt` replicates: the Locker access history is built from it on
// the seat. Its `detail_json` therefore travels — but the `output` key inside
// it is the verbatim return value of every command, and nothing on a seat
// reads it. Two paths carry a receipt to a seat and both have to redact:
// the file-copy bootstrap (`buildSeatSnapshot`) and the log capture
// (`captureReplicaCommit`). A canary that only checked one would pass while
// the other shipped the output.
//
// Asserted over the FILE'S BYTES for the snapshot, for the reason
// `seat-snapshot.test.ts` states: a clean catalog proves nothing.

import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { openVaultDb } from "../db.js";
import type { VaultDb } from "../db.js";
import {
  REPLICATED_COLUMN_EXCLUSIONS,
  redactReplicatedRowImage,
} from "../schema/private-tables.js";
import { capturedCommit } from "./replica-log.test-fixtures.js";
import { buildSeatSnapshot, fileContains } from "./seat-snapshot.js";

const OUTPUT_CANARY = "CANARY-1014-command-output-stays-on-the-gateway";
const KEPT_CANARY = "CANARY-1014-locker-access-history-still-reads";

function seedReceipt(db: VaultDb, id: string): void {
  capturedCommit(db, "test", (vault) => {
    vault
      .prepare(
        `INSERT INTO access_receipt
           (receipt_id, action, object_type, object_id, decision,
            occurred_at, hash, detail_json)
         VALUES (?, 'act locker.reveal', 'locker.item', 'i1', 'allow',
                 '2026-01-01T00:00:00.000Z', ?, ?)`
      )
      .run(
        id,
        `hash-${id}`,
        JSON.stringify({
          output: { secret: OUTPUT_CANARY },
          columns: ["password"],
          context: { kind: "reveal", origin: KEPT_CANARY },
        })
      );
  });
}

describe("replicated column exclusions", () => {
  test("the declared exclusions name a replicated table and a JSON column", () => {
    expect(REPLICATED_COLUMN_EXCLUSIONS).toContainEqual({
      table: "access_receipt",
      column: "detail_json",
      jsonKeys: ["output"],
    });
  });

  test("the bootstrap file carries the kept keys and not the output", () => {
    const db = openVaultDb();
    try {
      seedReceipt(db, "r-snapshot");
      const destination = path.join(
        tempDirSync("replicated-exclusions-"),
        "seat.db"
      );
      buildSeatSnapshot(db.vault, destination);
      expect(fileContains(destination, OUTPUT_CANARY)).toBe(false);
      // The redaction is surgical, not a column drop: the Locker access
      // history's own keys have to survive it or a shipped screen goes blank.
      expect(fileContains(destination, KEPT_CANARY)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a captured commit's log row carries the kept keys and not the output", () => {
    const db = openVaultDb();
    try {
      seedReceipt(db, "r-log");
      const row = db.vault
        .prepare(
          `SELECT row_json FROM replica_log
            WHERE "table" = 'access_receipt' ORDER BY seq DESC LIMIT 1`
        )
        .get() as { row_json: string | null } | undefined;
      expect(row?.row_json).toBeTypeOf("string");
      expect(row!.row_json!).not.toContain(OUTPUT_CANARY);
      expect(row!.row_json!).toContain(KEPT_CANARY);
    } finally {
      db.close();
    }
  });

  test("a DELETE image is redacted too — the old row travels whole", () => {
    const db = openVaultDb();
    try {
      seedReceipt(db, "r-delete");
      // The append-only trigger is what makes this unreachable in production,
      // and exactly why the code cannot rely on that: the same decoder serves
      // every table, and the next append-only band to gain a redacted key
      // would arrive with its DELETE path untested.
      const image: Record<string, unknown> = {
        detail_json: JSON.stringify({ output: OUTPUT_CANARY, columns: ["p"] }),
      };
      expect(redactReplicatedRowImage("access_receipt", image)).toBe(true);
      expect(image["detail_json"]).toBe(JSON.stringify({ columns: ["p"] }));
    } finally {
      db.close();
    }
  });

  test("a receipt with no output is left byte-identical", () => {
    const verbatim = JSON.stringify({ columns: ["password"] });
    const image: Record<string, unknown> = { detail_json: verbatim };
    expect(redactReplicatedRowImage("access_receipt", image)).toBe(false);
    expect(image["detail_json"]).toBe(verbatim);
  });

  test("a table with no declared exclusion is never rewritten", () => {
    const image: Record<string, unknown> = { detail_json: '{"output":1}' };
    expect(redactReplicatedRowImage("notifications_notice", image)).toBe(false);
    expect(image["detail_json"]).toBe('{"output":1}');
  });
});
