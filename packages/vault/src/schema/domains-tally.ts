// Expense-splitting DDL — schema `tally`. "Split, settled": shared costs
// across groups and friends, who owes whom, and settling up. Balances are
// NEVER stored — they are derived at read time from expenses and settlements
// (the balance engine lives in the queries). Only the ground facts persist.
//
// A friend is a canonical core.party (kind='person'), the same person spine
// People and every other surface use; `tally_friend` is the bare enrolment
// marker — a party is "a friend in Tally". The avatar hue is NOT stored here
// (#441): it lived twice, once here and once on people_profile, both
// 1:1 on the same party, free to disagree. One hue per party now: Tally reads
// people_profile's hue when the party is also a CRM contact, else derives a
// stable one from the party id. The owner is the implicit `me`
// (core_vault.owner_party_id) and never gets a tally_friend row.
//
// A group IS an audience — and the vault already has exactly one audience
// mechanism, social.circle (the #274 decision that circles deliberately stay
// separate from collections). tally_group is a thin DECORATION on a circle
// (#310): the emoji icon and colour the circle has no home for ride
// here, the name and the membership live on the circle itself
// (social_circle_member, the owner included). The third "group of people"
// table this domain briefly re-introduced is gone. Deleting a group is
// refused while it still holds expenses, mirroring the folders
// "delete when empty" rule; deleting it removes its circle too.
//
// Trash (#441): the owner-authored CONTENT rows — tally_expense and
// tally_settlement — carry the uniform soft-delete pair `deleted_at` /
// `purge_at` with the CHECK guard (`purge_at IS NULL OR deleted_at IS NOT NULL`),
// matching Docs/Photos/Locker. tally.delete_expense is a reversible grace-window
// trash now (not an instant hard delete), and the lifecycle sweep is what finally
// purges the row, cascades its splits, and cleans its polymorphic references
// (the expense memo annotation among them).
// Two tables stay HARD-delete, by design, not oversight:
//   - tally_friend is a bare enrolment marker (a party "is a friend in Tally"),
//     an identity decoration with no content of its own — un-enrolling is not
//     trashing content, so it needs no grace window.
//   - tally_group is STRUCTURAL, not content: deleting it is refused while it
//     holds expenses and, once empty, CASCADES its audience — the group owned
//     its social_circle and leaves with it (circle + membership + any
//     free-standing settlements deleted). A grace window on the group would
//     leave a half-torn audience; the refuse-then-cascade rule is the safety.
// Decision — a trashed expense STILL blocks group deletion until it purges:
// delete_group's expense-emptiness check counts ALL of the group's expenses,
// trashed ones included (it does NOT filter deleted_at IS NULL). A trashed
// expense is recoverable money history in the group; tearing the group (and its
// audience) out from under it would strand or cascade a row the owner could
// still restore. Empty the group of live AND trashed expenses first — or wait
// for the trashed ones to purge — then the group deletes.
//
// Money is fixed-scale INTEGER minor units (cents) in the vault's base
// currency; an expense's `tally_expense_split` rows resolve one method
// (equally / exact / percentages / shares / equally-adjusted / by-line) at
// entry time and MUST sum to the amount — the add/edit commands re-validate
// that server-side. The METHOD and its parameters ride on the expense
// (`split_method`, `split_params_json`) purely so an edit re-opens the way the
// expense was entered; the resolved shares stay the only arithmetic the vault
// keeps, and nothing re-derives a share from the parameters.
// `tally_expense_payer` carries who actually paid and how much (the
// single-payer case is one degenerate row), and `tally_expense_line_item`
// hangs off the EXPENSE with a nullable receipt linkage so typed lines need no
// photo. Timestamps TEXT ISO-8601
// UTC; dates are TEXT YYYY-MM-DD; PKs TEXT UUIDv7; all tables STRICT.
//
// The finance bridge (#310): Tally is a lens over shared money, not
// a second ledger. Expenses and settlements carry a nullable `txn_id` into
// core_transaction — settle_up EMITS a canonical transaction when the owner
// is a party to the payment (their money actually moved), and either row can
// be BOUND to an already-imported one via tally.bind_txn (the Studio
// paid_txn_id pattern: bind, don't duplicate, when the bank already knows).

import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

// Canonical receipt capture is a forward migration as well as part of the
// fresh schema. The receipt owns the claimed content item; reviewed OCR rows
// stay structured and each line allocation is explicit rather than inferred.
export const TALLY_RECEIPT_DDL = `
CREATE TABLE IF NOT EXISTS tally_expense_receipt (
  receipt_id  TEXT PRIMARY KEY,
  expense_id  TEXT NOT NULL UNIQUE REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  content_id  TEXT NOT NULL UNIQUE REFERENCES core_content_item(content_id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;

-- A typed line belongs to the EXPENSE, not to the photo. The receipt_id is a
-- nullable decoration: a receipt-backed expense fills it, the "By line"
-- division (no photo, typed lines) leaves it NULL. Lines used to hang off
-- tally_expense_receipt alone, which made a photo the price of itemising.
CREATE TABLE IF NOT EXISTS tally_expense_line_item (
  line_item_id TEXT PRIMARY KEY,
  expense_id   TEXT NOT NULL REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  receipt_id   TEXT REFERENCES tally_expense_receipt(receipt_id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('item','tax','tip')),
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  sort_order   INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;

CREATE TABLE IF NOT EXISTS tally_expense_line_allocation (
  line_item_id TEXT NOT NULL REFERENCES tally_expense_line_item(line_item_id) ON DELETE CASCADE,
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  share_minor  INTEGER NOT NULL CHECK (share_minor >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  PRIMARY KEY (line_item_id, party_id)
) STRICT;

CREATE INDEX IF NOT EXISTS tally_expense_line_receipt_idx
  ON tally_expense_line_item(receipt_id, sort_order);
CREATE INDEX IF NOT EXISTS tally_expense_line_expense_idx
  ON tally_expense_line_item(expense_id, sort_order);
CREATE INDEX IF NOT EXISTS tally_expense_line_allocation_party_idx
  ON tally_expense_line_allocation(party_id);
${touchUpdatedAt("tally_expense_receipt", "receipt_id").replace(
  "CREATE TRIGGER",
  "CREATE TRIGGER IF NOT EXISTS"
)}
${touchUpdatedAt("tally_expense_line_item", "line_item_id").replace(
  "CREATE TRIGGER",
  "CREATE TRIGGER IF NOT EXISTS"
)}
CREATE TRIGGER IF NOT EXISTS tally_expense_line_allocation_touch_updated_at
AFTER UPDATE ON tally_expense_line_allocation
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE tally_expense_line_allocation
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE line_item_id = NEW.line_item_id AND party_id = NEW.party_id;
END;
`;

export const TALLY_DDL = `
CREATE TABLE tally_friend (
  friend_id    TEXT PRIMARY KEY,
  party_id     TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;

CREATE TABLE tally_group (
  group_id   TEXT PRIMARY KEY,
  circle_id  TEXT NOT NULL UNIQUE REFERENCES social_circle(circle_id),
  icon       TEXT NOT NULL,
  color      TEXT NOT NULL,
  -- Debt simplification rewires who owes whom, so it is OFF unless this group
  -- turns it on. The flag is the ONLY thing stored: the proposal itself is
  -- derived at read time and never written, and an accepted proposal is
  -- recorded as ordinary settlements.
  simplify_opt_in INTEGER NOT NULL DEFAULT 0
    CHECK (simplify_opt_in IN (0,1)),
  -- Archive is not delete: an archived group drops out of the default lists
  -- and keeps every row. It needs no settled balance.
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;

CREATE TABLE tally_expense (
  expense_id   TEXT PRIMARY KEY,
  -- NULL for a group-less 1:1 expense (GAPS #4), mirroring how a settlement
  -- has always been free-standing. Participants on a group-less expense are
  -- validated against the friend roster instead of a circle.
  group_id     TEXT REFERENCES tally_group(group_id),
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  -- The PRINCIPAL payer, always populated and always one of the payer rows.
  -- Every expense also writes its full payer set to tally_expense_payer (one
  -- degenerate row in the single-payer case), so a reader that only knows this
  -- column stays right for the single-payer case and the folds read one shape.
  paid_by      TEXT NOT NULL REFERENCES core_party(party_id),
  -- How the shares were arrived at, so an edit re-opens the way it was
  -- entered. The vault still stores RESOLVED shares — the method and its
  -- parameters are provenance, never a second arithmetic path.
  split_method TEXT NOT NULL DEFAULT 'exact' CHECK (split_method IN
    ('equally','exact','percentages','shares','adjusted','by_line')),
  split_params_json TEXT
    CHECK (split_params_json IS NULL OR json_valid(split_params_json)),
  spent_on     TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN
    ('food','groceries','rent','utilities','transport','fun','travel','shopping','general')),
  txn_id       TEXT REFERENCES core_transaction(txn_id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- Trash pair + guard (issue #441 A4). tally_expense_split cascades on purge.
  deleted_at   TEXT,
  purge_at     TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL)
) STRICT;

CREATE TABLE tally_expense_split (
  expense_id  TEXT NOT NULL REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  share_minor INTEGER NOT NULL CHECK (share_minor >= 0),
  updated_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  PRIMARY KEY (expense_id, party_id)
) STRICT;

-- Who actually put money down, and how much. Written for EVERY expense: the
-- single-payer case is the degenerate one row (paid_by, amount_minor). The
-- paid amounts sum to the expense amount, re-validated server-side, and both
-- balance folds credit payers from here rather than from paid_by alone.
CREATE TABLE tally_expense_payer (
  expense_id  TEXT NOT NULL REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  paid_minor  INTEGER NOT NULL CHECK (paid_minor >= 0),
  updated_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  PRIMARY KEY (expense_id, party_id)
) STRICT;

-- A PREPARED reminder, never a sent one. Tally has no delivery path and wants
-- none: the row records that the owner meant to nudge someone about a stale
-- balance, and tally.nudge carries confirm:true so an app-issued nudge
-- parks for the owner's confirmation instead of firing.
CREATE TABLE tally_nudge (
  nudge_id     TEXT PRIMARY KEY,
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  group_id     TEXT REFERENCES tally_group(group_id),
  -- The net the owner saw when they prepared it, in minor units. Provenance
  -- for the reminder's wording — never read back as a balance.
  as_of_minor  INTEGER NOT NULL,
  note         TEXT,
  prepared_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;

CREATE TABLE tally_settlement (
  settlement_id TEXT PRIMARY KEY,
  -- NULL for a free-standing friend-to-friend payment (not scoped to a group).
  group_id      TEXT REFERENCES tally_group(group_id),
  from_party    TEXT NOT NULL REFERENCES core_party(party_id),
  to_party      TEXT NOT NULL REFERENCES core_party(party_id),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  paid_on       TEXT NOT NULL,
  txn_id        TEXT REFERENCES core_transaction(txn_id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- Trash pair + guard (issue #441 A4).
  deleted_at    TEXT,
  purge_at      TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL)
) STRICT;

-- A standing IOU is a ground fact, not a stored balance (issue #450). It
-- lives beside expenses and settlements so every surface folds the same facts
-- into one net position; settling it end-dates the obligation rather than
-- inventing a parallel People-only balance.
CREATE TABLE tally_obligation (
  obligation_id TEXT PRIMARY KEY,
  from_party    TEXT NOT NULL REFERENCES core_party(party_id),
  to_party      TEXT NOT NULL REFERENCES core_party(party_id),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  currency      TEXT NOT NULL CHECK (length(currency) = 3),
  reason        TEXT,
  incurred_on   TEXT NOT NULL,
  settled_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  deleted_at    TEXT,
  purge_at      TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  CHECK (from_party <> to_party)
) STRICT;

CREATE INDEX tally_expense_group_idx ON tally_expense(group_id);
CREATE INDEX tally_settlement_group_idx ON tally_settlement(group_id);
CREATE INDEX tally_expense_paid_by_idx ON tally_expense(paid_by);
CREATE INDEX tally_expense_txn_idx ON tally_expense(txn_id);
CREATE INDEX tally_expense_split_party_idx ON tally_expense_split(party_id);
CREATE INDEX tally_expense_payer_party_idx ON tally_expense_payer(party_id);
CREATE INDEX tally_group_archived_idx ON tally_group(archived_at);
CREATE INDEX tally_nudge_party_idx ON tally_nudge(party_id, prepared_at DESC);
CREATE INDEX tally_nudge_group_idx ON tally_nudge(group_id);
CREATE INDEX tally_settlement_from_party_idx ON tally_settlement(from_party);
CREATE INDEX tally_settlement_to_party_idx ON tally_settlement(to_party);
CREATE INDEX tally_settlement_txn_idx ON tally_settlement(txn_id);
CREATE INDEX tally_obligation_from_party_idx ON tally_obligation(from_party);
CREATE INDEX tally_obligation_to_party_idx ON tally_obligation(to_party);
${touchUpdatedAt("tally_friend", "friend_id")}
${touchUpdatedAt("tally_group", "group_id")}
${touchUpdatedAt("tally_expense", "expense_id")}
${touchUpdatedAt("tally_settlement", "settlement_id")}
${touchUpdatedAt("tally_obligation", "obligation_id")}
${touchUpdatedAt("tally_nudge", "nudge_id")}
CREATE TRIGGER tally_expense_payer_touch_updated_at
AFTER UPDATE ON tally_expense_payer
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE tally_expense_payer
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE expense_id = NEW.expense_id AND party_id = NEW.party_id;
END;
CREATE TRIGGER tally_expense_split_touch_updated_at
AFTER UPDATE ON tally_expense_split
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE tally_expense_split
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE expense_id = NEW.expense_id AND party_id = NEW.party_id;
END;
${TALLY_RECEIPT_DDL}
`;
