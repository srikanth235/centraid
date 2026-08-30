// governance: allow-repo-hygiene file-size-limit one rung's losslessness proof is one fixture plus the landings it must produce; splitting them lets the two drift
// Issue #883 rung seven: the ontology reconciliation, on a vault stamped
// before it. The v6 shape is spelled out here rather than reconstructed from
// the current DDL — the point of the test is a file this build did NOT
// create — and `migrate()` starts at user_version 6, so the baseline (which
// needs openVaultDb's custom SQL functions) never runs.
//
// The claim under test is LOSSLESSNESS, and it is asserted the way that means
// something: for each store the rung retires, the WHOLE landed table is
// compared against the whole expectation, so a row the rung silently dropped
// fails here rather than vanishing.
//
// Two fixture groups are deliberately minimal: the twelve trigger-only tables,
// where the primary key and `updated_at` ARE the shape under test, and the ten
// home/business tables, which the ruling drops whole.
import { DatabaseSync } from "node:sqlite";

import { describe, expect, test } from "vitest";

import { migrate, VAULT_MIGRATIONS } from "./migrate.js";

/** The tables rung seven only touches to install an `updated_at` trigger. */
const TRIGGER_ONLY_TABLES: readonly (readonly [string, string])[] = [
  ["core_document", "document_id"],
  ["knowledge_note", "note_id"],
  ["locker_item", "item_id"],
  ["locker_item_field", "field_id"],
  ["locker_item_passkey", "item_id"],
  ["locker_auth_credential", "credential_id"],
  ["schedule_project", "project_id"],
  ["schedule_section", "section_id"],
  ["tally_recurring_expense", "template_id"],
];

const DROPPED_DOMAIN_TABLES = [
  "home_asset_item",
  "home_warranty",
  "home_maintenance_plan",
  "home_utility_meter",
  "home_meter_reading",
  "business_client",
  "business_project",
  "business_time_entry",
  "business_invoice",
  "business_invoice_line",
] as const;

const V6_RECONCILE_DDL = `
CREATE TABLE core_party (
  party_id     TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE TABLE core_party_identifier (
  identifier_id TEXT PRIMARY KEY,
  party_id      TEXT NOT NULL REFERENCES core_party(party_id),
  scheme        TEXT NOT NULL CHECK (scheme IN ('email','tel','url','did','handle','iban','other')),
  value         TEXT NOT NULL,
  label         TEXT,
  is_primary    INTEGER NOT NULL CHECK (is_primary IN (0,1)),
  verified_at   TEXT,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  UNIQUE (scheme, value)
) STRICT;
CREATE UNIQUE INDEX idx_party_identifier_primary
  ON core_party_identifier(party_id, scheme) WHERE is_primary = 1;
CREATE TABLE social_contact_channel (
  channel_id       TEXT PRIMARY KEY,
  party_id         TEXT NOT NULL REFERENCES core_party(party_id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('phone','email','address','handle')),
  label            TEXT,
  value            TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  is_preferred     INTEGER NOT NULL DEFAULT 0 CHECK (is_preferred IN (0,1)),
  provenance_json  TEXT CHECK (provenance_json IS NULL OR json_valid(provenance_json)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (party_id, kind, normalized_value)
) STRICT;
CREATE UNIQUE INDEX social_contact_channel_preferred_idx
  ON social_contact_channel(party_id, kind) WHERE is_preferred = 1;
CREATE TABLE social_contact_card (
  card_id   TEXT PRIMARY KEY,
  party_id  TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  nickname  TEXT,
  org_title TEXT,
  vcard_rev TEXT,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE people_profile (
  profile_id        TEXT PRIMARY KEY,
  party_id          TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  role              TEXT,
  avatar_color      TEXT,
  cadence_days      INTEGER NOT NULL CHECK (cadence_days >= 0),
  last_contacted_at TEXT,
  met               TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT,
  purge_at          TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL)
) STRICT;

CREATE TABLE core_content_item (
  content_id TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE core_attachment (
  attachment_id TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  content_id    TEXT NOT NULL REFERENCES core_content_item(content_id),
  role          TEXT NOT NULL CHECK (role IN ('photo','manual','receipt','warranty','contract','embed','other')),
  is_primary    INTEGER NOT NULL CHECK (is_primary IN (0,1)),
  created_at    TEXT NOT NULL
) STRICT;
CREATE TABLE core_collection_entry (
  entry_id      TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL
) STRICT;
CREATE TABLE core_link (
  link_id   TEXT PRIMARY KEY,
  from_type TEXT NOT NULL,
  from_id   TEXT NOT NULL,
  to_type   TEXT NOT NULL,
  to_id     TEXT NOT NULL
) STRICT;
CREATE TABLE social_message (
  message_id TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  sent_at    TEXT
) STRICT;
CREATE TABLE core_transaction (
  txn_id       TEXT PRIMARY KEY,
  amount_minor INTEGER NOT NULL,
  currency     TEXT NOT NULL
) STRICT;

CREATE TABLE core_event (
  event_id   TEXT PRIMARY KEY,
  summary    TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE schedule_task (
  task_id     TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  parent_task_id TEXT REFERENCES schedule_task(task_id)
) STRICT;
CREATE TABLE schedule_recurrence_exception (
  exception_id  TEXT PRIMARY KEY,
  target_type   TEXT NOT NULL CHECK (target_type IN ('core.event','tally.recurring_expense')),
  target_id     TEXT NOT NULL,
  original_start TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'occurrence'
    CHECK (scope IN ('occurrence','future')),
  action        TEXT NOT NULL CHECK (action IN ('skip','override')),
  override_json TEXT CHECK (
    (action = 'skip' AND override_json IS NULL)
    OR (action = 'override' AND override_json IS NOT NULL AND json_valid(override_json))
  ),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (target_type, target_id, original_start, scope)
) STRICT;

CREATE TABLE tally_expense (
  expense_id   TEXT PRIMARY KEY,
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  paid_by      TEXT NOT NULL REFERENCES core_party(party_id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE TABLE tally_expense_payer (
  expense_id  TEXT NOT NULL REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  paid_minor  INTEGER NOT NULL CHECK (paid_minor >= 0),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (expense_id, party_id)
) STRICT;
CREATE TABLE tally_expense_receipt (
  receipt_id  TEXT PRIMARY KEY,
  expense_id  TEXT NOT NULL UNIQUE REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  content_id  TEXT NOT NULL UNIQUE REFERENCES core_content_item(content_id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) STRICT;
CREATE TABLE tally_expense_line_item (
  line_item_id TEXT PRIMARY KEY,
  expense_id   TEXT NOT NULL REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  receipt_id   TEXT REFERENCES tally_expense_receipt(receipt_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('item','tax','tip')),
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  sort_order   INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;
CREATE TABLE tally_expense_line_allocation (
  line_item_id TEXT NOT NULL REFERENCES tally_expense_line_item(line_item_id) ON DELETE CASCADE,
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  share_minor  INTEGER NOT NULL CHECK (share_minor >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (line_item_id, party_id)
) STRICT;

${TRIGGER_ONLY_TABLES.map(
  ([table, pk]) => `CREATE TABLE ${table} (
  ${pk}      TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL
) STRICT;`
).join("\n")}

${DROPPED_DOMAIN_TABLES.map(
  (table) => `CREATE TABLE ${table} (
  id         TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL
) STRICT;`
).join("\n")}
-- The guard trigger home.* installed on a table that SURVIVES the drop. If the
-- rung forgot it, the next write to core_transaction would fail at runtime with
-- "no such table: home_asset_item" — long after the migration reported success.
CREATE TRIGGER home_asset_bound_transaction_guard
BEFORE UPDATE OF amount_minor, currency ON core_transaction
WHEN EXISTS (SELECT 1 FROM home_asset_item i WHERE i.id = OLD.txn_id)
BEGIN
  SELECT RAISE(ABORT, 'transaction is bound to an asset purchase read model');
END;
`;

/*
 * Every shape the rung can be handed, once each.
 *
 * Reachability (O-contact): a plain email identifier; a phone identifier
 * written with separators, so the normalization is under test; a PRIMARY
 * identifier, which must claim the empty preferred slot; an EXPIRED one, which
 * must land without claiming it; one that duplicates a channel the party
 * already has, which must NOT be written twice; and a `url` identity key,
 * which must stay in the register the narrowed CHECK still accepts.
 *
 * The card (O-contact): one party whose profile has no role, so the card's
 * org_title fills it, and one whose profile already has a role, so the profile
 * wins and the nickname still lands.
 *
 * Receipts (O-attach): one receipt whose attachment `add_receipt_expense`
 * already wrote — the line items must repoint at THAT row, not a second one —
 * and one from before the command wrote attachments at all, whose attachment is
 * minted carrying the receipt's own id. Plus a typed line with NO receipt,
 * the by-line division that never had a photo.
 *
 * Payers (O-payers): one expense with declared payers, which must not move, and
 * one with none, which the backfill gives the degenerate single-payer row the
 * deleted read-time fallback used to invent on every read.
 */
function seedV6Vault(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(V6_RECONCILE_DDL);
  db.exec("PRAGMA user_version = 6");
  db.exec(`
INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at) VALUES
  ('party-owner', 'person', 'Owner', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
  ('party-ravi', 'person', 'Ravi', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
  ('party-mei', 'person', 'Mei', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');

INSERT INTO people_profile
  (profile_id, party_id, role, cadence_days, created_at, updated_at) VALUES
  ('profile-ravi', 'party-ravi', NULL, 30, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'),
  ('profile-mei', 'party-mei', 'Neighbour', 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');

INSERT INTO social_contact_card (card_id, party_id, nickname, org_title, vcard_rev, updated_at) VALUES
  ('card-ravi', 'party-ravi', 'Rav', 'Acme · Eng lead', '2025-02-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z'),
  ('card-mei', 'party-mei', 'Mei-Mei', 'Bakery owner', '2025-02-02T00:00:00.000Z', '2025-02-02T00:00:00.000Z');

INSERT INTO social_contact_channel
  (channel_id, party_id, kind, label, value, normalized_value, is_preferred,
   provenance_json, created_at, updated_at) VALUES
  ('chan-ravi-email', 'party-ravi', 'email', 'Work', 'ravi@acme.test',
   'ravi@acme.test', 0, NULL, '2025-01-05T00:00:00.000Z', '2025-01-05T00:00:00.000Z');

INSERT INTO core_party_identifier
  (identifier_id, party_id, scheme, value, label, is_primary, verified_at,
   valid_from, valid_to) VALUES
  ('id-ravi-tel', 'party-ravi', 'tel', '+1 (555) 010-2030', 'Mobile', 1, NULL,
   '2025-01-02T00:00:00.000Z', NULL),
  ('id-ravi-email-dup', 'party-ravi', 'email', 'Ravi@Acme.test', 'Work', 0, NULL,
   '2025-01-03T00:00:00.000Z', NULL),
  ('id-mei-email', 'party-mei', 'email', 'MEI@bakery.test', NULL, 1,
   '2025-01-04T00:00:00.000Z', '2025-01-04T00:00:00.000Z', NULL),
  ('id-mei-old-tel', 'party-mei', 'tel', '+15550109999', 'Old', 0, NULL,
   '2024-01-01T00:00:00.000Z', '2024-12-31T00:00:00.000Z'),
  ('id-mei-site', 'party-mei', 'url', 'https://bakery.test', NULL, 1, NULL,
   '2025-01-04T00:00:00.000Z', NULL);

INSERT INTO core_event (event_id, summary, description, created_at, updated_at)
  VALUES ('event-1', 'Standup', 'daily', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
INSERT INTO schedule_task (task_id, title, description) VALUES ('task-1', 'Fix the sink', NULL);

INSERT INTO schedule_recurrence_exception
  (exception_id, target_type, target_id, original_start, scope, action,
   override_json, created_at, updated_at) VALUES
  ('exc-event', 'core.event', 'event-1', '2025-03-01T09:00:00.000Z', 'occurrence',
   'skip', NULL, '2025-02-01T00:00:00.000Z', '2025-02-01T00:00:00.000Z'),
  ('exc-expense', 'tally.recurring_expense', 'template-1', '2025-03-01T00:00:00.000Z',
   'future', 'override', '{"description":"Rent (new)"}', '2025-02-02T00:00:00.000Z',
   '2025-02-02T00:00:00.000Z');

INSERT INTO core_content_item (content_id, sha256, created_at) VALUES
  ('content-new', 'a', '2025-04-01T00:00:00.000Z'),
  ('content-old', 'b', '2025-04-02T00:00:00.000Z');

INSERT INTO tally_expense
  (expense_id, description, amount_minor, paid_by, created_at, updated_at) VALUES
  ('exp-declared', 'Dinner', 4000, 'party-owner', '2025-04-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z'),
  ('exp-materialized', 'Rent', 90000, 'party-ravi', '2025-04-02T00:00:00.000Z', '2025-04-02T00:00:00.000Z'),
  ('exp-old-receipt', 'Groceries', 2500, 'party-mei', '2025-04-03T00:00:00.000Z', '2025-04-03T00:00:00.000Z');

INSERT INTO tally_expense_payer (expense_id, party_id, paid_minor, updated_at) VALUES
  ('exp-declared', 'party-owner', 2500, '2025-04-01T00:00:00.000Z'),
  ('exp-declared', 'party-ravi', 1500, '2025-04-01T00:00:00.000Z');

-- The attachment the capture command already wrote beside the app-local row.
INSERT INTO core_attachment
  (attachment_id, target_type, target_id, content_id, role, is_primary, created_at)
  VALUES ('att-existing', 'tally.expense', 'exp-declared', 'content-new', 'receipt', 1,
          '2025-04-01T00:00:00.000Z');

INSERT INTO tally_expense_receipt (receipt_id, expense_id, content_id, created_at, updated_at) VALUES
  ('receipt-new', 'exp-declared', 'content-new', '2025-04-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z'),
  ('receipt-old', 'exp-old-receipt', 'content-old', '2025-04-03T00:00:00.000Z', '2025-04-03T00:00:00.000Z');

INSERT INTO tally_expense_line_item
  (line_item_id, expense_id, receipt_id, kind, description, amount_minor,
   sort_order, created_at, updated_at) VALUES
  ('line-new', 'exp-declared', 'receipt-new', 'item', 'Pasta', 2000, 0,
   '2025-04-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z'),
  ('line-old', 'exp-old-receipt', 'receipt-old', 'tax', 'VAT', 500, 1,
   '2025-04-03T00:00:00.000Z', '2025-04-03T00:00:00.000Z'),
  ('line-typed', 'exp-materialized', NULL, 'item', 'Utilities', 90000, 0,
   '2025-04-02T00:00:00.000Z', '2025-04-02T00:00:00.000Z');

INSERT INTO tally_expense_line_allocation
  (line_item_id, party_id, share_minor, created_at, updated_at) VALUES
  ('line-new', 'party-owner', 1000, '2025-04-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z'),
  ('line-new', 'party-ravi', 1000, '2025-04-01T00:00:00.000Z', '2025-04-01T00:00:00.000Z'),
  ('line-old', 'party-mei', 500, '2025-04-03T00:00:00.000Z', '2025-04-03T00:00:00.000Z');
`);
}

/** node:sqlite hands back null-prototype rows; `toStrictEqual` compares them. */
function plainRows<T>(rows: readonly T[]): T[] {
  return rows.map((row) => ({ ...row }));
}

function migratedV6(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  seedV6Vault(db);
  migrate(db, VAULT_MIGRATIONS);
  return db;
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(name) !== undefined
  );
}

describe("schema/migrate rung seven (issue #883 ontology reconciliation)", () => {
  test("every reachability identifier lands as a channel, and none twice", () => {
    const db = migratedV6();
    // The whole table, not a spot check: a row the rung dropped fails here.
    expect(
      plainRows(
        db
          .prepare(
            `SELECT channel_id, party_id, kind, label, value, normalized_value,
                    is_preferred
               FROM social_contact_channel
              ORDER BY party_id, kind, normalized_value`
          )
          .all() as Record<string, unknown>[]
      )
    ).toStrictEqual([
      {
        channel_id: "id-mei-email",
        party_id: "party-mei",
        kind: "email",
        label: null,
        value: "MEI@bakery.test",
        normalized_value: "mei@bakery.test",
        is_preferred: 1,
      },
      // Expired: it lands (it is history the member may still want to see) but
      // is never promoted to preferred.
      {
        channel_id: "id-mei-old-tel",
        party_id: "party-mei",
        kind: "phone",
        label: "Old",
        value: "+15550109999",
        normalized_value: "+15550109999",
        is_preferred: 0,
      },
      // The identifier that already had a channel did NOT create a second one;
      // the member's channel is untouched, preferred flag and all.
      {
        channel_id: "chan-ravi-email",
        party_id: "party-ravi",
        kind: "email",
        label: "Work",
        value: "ravi@acme.test",
        normalized_value: "ravi@acme.test",
        is_preferred: 0,
      },
      // Separators stripped, leading + kept — exactly normalizeContactChannel.
      // Primary, and the party had no preferred phone, so it claims the slot.
      {
        channel_id: "id-ravi-tel",
        party_id: "party-ravi",
        kind: "phone",
        label: "Mobile",
        value: "+1 (555) 010-2030",
        normalized_value: "+15550102030",
        is_preferred: 1,
      },
    ]);
    // The expiry is not lost: it rides the provenance the channel carries.
    expect(
      db
        .prepare(
          `SELECT json_extract(provenance_json, '$.valid_to') AS valid_to,
                  json_extract(provenance_json, '$.source') AS source
             FROM social_contact_channel WHERE channel_id = 'id-mei-old-tel'`
        )
        .get()
    ).toMatchObject({
      valid_to: "2024-12-31T00:00:00.000Z",
      source: "core.party_identifier",
    });
    db.close();
  });

  test("the identity register keeps only identity keys, and refuses the fork", () => {
    const db = migratedV6();
    expect(
      plainRows(
        db
          .prepare(
            `SELECT identifier_id, scheme, value FROM core_party_identifier
              ORDER BY identifier_id`
          )
          .all() as Record<string, unknown>[]
      )
    ).toStrictEqual([
      {
        identifier_id: "id-mei-site",
        scheme: "url",
        value: "https://bakery.test",
      },
    ]);
    // Ruling O-contact: the axis is unrepresentable now, not merely unused.
    expect(() =>
      db
        .prepare(
          `INSERT INTO core_party_identifier
             (identifier_id, party_id, scheme, value, is_primary, valid_from)
           VALUES ('id-new', 'party-ravi', 'email', 'x@y.test', 0, '2026-01-01T00:00:00.000Z')`
        )
        .run()
    ).toThrow(/CHECK constraint failed/u);
    db.close();
  });

  test("the contact card's display facts land on the profile, and the card goes", () => {
    const db = migratedV6();
    expect(
      plainRows(
        db
          .prepare(
            `SELECT party_id, role, nickname FROM people_profile ORDER BY party_id`
          )
          .all() as Record<string, unknown>[]
      )
    ).toStrictEqual([
      // The profile already carried a role, so IT wins (the ruling names the
      // profile the one owner) — and the nickname still lands.
      { party_id: "party-mei", role: "Neighbour", nickname: "Mei-Mei" },
      // An empty role takes the card's org/title line.
      { party_id: "party-ravi", role: "Acme · Eng lead", nickname: "Rav" },
    ]);
    expect(tableExists(db, "social_contact_card")).toBe(false);
    db.close();
  });

  test("receipts land on the attachment spine without minting a second row", () => {
    const db = migratedV6();
    expect(
      plainRows(
        db
          .prepare(
            `SELECT attachment_id, target_type, target_id, content_id, role,
                    is_primary, created_at
               FROM core_attachment ORDER BY attachment_id`
          )
          .all() as Record<string, unknown>[]
      )
    ).toStrictEqual([
      {
        attachment_id: "att-existing",
        target_type: "tally.expense",
        target_id: "exp-declared",
        content_id: "content-new",
        role: "receipt",
        is_primary: 1,
        created_at: "2025-04-01T00:00:00.000Z",
      },
      // Minted carrying the receipt's own id, the way rung six carried a grant
      // id: a line item pointing at it resolves without a lookup table.
      {
        attachment_id: "receipt-old",
        target_type: "tally.expense",
        target_id: "exp-old-receipt",
        content_id: "content-old",
        role: "receipt",
        is_primary: 1,
        created_at: "2025-04-03T00:00:00.000Z",
      },
    ]);
    expect(tableExists(db, "tally_expense_receipt")).toBe(false);
    // Every line item survived the child rebuild, and each points at the
    // attachment for its receipt — `line-new` at the PRE-EXISTING one.
    expect(
      plainRows(
        db
          .prepare(
            `SELECT line_item_id, expense_id, receipt_id, kind, amount_minor
               FROM tally_expense_line_item ORDER BY line_item_id`
          )
          .all() as Record<string, unknown>[]
      )
    ).toStrictEqual([
      {
        line_item_id: "line-new",
        expense_id: "exp-declared",
        receipt_id: "att-existing",
        kind: "item",
        amount_minor: 2000,
      },
      {
        line_item_id: "line-old",
        expense_id: "exp-old-receipt",
        receipt_id: "receipt-old",
        kind: "tax",
        amount_minor: 500,
      },
      {
        line_item_id: "line-typed",
        expense_id: "exp-materialized",
        receipt_id: null,
        kind: "item",
        amount_minor: 90000,
      },
    ]);
    // The CASCADE trap: dropping the receipt table would have taken the line
    // items and, through them, every allocation. All three are still here.
    expect(
      plainRows(
        db
          .prepare(
            `SELECT line_item_id, party_id, share_minor
               FROM tally_expense_line_allocation
              ORDER BY line_item_id, party_id`
          )
          .all() as Record<string, unknown>[]
      )
    ).toStrictEqual([
      { line_item_id: "line-new", party_id: "party-owner", share_minor: 1000 },
      { line_item_id: "line-new", party_id: "party-ravi", share_minor: 1000 },
      { line_item_id: "line-old", party_id: "party-mei", share_minor: 500 },
    ]);
    expect(
      db.prepare(`PRAGMA foreign_key_check`).all() as unknown[]
    ).toStrictEqual([]);
    db.close();
  });

  test("every expense carries payer rows, and declared ones do not move", () => {
    const db = migratedV6();
    expect(
      plainRows(
        db
          .prepare(
            `SELECT expense_id, party_id, paid_minor FROM tally_expense_payer
              ORDER BY expense_id, party_id`
          )
          .all() as Record<string, unknown>[]
      )
    ).toStrictEqual([
      // Declared payers are untouched: the backfill only reaches expenses with
      // no payer row at all, so no balance moves.
      { expense_id: "exp-declared", party_id: "party-owner", paid_minor: 2500 },
      { expense_id: "exp-declared", party_id: "party-ravi", paid_minor: 1500 },
      // The rule the deleted read-time fallback applied, made durable.
      {
        expense_id: "exp-materialized",
        party_id: "party-ravi",
        paid_minor: 90000,
      },
      {
        expense_id: "exp-old-receipt",
        party_id: "party-mei",
        paid_minor: 2500,
      },
    ]);
    db.close();
  });

  test("the recurrence exception CHECK admits the finance series, losing nothing", () => {
    const db = migratedV6();
    expect(
      plainRows(
        db
          .prepare(
            `SELECT exception_id, target_type, target_id, scope, action,
                    override_json
               FROM schedule_recurrence_exception ORDER BY exception_id`
          )
          .all() as Record<string, unknown>[]
      )
    ).toStrictEqual([
      {
        exception_id: "exc-event",
        target_type: "core.event",
        target_id: "event-1",
        scope: "occurrence",
        action: "skip",
        override_json: null,
      },
      {
        exception_id: "exc-expense",
        target_type: "tally.recurring_expense",
        target_id: "template-1",
        scope: "future",
        action: "override",
        override_json: '{"description":"Rent (new)"}',
      },
    ]);
    expect(() =>
      db
        .prepare(
          `INSERT INTO schedule_recurrence_exception
             (exception_id, target_type, target_id, original_start, scope,
              action, override_json, created_at, updated_at)
           VALUES ('exc-series', 'finance.recurring_series', 'series-1',
                   '2026-01-01T00:00:00.000Z', 'occurrence', 'skip', NULL,
                   '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`
        )
        .run()
    ).not.toThrow();
    db.close();
  });

  test("Tasks and Agenda gain the trash pair, guard and all", () => {
    const db = migratedV6();
    for (const table of ["schedule_task", "core_event"]) {
      const columns = (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((column) => column.name);
      expect(columns, table).toStrictEqual(
        expect.arrayContaining(["deleted_at", "purge_at"])
      );
    }
    // The same guard every other app's trash pair carries: a purge date with
    // nothing trashed under it is unrepresentable, not merely unwritten.
    expect(() =>
      db
        .prepare(
          `UPDATE schedule_task SET purge_at = '2026-01-01T00:00:00.000Z'
            WHERE task_id = 'task-1'`
        )
        .run()
    ).toThrow(/CHECK constraint failed/u);
    db.close();
  });

  test("a trashed task leaves the search index the moment it is trashed", () => {
    const db = migratedV6();
    expect(
      db.prepare(`SELECT count(*) AS n FROM fts_schedule_task`).get() as unknown
    ).toMatchObject({ n: 1 });
    db.exec(
      `UPDATE schedule_task SET deleted_at = '2026-01-01T00:00:00.000Z' WHERE task_id = 'task-1'`
    );
    expect(
      db.prepare(`SELECT count(*) AS n FROM fts_schedule_task`).get() as unknown
    ).toMatchObject({ n: 0 });
    db.close();
  });

  test("every table the ruling named keeps updated_at honest", () => {
    const db = migratedV6();
    const tables: readonly (readonly [string, string, string])[] = [
      ["core_event", "event_id", "event-1"],
      ["core_party", "party_id", "party-ravi"],
      ["schedule_recurrence_exception", "exception_id", "exc-event"],
      ["social_contact_channel", "channel_id", "chan-ravi-email"],
      ...TRIGGER_ONLY_TABLES.map(
        ([table, pk]) => [table, pk, `${table}-row`] as const
      ),
    ];
    for (const [seeded, seededPk, seededId] of TRIGGER_ONLY_TABLES.map(
      ([table, pk]) => [table, pk, `${table}-row`] as const
    )) {
      db.prepare(
        `INSERT INTO ${seeded} (${seededPk}, updated_at) VALUES (?, '2000-01-01T00:00:00.000Z')`
      ).run(seededId);
    }
    db.exec(
      `UPDATE core_document SET updated_at = '2000-01-01T00:00:00.000Z';
       UPDATE knowledge_note SET updated_at = '2000-01-01T00:00:00.000Z';`
    );
    for (const [table, pk, id] of tables) {
      db.prepare(
        `UPDATE ${table} SET updated_at = '2000-01-01T00:00:00.000Z' WHERE ${pk} = ?`
      ).run(id);
      // A write that does not touch `updated_at` must still move it — that is
      // the whole point of the trigger, and what these thirteen tables lacked.
      db.prepare(`UPDATE ${table} SET ${pk} = ${pk} WHERE ${pk} = ?`).run(id);
      expect(
        db.prepare(`SELECT updated_at FROM ${table} WHERE ${pk} = ?`).get(id),
        table
      ).not.toMatchObject({ updated_at: "2000-01-01T00:00:00.000Z" });
    }
    db.close();
  });

  test("home and business leave the ontology, guard trigger included", () => {
    const db = migratedV6();
    for (const table of DROPPED_DOMAIN_TABLES) {
      expect(tableExists(db, table), table).toBe(false);
    }
    expect(
      db
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'trigger'
            AND name = 'home_asset_bound_transaction_guard'`
        )
        .get()
    ).toBeUndefined();
    // The surviving table it hung off still writes.
    expect(() =>
      db
        .prepare(
          `INSERT INTO core_transaction (txn_id, amount_minor, currency)
           VALUES ('txn-1', 100, 'USD')`
        )
        .run()
    ).not.toThrow();
    db.close();
  });

  test("a non-empty dropped domain REFUSES rather than losing the rows", () => {
    const db = new DatabaseSync(":memory:");
    seedV6Vault(db);
    db.exec(
      `INSERT INTO home_asset_item (id, updated_at) VALUES ('item-1', '2025-01-01T00:00:00.000Z')`
    );
    expect(() => migrate(db, VAULT_MIGRATIONS)).toThrow(/rung seven refuses/u);
    // The refusal rolled the whole rung back: the vault is exactly as it was.
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version
    ).toBe(6);
    expect(tableExists(db, "social_contact_card")).toBe(true);
    expect(tableExists(db, "tally_expense_receipt")).toBe(true);
    db.close();
  });

  test("a card whose party is not in People REFUSES rather than dropping it", () => {
    const db = new DatabaseSync(":memory:");
    seedV6Vault(db);
    db.exec(
      `INSERT INTO social_contact_card (card_id, party_id, nickname, org_title, vcard_rev, updated_at)
       VALUES ('card-owner', 'party-owner', 'Me', 'Sole trader', 'x', '2025-02-03T00:00:00.000Z')`
    );
    expect(() => migrate(db, VAULT_MIGRATIONS)).toThrow(/rung seven refuses/u);
    expect(
      (db.prepare("PRAGMA user_version").get() as { user_version: number })
        .user_version
    ).toBe(6);
    db.close();
  });

  test("the rung leaves no scaffolding behind and is a no-op on replay", () => {
    const db = migratedV6();
    for (const scaffold of [
      "reconcile_receipt",
      "reconcile_line_item",
      "reconcile_line_allocation",
      "reconcile_guard_domain",
      "reconcile_guard_card",
      "core_party_identifier_new",
      "schedule_recurrence_exception_new",
    ]) {
      expect(tableExists(db, scaffold), scaffold).toBe(false);
    }
    const snapshot = () =>
      plainRows(
        db
          .prepare(
            `SELECT channel_id, normalized_value, is_preferred
               FROM social_contact_channel ORDER BY channel_id`
          )
          .all() as Record<string, unknown>[]
      );
    const after = snapshot();
    migrate(db, VAULT_MIGRATIONS);
    expect(snapshot()).toStrictEqual(after);
    db.close();
  });

  test("the four storage indexes exist on a vault that walked the rung", () => {
    const db = migratedV6();
    for (const index of [
      "idx_link_from",
      "idx_link_to",
      "idx_message_thread_sent",
      "idx_collection_entry_target",
    ]) {
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?`
          )
          .get(index),
        index
      ).toMatchObject({ n: 1 });
    }
    db.close();
  });
});
