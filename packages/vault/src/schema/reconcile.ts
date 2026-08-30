// governance: allow-repo-hygiene file-size-limit one migration rung is one transaction's worth of ordering constraints
// Rung seven (#883): the ontology reconciliation (docs/decisions.md § Ontology
// reconciliation). Nothing here is in the composed baseline — a fresh file and
// a stamped file both reach the target by walking this rung once, so the
// baseline DDL modules stay BYTE-IDENTICAL and rungs one to six remain
// reproducible for a vault stamped before this build.
// `defer_foreign_keys` is the in-transaction form of `foreign_keys=off`; the
// plain pragma is a no-op inside a transaction and every rung runs in one.

import { ftsDropDdl, ftsEntityDdl } from "./fts.js";
import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

// Child-before-parent: this is also the DROP order.
const DROPPED_DOMAIN_TABLES = [
  "business_invoice_line",
  "business_invoice",
  "business_time_entry",
  "business_project",
  "business_client",
  "home_meter_reading",
  "home_utility_meter",
  "home_maintenance_plan",
  "home_warranty",
  "home_asset_item",
] as const;

const GUARDS_DDL = `
CREATE TEMP TABLE reconcile_guard_domain (what TEXT NOT NULL, rows INTEGER NOT NULL);
CREATE TEMP TRIGGER reconcile_guard_domain_refuse
BEFORE INSERT ON reconcile_guard_domain WHEN NEW.rows > 0
BEGIN
  SELECT RAISE(ABORT, 'issue #883 rung seven refuses: a home.* or business.* table still holds rows. Those domains are dropped by ruling O-domains and their product case moved to proposal #885 — export the rows before upgrading.');
END;
${DROPPED_DOMAIN_TABLES.map(
  (table) =>
    `INSERT INTO reconcile_guard_domain (what, rows) SELECT '${table}', count(*) FROM ${table};`
).join("\n")}
DROP TABLE reconcile_guard_domain;

CREATE TEMP TABLE reconcile_guard_card (what TEXT NOT NULL, rows INTEGER NOT NULL);
CREATE TEMP TRIGGER reconcile_guard_card_refuse
BEFORE INSERT ON reconcile_guard_card WHEN NEW.rows > 0
BEGIN
  SELECT RAISE(ABORT, 'issue #883 rung seven refuses: a social.contact_card row belongs to a party with no people_profile, and ruling O-contact lands the card on the profile. Add the person to People before upgrading.');
END;
INSERT INTO reconcile_guard_card (what, rows)
SELECT 'social_contact_card', count(*) FROM social_contact_card c
 WHERE NOT EXISTS (SELECT 1 FROM people_profile p WHERE p.party_id = c.party_id);
DROP TABLE reconcile_guard_card;
`;

const STORAGE_INDEX_DDL = `
-- core_link is walked from BOTH ends (the relation index alone made every
-- "what points at this row" question a scan). Two indexes, not one composite:
-- an edge is looked up by its from-endpoint or by its to-endpoint, never by
-- both, and a single index on four columns serves only the first of them.
CREATE INDEX IF NOT EXISTS idx_link_from ON core_link(from_type, from_id);
CREATE INDEX IF NOT EXISTS idx_link_to ON core_link(to_type, to_id);
-- A thread renders newest-first inside one thread; without this the read
-- sorted every message this vault holds.
CREATE INDEX IF NOT EXISTS idx_message_thread_sent ON social_message(thread_id, sent_at);
-- Collection membership is asked target-first ("which collections hold this
-- photo?") as often as collection-first, and only the latter had an index.
CREATE INDEX IF NOT EXISTS idx_collection_entry_target
  ON core_collection_entry(target_type, target_id);
`;

// `touchUpdatedAt` is the ONE mechanism; `IF NOT EXISTS` keeps replay a no-op.

const UPDATED_AT_TABLES: readonly (readonly [string, string])[] = [
  ["core_document", "document_id"],
  ["core_event", "event_id"],
  ["core_party", "party_id"],
  ["knowledge_note", "note_id"],
  ["locker_item", "item_id"],
  ["locker_item_field", "field_id"],
  ["locker_item_passkey", "item_id"],
  ["locker_auth_credential", "credential_id"],
  ["schedule_project", "project_id"],
  ["schedule_section", "section_id"],
  ["social_contact_channel", "channel_id"],
  ["tally_recurring_expense", "template_id"],
];

// `schedule_recurrence_exception` gets its trigger after the rebuild below.
function touchIfNotExists(table: string, primaryKey: string): string {
  return touchUpdatedAt(table, primaryKey).replace(
    "CREATE TRIGGER",
    "CREATE TRIGGER IF NOT EXISTS"
  );
}

const UPDATED_AT_DDL = UPDATED_AT_TABLES.map(([table, pk]) =>
  touchIfNotExists(table, pk)
).join("\n");

// O-recur: a CHECK cannot be altered in place, so the table is rebuilt.

const RECURRENCE_EXCEPTION_DDL = `
CREATE TABLE schedule_recurrence_exception_new (
  exception_id  TEXT PRIMARY KEY,
  -- A series whose occurrences can be skipped or overridden, whatever domain
  -- owns it. Finance's standing series was expandable from the day it landed
  -- and had no way to record "not this month" (#883, ruling O-recur).
  target_type   TEXT NOT NULL CHECK (target_type IN
    ('core.event','tally.recurring_expense','finance.recurring_series')),
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
INSERT INTO schedule_recurrence_exception_new
  (exception_id, target_type, target_id, original_start, scope, action,
   override_json, created_at, updated_at)
SELECT exception_id, target_type, target_id, original_start, scope, action,
       override_json, created_at, updated_at
  FROM schedule_recurrence_exception;
DROP TABLE schedule_recurrence_exception;
ALTER TABLE schedule_recurrence_exception_new
  RENAME TO schedule_recurrence_exception;
CREATE INDEX IF NOT EXISTS schedule_recurrence_exception_target_idx
  ON schedule_recurrence_exception(target_type, target_id, original_start);
${touchIfNotExists("schedule_recurrence_exception", "exception_id")}
`;

const TRASH_PAIR_DDL = `
ALTER TABLE schedule_task ADD COLUMN deleted_at TEXT;
ALTER TABLE schedule_task ADD COLUMN purge_at TEXT
  CHECK (purge_at IS NULL OR deleted_at IS NOT NULL);
ALTER TABLE core_event ADD COLUMN deleted_at TEXT;
ALTER TABLE core_event ADD COLUMN purge_at TEXT
  CHECK (purge_at IS NULL OR deleted_at IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_task_purge_at ON schedule_task(purge_at);
CREATE INDEX IF NOT EXISTS idx_event_purge_at ON core_event(purge_at);
`;

// Generated trigger bodies are static DDL: a spec change reaches an existing
// file only by rebuilding, and `ftsEntityDdl` re-runs the backfill with it.
const FTS_TRASH_DDL = `
${ftsDropDdl("schedule.task")}
${ftsEntityDdl("schedule.task")}
${ftsDropDdl("core.event")}
${ftsEntityDdl("core.event")}
`;

// O-contact: an identifier is not a channel. `normalized_value` is computed
// here to exactly the rule `normalizeContactChannel` applies — the two move
// together. A channel has no `valid_to`, so an expired one is never preferred.

const IDENTIFIER_NORMALIZED_SQL = `
  CASE i.scheme
    WHEN 'email' THEN lower(trim(i.value))
    ELSE
      (CASE WHEN substr(trim(i.value), 1, 1) = '+' THEN '+' ELSE '' END) ||
      replace(replace(replace(replace(replace(
        replace(trim(i.value), '+', ''), ' ', ''), '(', ''), ')', ''), '.', ''), '-', '')
  END`;

const CONTACT_CHANNEL_DDL = `
INSERT INTO social_contact_channel
  (channel_id, party_id, kind, label, value, normalized_value, is_preferred,
   provenance_json, created_at, updated_at)
SELECT i.identifier_id,
       i.party_id,
       CASE i.scheme WHEN 'tel' THEN 'phone' ELSE 'email' END,
       i.label,
       trim(i.value),
       ${IDENTIFIER_NORMALIZED_SQL},
       0,
       json_object('source', 'core.party_identifier', 'issue', 883,
                   'was_primary', i.is_primary,
                   'verified_at', i.verified_at, 'valid_to', i.valid_to),
       i.valid_from,
       i.valid_from
  FROM core_party_identifier i
 WHERE i.scheme IN ('tel','email')
   AND NOT EXISTS (
     SELECT 1 FROM social_contact_channel c
      WHERE c.party_id = i.party_id
        AND c.kind = CASE i.scheme WHEN 'tel' THEN 'phone' ELSE 'email' END
        AND c.normalized_value = ${IDENTIFIER_NORMALIZED_SQL})
 GROUP BY i.party_id,
          CASE i.scheme WHEN 'tel' THEN 'phone' ELSE 'email' END,
          ${IDENTIFIER_NORMALIZED_SQL};

-- The preferred flag is a per-(party, kind) UNIQUE, so it is set only where
-- the party has no preferred channel of that kind already: a migrated primary
-- identifier fills an empty slot, it never unseats a channel the member chose.
UPDATE social_contact_channel AS c
   SET is_preferred = 1
 WHERE json_extract(c.provenance_json, '$.source') = 'core.party_identifier'
   AND json_extract(c.provenance_json, '$.was_primary') = 1
   AND json_extract(c.provenance_json, '$.valid_to') IS NULL
   AND NOT EXISTS (SELECT 1 FROM social_contact_channel o
                    WHERE o.party_id = c.party_id AND o.kind = c.kind
                      AND o.is_preferred = 1);

CREATE TABLE core_party_identifier_new (
  identifier_id TEXT PRIMARY KEY,
  party_id      TEXT NOT NULL REFERENCES core_party(party_id),
  -- Identity KEYS only (#883, ruling O-contact). 'tel' and 'email' are gone:
  -- an address someone can be reached at is a social_contact_channel, and a
  -- register that accepted both would be one table answering two questions.
  scheme        TEXT NOT NULL CHECK (scheme IN ('url','did','handle','iban','other')),
  value         TEXT NOT NULL,
  label         TEXT,
  is_primary    INTEGER NOT NULL CHECK (is_primary IN (0,1)),
  verified_at   TEXT,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  UNIQUE (scheme, value)
) STRICT;
INSERT INTO core_party_identifier_new
  (identifier_id, party_id, scheme, value, label, is_primary, verified_at,
   valid_from, valid_to)
SELECT identifier_id, party_id, scheme, value, label, is_primary, verified_at,
       valid_from, valid_to
  FROM core_party_identifier
 WHERE scheme NOT IN ('tel','email');
DROP TABLE core_party_identifier;
ALTER TABLE core_party_identifier_new RENAME TO core_party_identifier;
CREATE UNIQUE INDEX IF NOT EXISTS idx_party_identifier_primary
  ON core_party_identifier(party_id, scheme) WHERE is_primary = 1;
`;

// `social.contact_card` retires onto `people_profile`, the one owner of the
// role line. `vcard_rev` lands nowhere: it only copied `updated_at`.

const CONTACT_CARD_DDL = `
ALTER TABLE people_profile ADD COLUMN nickname TEXT;
UPDATE people_profile AS p
   SET role = COALESCE(p.role,
        (SELECT c.org_title FROM social_contact_card c WHERE c.party_id = p.party_id)),
       nickname = COALESCE(p.nickname,
        (SELECT c.nickname FROM social_contact_card c WHERE c.party_id = p.party_id))
 WHERE EXISTS (SELECT 1 FROM social_contact_card c WHERE c.party_id = p.party_id);
${ftsDropDdl("social.contact_card")}
DROP TABLE social_contact_card;
${ftsDropDdl("people.profile")}
${ftsEntityDdl("people.profile")}
`;

// O-attach: a minted attachment carries the RECEIPT'S OWN ID, so a line item's
// `receipt_id` resolves either way. The children go to temp tables FIRST —
// dropping the receipt table cascades into `tally_expense_line_allocation`, and
// deferral does not stop a cascade. The `receipt_id` FK is ON DELETE SET NULL,
// never CASCADE: detaching a photo must leave the typed lines standing.

const RECEIPT_SPINE_DDL = `
CREATE TEMP TABLE reconcile_receipt AS SELECT * FROM tally_expense_receipt;
CREATE TEMP TABLE reconcile_line_item AS SELECT * FROM tally_expense_line_item;
CREATE TEMP TABLE reconcile_line_allocation AS
  SELECT * FROM tally_expense_line_allocation;

INSERT INTO core_attachment
  (attachment_id, target_type, target_id, content_id, role, is_primary, created_at)
SELECT r.receipt_id, 'tally.expense', r.expense_id, r.content_id, 'receipt', 1,
       r.created_at
  FROM reconcile_receipt r
 WHERE NOT EXISTS (
   SELECT 1 FROM core_attachment a
    WHERE a.target_type = 'tally.expense' AND a.target_id = r.expense_id
      AND a.content_id = r.content_id AND a.role = 'receipt');

DROP TABLE tally_expense_line_allocation;
DROP TABLE tally_expense_line_item;
DROP TABLE tally_expense_receipt;

CREATE TABLE tally_expense_line_item (
  line_item_id TEXT PRIMARY KEY,
  expense_id   TEXT NOT NULL REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  -- The role='receipt' attachment this line was read off, or NULL for the
  -- "By line" division that never had a photo (#883, ruling O-attach).
  receipt_id   TEXT REFERENCES core_attachment(attachment_id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('item','tax','tip')),
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  sort_order   INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;

CREATE TABLE tally_expense_line_allocation (
  line_item_id TEXT NOT NULL REFERENCES tally_expense_line_item(line_item_id) ON DELETE CASCADE,
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  share_minor  INTEGER NOT NULL CHECK (share_minor >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  PRIMARY KEY (line_item_id, party_id)
) STRICT;

INSERT INTO tally_expense_line_item
  (line_item_id, expense_id, receipt_id, kind, description, amount_minor,
   sort_order, created_at, updated_at)
SELECT li.line_item_id, li.expense_id,
       (SELECT a.attachment_id FROM core_attachment a
          JOIN reconcile_receipt r ON r.receipt_id = li.receipt_id
         WHERE a.target_type = 'tally.expense' AND a.target_id = r.expense_id
           AND a.content_id = r.content_id AND a.role = 'receipt'),
       li.kind, li.description, li.amount_minor, li.sort_order,
       li.created_at, li.updated_at
  FROM reconcile_line_item li;

INSERT INTO tally_expense_line_allocation
  (line_item_id, party_id, share_minor, created_at, updated_at)
SELECT line_item_id, party_id, share_minor, created_at, updated_at
  FROM reconcile_line_allocation;

DROP TABLE reconcile_receipt;
DROP TABLE reconcile_line_item;
DROP TABLE reconcile_line_allocation;

CREATE INDEX IF NOT EXISTS tally_expense_line_receipt_idx
  ON tally_expense_line_item(receipt_id, sort_order);
CREATE INDEX IF NOT EXISTS tally_expense_line_expense_idx
  ON tally_expense_line_item(expense_id, sort_order);
CREATE INDEX IF NOT EXISTS tally_expense_line_allocation_party_idx
  ON tally_expense_line_allocation(party_id);
${touchIfNotExists("tally_expense_line_item", "line_item_id")}
CREATE TRIGGER IF NOT EXISTS tally_expense_line_allocation_touch_updated_at
AFTER UPDATE ON tally_expense_line_allocation
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE tally_expense_line_allocation
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE line_item_id = NEW.line_item_id AND party_id = NEW.party_id;
END;
`;

// O-payers: the backfill applies the rule the deleted read-time fallback did —
// the principal payer put down the whole amount — so no balance moves.

const PAYER_BACKFILL_DDL = `
INSERT INTO tally_expense_payer (expense_id, party_id, paid_minor)
SELECT e.expense_id, e.paid_by, e.amount_minor
  FROM tally_expense e
 WHERE NOT EXISTS (SELECT 1 FROM tally_expense_payer p
                    WHERE p.expense_id = e.expense_id);
`;

// O-domains: `home.*` and `business.*` leave the v0 ontology (proposal #885).
// `home_asset_bound_transaction_guard` lives on `core_transaction`, which
// SURVIVES, so it is dropped by name — a trigger reading a dropped table fails
// at the next transaction write, not here.

const DOMAIN_DROP_DDL = `
DROP TRIGGER IF EXISTS home_asset_bound_transaction_guard;
${ftsDropDdl("home.asset_item")}
${DROPPED_DOMAIN_TABLES.map((table) => `DROP TABLE ${table};`).join("\n")}
`;

// Order is load-bearing: guards, additive work, rebuilds, drops — so a refusal
// costs nothing and a rebuild never runs against an already-dropped table.
export const ONTOLOGY_RECONCILE_MIGRATION_DDL = `
PRAGMA defer_foreign_keys = ON;

${GUARDS_DDL}
${STORAGE_INDEX_DDL}
${UPDATED_AT_DDL}
${RECURRENCE_EXCEPTION_DDL}
${TRASH_PAIR_DDL}
${FTS_TRASH_DDL}
${CONTACT_CHANNEL_DDL}
${CONTACT_CARD_DDL}
${RECEIPT_SPINE_DDL}
${PAYER_BACKFILL_DDL}
${DOMAIN_DROP_DDL}
`;
