import type { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  AUDIT_APPEND_ONLY_TABLES,
  AUDIT_BAND_TABLES,
  RETENTION_WINDOWS,
} from "./audit.js";
import { baselineVault, columnsOf, onDeleteOf } from "./baseline-fixture.js";
import { LEDGER_BAND_TABLES } from "./ledger.js";
import { LOCAL_TABLES } from "./local-tables.js";
import { listVaultEntities } from "./tables.js";

const NOW = "2026-01-01T00:00:00.000Z";

function seedInvocation(db: DatabaseSync, id = "inv-1"): string {
  db.prepare(
    `INSERT INTO agent_command_invocation
       (invocation_id, command_id, caller_id, grant_id, input_json, status,
        requested_at)
     VALUES (?, 'cmd', 'owner', NULL, '{}', 'proposed', ?)`
  ).run(id, NOW);
  return id;
}

function seedReceipt(db: DatabaseSync, id = "rcpt-1"): string {
  db.prepare(
    `INSERT INTO access_receipt
       (receipt_id, grant_id, invocation_id, action, object_type, object_id,
        purpose_concept_id, decision, occurred_at, hash, seq)
     VALUES (?, NULL, NULL, 'core.create_party', 'core.party', 'p1', NULL,
             'allow', ?, ?, 1)`
  ).run(id, NOW, `hash-${id}`);
  return id;
}

describe("the audit band is append-only in the engine, not by convention", () => {
  it("refuses UPDATE and DELETE on every write-once table", () => {
    const db = baselineVault();
    seedReceipt(db);
    expect(() =>
      db
        .prepare(
          `UPDATE access_receipt SET decision = 'deny' WHERE receipt_id = 'rcpt-1'`
        )
        .run()
    ).toThrow(/append-only/u);
    expect(() =>
      db.prepare(`DELETE FROM access_receipt WHERE receipt_id = 'rcpt-1'`).run()
    ).toThrow(/append-only/u);
    const triggers = new Set(
      (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
          .all() as { name: string }[]
      ).map((r) => r.name)
    );
    for (const table of AUDIT_APPEND_ONLY_TABLES) {
      expect(triggers.has(`${table}_append_only_u`), table).toBe(true);
      expect(triggers.has(`${table}_append_only_d`), table).toBe(true);
    }
  });

  it("lets an invocation settle, and still refuses a rewrite of what was asked", () => {
    const db = baselineVault();
    seedInvocation(db);
    const receiptId = seedReceipt(db);
    expect(() =>
      db
        .prepare(
          `UPDATE agent_command_invocation
              SET status = 'executed', executed_at = ?, receipt_id = ?
            WHERE invocation_id = 'inv-1'`
        )
        .run(NOW, receiptId)
    ).not.toThrow();
    expect(() =>
      db
        .prepare(
          `UPDATE agent_command_invocation SET input_json = '{"tampered":1}'
            WHERE invocation_id = 'inv-1'`
        )
        .run()
    ).toThrow(/append-only in what was asked/u);
    expect(() =>
      db
        .prepare(
          `DELETE FROM agent_command_invocation WHERE invocation_id = 'inv-1'`
        )
        .run()
    ).toThrow(/append-only/u);
  });

  it("opens the archive door only inside the pass, and closes it after", () => {
    const db = baselineVault();
    seedReceipt(db);
    db.exec("BEGIN");
    db.exec("INSERT INTO audit_archive_pass (active) VALUES (1)");
    expect(() =>
      db.prepare(`DELETE FROM access_receipt WHERE receipt_id = 'rcpt-1'`).run()
    ).not.toThrow();
    db.exec("DELETE FROM audit_archive_pass");
    db.exec("COMMIT");
    seedReceipt(db, "rcpt-2");
    expect(() =>
      db.prepare(`DELETE FROM access_receipt WHERE receipt_id = 'rcpt-2'`).run()
    ).toThrow(/append-only/u);
  });

  it("rolls a mutation and its receipt back together — one file, one transaction", () => {
    const db = baselineVault();
    db.exec("BEGIN");
    db.prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at)
       VALUES ('p1', 'person', 'Ravi', ?, ?)`
    ).run(NOW, NOW);
    seedReceipt(db);
    db.exec("ROLLBACK");
    expect(
      db.prepare(`SELECT 1 FROM core_party WHERE party_id = 'p1'`).get()
    ).toBeUndefined();
    expect(
      db
        .prepare(`SELECT 1 FROM access_receipt WHERE receipt_id = 'rcpt-1'`)
        .get()
    ).toBeUndefined();
  });

  it("makes a revision name its invocation, and outlive it", () => {
    const db = baselineVault();
    expect(columnsOf(db, "core_entity_revision")).toContain("invocation_id");
    expect(onDeleteOf(db, "core_entity_revision", "invocation_id")).toBe(
      "SET NULL"
    );
  });
});

describe("both bands are excluded from what leaves the device", () => {
  it("excludes audit and ledger BY BAND, from the export walk and the replica", () => {
    const registered = new Set(
      listVaultEntities().map((logical) => logical.replace(".", "_"))
    );
    for (const table of [...AUDIT_BAND_TABLES, ...LEDGER_BAND_TABLES]) {
      expect(registered.has(table), `${table} is in the canonical walk`).toBe(
        false
      );
      expect(LOCAL_TABLES.has(table), `${table} has no exclusion reason`).toBe(
        true
      );
    }
  });

  it("declares each band's retention window in exactly one place", () => {
    expect(RETENTION_WINDOWS.audit.days).toBeGreaterThan(0);
    expect(RETENTION_WINDOWS.ledger.days).toBeGreaterThan(0);
    expect(Object.keys(RETENTION_WINDOWS).sort()).toStrictEqual([
      "audit",
      "ledger",
    ]);
  });
});
