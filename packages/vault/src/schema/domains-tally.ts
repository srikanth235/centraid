// Expense-splitting DDL — schema `tally`. "Split, settled": shared costs
// across groups and friends, who owes whom, and settling up. Balances are
// NEVER stored — they are derived at read time from expenses and settlements
// (the balance engine lives in the queries). Only the ground facts persist.
//
// A friend is a canonical core.party (kind='person'), the same person spine
// People and every other surface use; `tally_friend` hangs the one CRM-free
// fact Tally needs off the party id — the avatar hue. The owner is the
// implicit `me` (core_vault.owner_party_id) and never gets a tally_friend row.
//
// A group carries an emoji icon and a colour the SKOS concept spine has no
// home for, so — unlike Docs folders / People circles — it is its own table
// rather than a concept scheme; membership is one `tally_group_member` row per
// party (the owner included). Deleting a group is refused while it still holds
// expenses, mirroring the folders "delete when empty" rule.
//
// Money is fixed-scale INTEGER minor units (cents) in the vault's base
// currency; an expense's `tally_expense_split` rows resolve one method
// (equally / exact / percentages) at entry time and MUST sum to the amount —
// the add/edit commands re-validate that server-side. Timestamps TEXT ISO-8601
// UTC; dates are TEXT YYYY-MM-DD; PKs TEXT UUIDv7; all tables STRICT.

export const TALLY_DDL = `
CREATE TABLE tally_friend (
  friend_id    TEXT PRIMARY KEY,
  party_id     TEXT NOT NULL UNIQUE REFERENCES core_party(party_id),
  avatar_color TEXT,
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE tally_group (
  group_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  icon       TEXT NOT NULL,
  color      TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE tally_group_member (
  group_id TEXT NOT NULL REFERENCES tally_group(group_id) ON DELETE CASCADE,
  party_id TEXT NOT NULL REFERENCES core_party(party_id),
  PRIMARY KEY (group_id, party_id)
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
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE tally_expense_split (
  expense_id  TEXT NOT NULL REFERENCES tally_expense(expense_id) ON DELETE CASCADE,
  party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  share_minor INTEGER NOT NULL CHECK (share_minor >= 0),
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
  created_at    TEXT NOT NULL
) STRICT;

CREATE INDEX tally_expense_group_idx ON tally_expense(group_id);
CREATE INDEX tally_settlement_group_idx ON tally_settlement(group_id);
`;
