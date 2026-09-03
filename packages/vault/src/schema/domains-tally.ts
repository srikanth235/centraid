import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

export const TALLY_LINE_ITEM_DDL = `
-- A typed line belongs to the EXPENSE, not to the photo. The receipt_id is a
-- nullable decoration: a receipt-backed expense fills it, the "By line"
-- division (no photo, typed lines) leaves it NULL. Lines used to hang off a
-- receipt row alone, which made a photo the price of itemising.
CREATE TABLE tally_expense_line_item (
  line_item_id TEXT PRIMARY KEY,
  expense_id   TEXT NOT NULL REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  -- The role='receipt' attachment this line was read off, or NULL for the
  -- "By line" division that never had a photo (#883).
  receipt_id   TEXT REFERENCES core_attachment(attachment_id) ON DELETE SET NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('item','tax','tip')),
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  sort_order   INTEGER NOT NULL CHECK (sort_order >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (line_item_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE tally_expense_line_allocation (
  line_item_id TEXT NOT NULL REFERENCES tally_expense_line_item(line_item_id) ON DELETE CASCADE,
  party_id     TEXT NOT NULL REFERENCES core_party(party_id),
  share_minor  INTEGER NOT NULL CHECK (share_minor >= 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  PRIMARY KEY (line_item_id, party_id)
) STRICT;

CREATE INDEX tally_expense_line_receipt_idx
  ON tally_expense_line_item(receipt_id, sort_order);
CREATE INDEX tally_expense_line_expense_idx
  ON tally_expense_line_item(expense_id, sort_order);
CREATE INDEX tally_expense_line_allocation_party_idx
  ON tally_expense_line_allocation(party_id);
${touchUpdatedAt("tally_expense_line_item", "line_item_id")}
CREATE TRIGGER tally_expense_line_allocation_touch_updated_at
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
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (friend_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
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
  -- THE GROUP'S CURRENCY (#916, R1 / review 4.1). Splitwise's own model puts
  -- the currency on the group and every expense in it agrees; the vault stored
  -- amounts in minor units with no currency at all outside
  -- \`tally_obligation\` and the cross-currency columns, so two expenses in
  -- different currencies summed as if they were the same money. The group is
  -- where it belongs, because a group is the ledger everyone in it reads.
  currency   TEXT NOT NULL CHECK (length(currency) = 3),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (group_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE tally_expense (
  expense_id   TEXT PRIMARY KEY,
  -- NULL for a group-less 1:1 expense (GAPS #4), mirroring how a settlement
  -- has always been free-standing. Participants on a group-less expense are
  -- validated against the friend roster instead of a circle.
  group_id     TEXT REFERENCES tally_group(group_id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  -- The currency \`amount_minor\` IS (#916, R1). Splits, payers and line items
  -- inherit it BY CONSTRUCTION — they are shares of this amount and cannot be
  -- denominated in anything else, so none of them carries a column. A trigger
  -- (\`tally_expense_currency_matches_group\`, below) holds a grouped expense
  -- to its group's currency; a group-less 1:1 expense is free to be in any.
  currency     TEXT NOT NULL CHECK (length(currency) = 3),
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
  purge_at     TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  FOREIGN KEY (expense_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE tally_expense_split (
  expense_id  TEXT NOT NULL REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  share_minor INTEGER NOT NULL CHECK (share_minor >= 0),
  created_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
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
  created_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
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
  group_id     TEXT REFERENCES tally_group(group_id) ON DELETE CASCADE,
  -- The net the owner saw when they prepared it, in minor units. Provenance
  -- for the reminder's wording — never read back as a balance.
  as_of_minor  INTEGER NOT NULL,
  note         TEXT,
  prepared_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (nudge_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE tally_settlement (
  settlement_id TEXT PRIMARY KEY,
  -- NULL for a free-standing friend-to-friend payment (not scoped to a group).
  group_id      TEXT REFERENCES tally_group(group_id) ON DELETE CASCADE,
  from_party    TEXT NOT NULL REFERENCES core_party(party_id),
  to_party      TEXT NOT NULL REFERENCES core_party(party_id),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  -- What was PAID, in the currency it was paid in (#916, R1). The trigger
  -- below holds a grouped settlement to its group's currency.
  currency      TEXT NOT NULL CHECK (length(currency) = 3),
  paid_on       TEXT NOT NULL,
  txn_id        TEXT REFERENCES core_transaction(txn_id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- Trash pair + guard (issue #441 A4).
  deleted_at    TEXT,
  purge_at      TEXT CHECK (purge_at IS NULL OR deleted_at IS NOT NULL),
  -- A payment from someone to themselves is not a payment (#916, R2 / review
  -- 10.2). \`tally_obligation\` has carried this CHECK since #450; the
  -- settlement did not, which is how \`core.merge_party\` could fold two
  -- parties into one and leave a self-payment behind that every balance then
  -- counted twice.
  CHECK (from_party <> to_party),
  FOREIGN KEY (settlement_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
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
  CHECK (from_party <> to_party),
  FOREIGN KEY (obligation_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
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
CREATE INDEX tally_expense_purge_idx
  ON tally_expense(purge_at) WHERE purge_at IS NOT NULL;
CREATE INDEX tally_settlement_purge_idx
  ON tally_settlement(purge_at) WHERE purge_at IS NOT NULL;
CREATE INDEX tally_obligation_purge_idx
  ON tally_obligation(purge_at) WHERE purge_at IS NOT NULL;
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

-- ONE LEDGER, ONE CURRENCY (#916, R1 / review 4.1). SQLite cannot express
-- "equals the parent's value" in a CHECK, so the rule is a pair of triggers
-- per table rather than a constraint — the same shape \`tally_expense_payer\`'s
-- sum rule already uses. A group-less expense or settlement is exempt: a 1:1
-- payment between friends has no shared ledger to agree with.
CREATE TRIGGER tally_expense_currency_matches_group_ai
BEFORE INSERT ON tally_expense
WHEN NEW.group_id IS NOT NULL
 AND NEW.currency <> (SELECT g.currency FROM tally_group g WHERE g.group_id = NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'tally.expense: an expense in a group is in that group''s currency');
END;
CREATE TRIGGER tally_expense_currency_matches_group_au
BEFORE UPDATE OF currency, group_id ON tally_expense
WHEN NEW.group_id IS NOT NULL
 AND NEW.currency <> (SELECT g.currency FROM tally_group g WHERE g.group_id = NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'tally.expense: an expense in a group is in that group''s currency');
END;
CREATE TRIGGER tally_settlement_currency_matches_group_ai
BEFORE INSERT ON tally_settlement
WHEN NEW.group_id IS NOT NULL
 AND NEW.currency <> (SELECT g.currency FROM tally_group g WHERE g.group_id = NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'tally.settlement: a settlement in a group is in that group''s currency');
END;
CREATE TRIGGER tally_settlement_currency_matches_group_au
BEFORE UPDATE OF currency, group_id ON tally_settlement
WHEN NEW.group_id IS NOT NULL
 AND NEW.currency <> (SELECT g.currency FROM tally_group g WHERE g.group_id = NEW.group_id)
BEGIN
  SELECT RAISE(ABORT, 'tally.settlement: a settlement in a group is in that group''s currency');
END;
`;
