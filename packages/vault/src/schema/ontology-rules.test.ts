// What a FRESH vault is, after #916 closed the v0 ontology's last
// inconsistencies — the REVIEW'S NUMBERED RULES (brief R1–R13): the
// constraints, keys and indexes each rule asked the schema to state.
//
// Every assertion here reads the composed BASELINE — the DDL modules
// themselves — rather than a file walked forward through a ladder. v0 has no
// files in the field, so a shape the baseline can simply state does not need a
// rung that reconstructs it, and a test that walks a rung to find out what the
// vault is would be testing the reconstruction instead of the decision.
//
// Split from `ontology-shape.test.ts` by concern, not by size: that file holds
// the owner decisions (D1–D4) and their end-to-end effects (E1–E3); a rule
// here is a sentence the engine itself refuses to break.

import { describe, expect, it } from "vitest";

import {
  BASELINE_NOW as NOW,
  baselineVault,
  columnsOf,
  indexesOf,
  onDeleteOf,
  party,
  tableSql,
  vaultRow,
} from "./baseline-fixture.js";

describe("R1 — money says which money", () => {
  it("puts a currency on the group, the expense and the settlement", () => {
    const db = baselineVault();
    for (const t of ["tally_group", "tally_expense", "tally_settlement"])
      expect(columnsOf(db, t)).toContain("currency");
    // The shares are shares OF the expense's amount and carry no currency.
    for (const t of [
      "tally_expense_split",
      "tally_expense_payer",
      "tally_expense_line_item",
    ])
      expect(columnsOf(db, t)).not.toContain("currency");
  });

  it("refuses an expense in a currency its group does not use", () => {
    const db = baselineVault();
    party(db, "p1");
    db.prepare(
      `INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
       VALUES ('c1', 'p1', 'C', 'custom')`
    ).run();
    db.prepare(
      `INSERT INTO tally_group (group_id, circle_id, icon, color, currency, created_at, updated_at)
       VALUES ('g1', 'c1', 'i', '#000', 'EUR', ?, ?)`
    ).run(NOW, NOW);
    const insert = (currency: string): void => {
      db.prepare(
        `INSERT INTO tally_expense (expense_id, group_id, description, amount_minor, currency, paid_by, spent_on, category, created_at, updated_at)
         VALUES (?, 'g1', 'd', 100, ?, 'p1', ?, 'general', ?, ?)`
      ).run(`e-${currency}`, currency, NOW, NOW, NOW);
    };
    expect(() => insert("USD")).toThrow(/group's currency/u);
    expect(() => insert("EUR")).not.toThrow();
  });
});

describe("R2 — the constraints that were missing", () => {
  it("refuses a settlement from someone to themselves", () => {
    const db = baselineVault();
    party(db, "p1");
    expect(() =>
      db
        .prepare(
          `INSERT INTO tally_settlement (settlement_id, group_id, from_party, to_party, amount_minor, currency, paid_on, created_at, updated_at)
           VALUES ('s1', NULL, 'p1', 'p1', 100, 'EUR', ?, ?, ?)`
        )
        .run(NOW, NOW, NOW)
    ).toThrow(/CHECK/u);
  });

  it("makes the recurring template a reference that end-dates its instances", () => {
    const db = baselineVault();
    expect(onDeleteOf(db, "tally_expense", "recurring_template_id")).toBe(
      "SET NULL"
    );
  });

  it("allows one LIVE edge per (from, to, relation)", () => {
    const db = baselineVault();
    party(db, "p1");
    party(db, "p2");
    db.prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version) VALUES ('s1','urn:s','S','1')`
    ).run();
    db.prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json)
       VALUES ('c1','s1','knows','Knows','[]')`
    ).run();
    const link = (id: string): void => {
      db.prepare(
        `INSERT INTO core_link (link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_from, asserted_by)
         VALUES (?, 'core.party', 'p1', 'core.party', 'p2', 'c1', ?, 'owner')`
      ).run(id, NOW);
    };
    link("l1");
    expect(() => link("l2")).toThrow(/UNIQUE/u);
    // History repeats: an end-dated edge leaves the constraint.
    db.prepare(`UPDATE core_link SET valid_to = ? WHERE link_id = 'l1'`).run(
      NOW
    );
    expect(() => link("l3")).not.toThrow();
  });

  it("holds a zoned event to a zone and a UTC instant", () => {
    const db = baselineVault();
    const event = (
      id: string,
      semantics: string,
      tz: string | null,
      start: string
    ): void => {
      db.prepare(
        `INSERT INTO core_event (event_id, summary, dtstart, start_tz, recurrence_semantics, status, sequence, created_at, updated_at)
         VALUES (?, 's', ?, ?, ?, 'confirmed', 0, ?, ?)`
      ).run(id, start, tz, semantics, NOW, NOW);
    };
    expect(() => event("e1", "zoned", null, NOW)).toThrow(/CHECK/u);
    expect(() =>
      event("e2", "zoned", "Europe/Berlin", "2026-09-02T10:00:00")
    ).toThrow(/CHECK/u);
    expect(() => event("e3", "zoned", "Europe/Berlin", NOW)).not.toThrow();
    expect(() =>
      event("e4", "floating", null, "2026-09-02T10:00:00")
    ).not.toThrow();
  });

  it("refuses a transaction whose amount carries the sign", () => {
    const db = baselineVault();
    party(db, "p1");
    db.prepare(
      `INSERT INTO core_account (account_id, owner_party_id, name, kind, currency, is_asset)
       VALUES ('a1','p1','A','cash','EUR',1)`
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO core_transaction (txn_id, account_id, posted_at, amount_minor, currency, direction, status)
           VALUES ('t1','a1',?, -100,'EUR','debit','posted')`
        )
        .run(NOW)
    ).toThrow(/CHECK/u);
  });
});

describe("R3 — a natural key is a claim about now", () => {
  it("lets a retired identifier be re-issued to someone else", () => {
    const db = baselineVault();
    party(db, "p1");
    party(db, "p2");
    const ident = (
      id: string,
      party_: string,
      validTo: string | null
    ): void => {
      db.prepare(
        `INSERT INTO core_party_identifier (identifier_id, party_id, scheme, value, is_primary, valid_from, valid_to)
         VALUES (?, ?, 'handle', '@same', 0, ?, ?)`
      ).run(id, party_, NOW, validTo);
    };
    ident("i1", "p1", null);
    expect(() => ident("i2", "p2", null)).toThrow(/UNIQUE/u);
    db.prepare(
      `UPDATE core_party_identifier SET valid_to = ? WHERE identifier_id = 'i1'`
    ).run(NOW);
    expect(() => ident("i3", "p2", null)).not.toThrow();
  });
});

describe("R4 — one name for a zone column", () => {
  it("spells it tz everywhere a table has exactly one", () => {
    const db = baselineVault();
    expect(columnsOf(db, "schedule_task")).toContain("tz");
    expect(columnsOf(db, "schedule_task")).not.toContain("recurrence_tz");
    expect(columnsOf(db, "tally_recurring_expense")).toContain("tz");
    expect(columnsOf(db, "tally_recurring_expense")).not.toContain("time_zone");
    expect(columnsOf(db, "core_place")).toContain("tz");
    // core_event keeps a PAIR: two zones are a real thing an event can have.
    expect(columnsOf(db, "core_event")).toStrictEqual(
      expect.arrayContaining(["start_tz", "end_tz"])
    );
  });
});

describe("R5/R6 — an occurrence is identified by its own wall clock", () => {
  it("keys the exception on the series-local start and its semantics", () => {
    const db = baselineVault();
    const cols = columnsOf(db, "schedule_recurrence_exception");
    expect(cols).toContain("original_start_local");
    expect(cols).toContain("recurrence_semantics");
    expect(cols).not.toContain("original_start");
    expect(tableSql(db, "schedule_recurrence_exception")).toContain(
      "UNIQUE (target_type, target_id, original_start_local, scope)"
    );
  });

  it("puts the overriding occurrence's attendees in rows", () => {
    const db = baselineVault();
    expect(
      columnsOf(db, "schedule_recurrence_exception_attendee")
    ).toStrictEqual(["exception_id", "party_id", "created_at", "updated_at"]);
    expect(
      onDeleteOf(db, "schedule_recurrence_exception_attendee", "exception_id")
    ).toBe("CASCADE");
  });
});

describe("R7 — one live answer per question", () => {
  it("drops duration from the live-answer key", () => {
    const db = baselineVault();
    const sql = (
      db
        .prepare(
          `SELECT sql FROM sqlite_master WHERE name = 'share_authority_live_answer'`
        )
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain("verb");
    expect(sql).not.toContain("duration");
  });
});

describe("R9 — a binding is about someone else", () => {
  it("refuses this vault and this vault's own party", () => {
    const db = baselineVault();
    party(db, "self");
    party(db, "other");
    vaultRow(db, "self");
    const bind = (id: string, partyId: string, vaultId: string): void => {
      db.prepare(
        `INSERT INTO share_party_vault_binding (binding_id, party_id, vault_id, linked_at)
         VALUES (?, ?, ?, ?)`
      ).run(id, partyId, vaultId, NOW);
    };
    expect(() => bind("b1", "self", "v2")).toThrow(/never this vault/u);
    expect(() => bind("b2", "other", "v1")).toThrow(/never this vault/u);
    expect(() => bind("b3", "other", "v2")).not.toThrow();
  });
});

describe("R10 — one encoding of which entity", () => {
  it("gives the scope and the policy a single dotted column", () => {
    const db = baselineVault();
    for (const t of [
      "access_grant_scope",
      "access_policy",
      "access_scope_tombstone",
    ]) {
      expect(columnsOf(db, t)).toContain("entity");
      expect(columnsOf(db, t)).not.toContain("schema_name");
      expect(columnsOf(db, t)).not.toContain("applies_schema");
    }
    // enrich_policy_rule keeps scope_type: a CASCADE LEVEL, not an entity.
    expect(columnsOf(db, "enrich_policy_rule")).toContain("scope_type");
  });
});

describe("R11 — the trash reaches search", () => {
  it("gives the two trash entities that lacked one a delete trigger", () => {
    const db = baselineVault();
    // The trash reaches the index through the generated update trigger, which
    // is the only place a spec's `deletedColumn` can show up.
    for (const table of ["tally_expense", "people_profile"]) {
      const sql = (
        db
          .prepare(
            `SELECT group_concat(sql, ';') AS sql FROM sqlite_master
              WHERE type = 'trigger' AND tbl_name = ?`
          )
          .get(table) as { sql: string | null }
      ).sql;
      expect(sql, `${table}: a trigger family`).toContain("CREATE TRIGGER");
      expect(sql, `${table}: the trash reaches search`).toContain("deleted_at");
    }
  });
});

describe("R12 — the indexes the hot reads wanted", () => {
  it("indexes place coordinates, event start and task due date", () => {
    const db = baselineVault();
    expect(indexesOf(db, "core_place")).toContain("core_place_coords_idx");
    expect(indexesOf(db, "core_event")).toContain("core_event_dtstart_idx");
    expect(indexesOf(db, "schedule_task")).toContain(
      "schedule_task_due_at_idx"
    );
  });
});

describe("R13 — the receipt chain says its own order", () => {
  it("carries seq beside the hash", () => {
    expect(columnsOf(baselineVault(), "access_receipt")).toContain("seq");
  });
});
