// Expense-splitting DDL — schema `tally`. "Split, settled": shared costs
// across groups and friends, who owes whom, and settling up. Balances are
// NEVER stored — they are derived at read time from expenses and settlements
// (the balance engine lives in the queries). Only the ground facts persist.
//
// A friend is a canonical core.party (kind='person'), the same person spine
// People and every other surface use; `tally_friend` is the bare enrolment
// marker — a party is "a friend in Tally". The avatar hue is NOT stored here
// (issue #441 A3): it lived twice, once here and once on people_profile, both
// 1:1 on the same party, free to disagree. One hue per party now: Tally reads
// people_profile's hue when the party is also a CRM contact, else derives a
// stable one from the party id. The owner is the implicit `me`
// (core_vault.owner_party_id) and never gets a tally_friend row.
//
// A group IS an audience — and the vault already has exactly one audience
// mechanism, social.circle (the #274 decision that circles deliberately stay
// separate from collections). tally_group is a thin DECORATION on a circle
// (issue #310 S4): the emoji icon and colour the circle has no home for ride
// here, the name and the membership live on the circle itself
// (social_circle_member, the owner included). The third "group of people"
// table this domain briefly re-introduced is gone. Deleting a group is
// refused while it still holds expenses, mirroring the folders
// "delete when empty" rule; deleting it removes its circle too.
//
// Trash (issue #441 A4): the owner-authored CONTENT rows — tally_expense and
// tally_settlement — carry the uniform soft-delete pair `deleted_at` /
// `purge_at` with the CHECK guard (`purge_at IS NULL OR deleted_at IS NOT NULL`),
// matching Docs/Photos/Locker. tally.delete_expense is a reversible grace-window
// trash now (not an instant hard delete), and the lifecycle sweep is what finally
// purges the row, cascades its splits, and cleans its polymorphic references
// (the expense memo annotation among them — previously leaked on hard delete).
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
// (equally / exact / percentages) at entry time and MUST sum to the amount —
// the add/edit commands re-validate that server-side. Timestamps TEXT ISO-8601
// UTC; dates are TEXT YYYY-MM-DD; PKs TEXT UUIDv7; all tables STRICT.
//
// The finance bridge (issue #310 S1): Tally is a lens over shared money, not
// a second ledger. Expenses and settlements carry a nullable `txn_id` into
// core_transaction — settle_up EMITS a canonical transaction when the owner
// is a party to the payment (their money actually moved), and either row can
// be BOUND to an already-imported one via tally.bind_txn (the Studio
// paid_txn_id pattern: bind, don't duplicate, when the bank already knows).

import { UPDATED_AT_DEFAULT, touchUpdatedAt } from './updated-at.js';

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
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;

CREATE TABLE tally_expense (
  expense_id   TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL REFERENCES tally_group(group_id),
  description  TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  paid_by      TEXT NOT NULL REFERENCES core_party(party_id),
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
CREATE INDEX tally_settlement_from_party_idx ON tally_settlement(from_party);
CREATE INDEX tally_settlement_to_party_idx ON tally_settlement(to_party);
CREATE INDEX tally_settlement_txn_idx ON tally_settlement(txn_id);
CREATE INDEX tally_obligation_from_party_idx ON tally_obligation(from_party);
CREATE INDEX tally_obligation_to_party_idx ON tally_obligation(to_party);
${touchUpdatedAt('tally_friend', 'friend_id')}
${touchUpdatedAt('tally_group', 'group_id')}
${touchUpdatedAt('tally_expense', 'expense_id')}
${touchUpdatedAt('tally_settlement', 'settlement_id')}
${touchUpdatedAt('tally_obligation', 'obligation_id')}
CREATE TRIGGER tally_expense_split_touch_updated_at
AFTER UPDATE ON tally_expense_split
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE tally_expense_split
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE expense_id = NEW.expense_id AND party_id = NEW.party_id;
END;
`;
