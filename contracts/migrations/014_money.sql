-- MONEY KEEPS ITS DECISIONS IN THE VAULT — RUNG FOURTEEN.
--
-- **ON THE LADDER.** `LADDER` in `crates/vault/src/migrations.rs` ends here.
-- The file is both the migration and its fixture (D-1020-D1-13).
--
-- **NEVER EDITED FROM HERE ON.** A file in the field has already run this text;
-- an edit changes what a fresh file gets and nothing else, which is two schemas
-- with one number. A correction is rung fifteen. (Rung fifteen is already
-- spoken for: the assistant wave widens the two chat CHECKs that name apps.)
--
-- ## What this is for
--
-- Money is the ninth first-party app (#1099, R-1099-1): a member imports a bank
-- or card statement and reads where it went. The canonical rows are the `core`
-- spine's own — `core_account` and `core_transaction` — which already carry an
-- account, a signed-by-direction magnitude, a currency, a category concept and a
-- provider-local `external_id`. What the spine cannot hold is what the MEMBER
-- decides about those rows, and what the statement carries that the spine has no
-- column for. This rung is that, and nothing a figure is derived from: every
-- balance, total and rollup on a Money screen is computed at read time (R5), so
-- there is no stored balance anywhere below.
--
-- ## The shape, and why each table is what it is
--
-- Six tables, one pack (`money`), and one kind of entity among them:
--
-- - `money_account` DECORATES `core_account` (R-1099-6), keyed by its id. The spine's
--   account is append-only (it has no `updated_at`, so an edit has nowhere to
--   land), and a member renames an account, closes it, moves it off budget. So
--   the member-facing `name` and `kind` live HERE and the spine row keeps the
--   words it was founded with; a reader of Money reads this one. `kind` is the
--   finer word (`checking` | `savings` | `credit_card` | `cash`) of the spine's
--   coarse one (`depository` | `credit` | `cash`). A PROJECTION of `core.account`.
-- - `money_transaction` DECORATES `core_transaction` (R-1099-11), keyed by its id.
--   An imported row is never edited, so the member's name for it ("Costco" for
--   `COSTCO WHSE #123`), the memo, the cheque number and the bank's own type word
--   need a home that is not the spine row. A JSON bag was refused (ONT-rows'
--   reasoning: a field a reader must know to look inside is a column nobody
--   indexed). A PROJECTION of `core.transaction`.
-- - `money_target` is the amount a member plans for a category in a month
--   (R-1099-5): `(month, category)` is its whole identity, so there is no id to
--   mint and nothing to be an entity of. `carry` says the month's unspent (or
--   overspent) amount rolls into the next. A PROJECTION of `core.concept`.
-- - `money_rule` is a rule the member (or the app, on the member's yes) wrote:
--   "when a description contains X, file it under Y and call it Z". It is a thing
--   a member names, reorders and deletes, so it IS an entity (`money.rule`), with
--   the membership triggers every entity carries.
-- - `money_import_profile` remembers how one account's statement file is laid
--   out, keyed by the file's header fingerprint, so the second import of the same
--   bank's CSV needs no mapping. A PROJECTION of `core.account`.
-- - `money_balance_checkpoint` is a balance a statement (or the member) stated
--   for a day. It is EVIDENCE a derived balance is checked against, never the
--   balance itself. A PROJECTION of `core.account`.
--
-- Every projection but the targets is deleted with the row it decorates. The
-- targets cascade from the category they plan. `money_rule` is the one table
-- that merely REFERENCES a category (`set_category_concept_id`, no delete
-- action): deleting a category would otherwise change what a rule does without
-- anyone having said so, so the engine refuses it, and `money.merge_category`
-- repoints the rules in the same transaction as the rows.
--
-- ## The invariants the schema holds, because a command bug must not break them
--
-- 1. **One account, one currency.** A transaction in a Money account carries its
--    account's currency (insert and update); a checkpoint likewise. The same
--    guard Tally keeps for a group's expenses (`tally_expense_currency_matches_
--    group_*`). It is scoped to accounts that have a `money_account` row because
--    Tally's own settlement pool (`core_account` "Tally settlements") has always
--    posted a settlement in the currency the settlement was made in, and
--    tightening that is Tally's decision to take, not this rung's (R-1099-24).
-- 2. **An imported row is never edited.** For a Money account the only columns of
--    `core_transaction` that move after the insert are `category_concept_id` (the
--    member's decision) and `status`, and `status` only ever to `void`. A void
--    row never comes back. Nothing is deleted: voiding is how a member removes a
--    line from every total.
-- 3. **A statement line is in a vault once.** `core_transaction (account_id,
--    external_id)` is unique where `external_id` is set. `external_id` is
--    `ofx:<FITID>` or `csv:<BLAKE3 of the line>` (R-1099-3), so importing the
--    same file twice, or two files that overlap by a week, writes each line once.
--
-- ## The unique index and a vault that already holds duplicates
--
-- Until now `core_transaction.external_id` was an ordinary index (#996 R20(c):
-- an id is scoped to its source and the global unique was removed). A vault may
-- therefore hold two rows with the same `(account_id, external_id)`, and a
-- `CREATE UNIQUE INDEX` over them would fail and leave the file unable to open.
-- The rule, applied BEFORE the index is created: the EARLIEST row (by
-- `created_at`, then `txn_id`) keeps its `external_id`; every later one has
-- `#dup-<its txn_id>` appended. No row is deleted and no amount changes; the
-- later rows simply stop claiming to be the same statement line, which is the
-- honest reading of two rows a member may well have meant (R-1099-24).
--
-- ## Vocabulary this rung seeds (R-1099-15, R-1099-16)
--
-- - The `transfer` link relation, so a member can say two transactions are the
--   two halves of one movement of their own money. A vault founded at this rung
--   gets it from `bootstrap.rs` with the other relations (the relations scheme
--   does not exist yet when the ladder runs over an empty file); a vault that
--   already has the scheme gets it here, under the same id.
-- - The categories scheme `urn:centraid:money:categories`: 9 groups and 14
--   categories beneath them, two levels, each with a stable notation. Seeded here
--   on every file, new or climbed, so there is ONE statement of the list; the ids
--   are fixed (`money:cat:<notation>`) so a vault founded at the head and a vault
--   climbed from rung thirteen hold byte-identical rows, and so every statement
--   below is idempotent (the suites wind a founded file back by pragma and climb
--   again over this rung's own objects).

INSERT OR IGNORE INTO core_entity_kind (kind) VALUES ('money.rule');

-- ---------------------------------------------------------------------------
-- A statement line is in a vault once.
-- ---------------------------------------------------------------------------

UPDATE core_transaction
   SET external_id = external_id || '#dup-' || txn_id
 WHERE external_id IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM core_transaction earlier
      WHERE earlier.account_id = core_transaction.account_id
        AND earlier.external_id = core_transaction.external_id
        AND (earlier.created_at, earlier.txn_id)
            < (core_transaction.created_at, core_transaction.txn_id));

CREATE UNIQUE INDEX IF NOT EXISTS core_transaction_account_external_idx
  ON core_transaction(account_id, external_id) WHERE external_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The six tables.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS money_account (
  account_id    TEXT PRIMARY KEY REFERENCES core_account(account_id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (length(trim(name)) > 0),
  kind          TEXT NOT NULL CHECK (kind IN ('checking','savings','credit_card','cash')),
  -- On budget: its spending counts toward the month's plan. Off budget (a loan
  -- paid elsewhere, a shared account) it is still listed and still has a balance.
  on_budget     INTEGER NOT NULL DEFAULT 1 CHECK (on_budget IN (0,1)),
  -- Where the account stood on `opening_on`, SIGNED (a card owes: negative).
  -- The balance on any day is this plus the posted rows after `opening_on`,
  -- derived at read time; an account with no opening date counts every row.
  opening_minor INTEGER NOT NULL DEFAULT 0,
  opening_on    TEXT CHECK (opening_on IS NULL
                            OR opening_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- A closed account keeps every row and stays readable; it leaves the lists a
  -- member picks from. A day, not an instant: the member says which day.
  closed_on     TEXT CHECK (closed_on IS NULL
                            OR closed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version   INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)
) STRICT;

CREATE TABLE IF NOT EXISTS money_transaction (
  txn_id              TEXT PRIMARY KEY REFERENCES core_transaction(txn_id) ON DELETE CASCADE,
  -- What the member (or a rule, for them) calls this line. The bank's words stay
  -- in `core_transaction.description`, exactly as written. Both or neither.
  display_name        TEXT CHECK (display_name IS NULL OR length(trim(display_name)) > 0),
  display_name_source TEXT CHECK (display_name_source IN ('rule','member')),
  memo                TEXT,
  check_number        TEXT,
  -- OFX `TRNTYPE` or the CSV's own Type column, as the bank wrote it.
  bank_type           TEXT,
  imported_from       TEXT NOT NULL CHECK (imported_from IN ('csv','ofx')),
  imported_at         TEXT NOT NULL,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version         INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CHECK ((display_name IS NULL) = (display_name_source IS NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS money_target (
  -- `YYYY-MM`: the civil month the plan is for (R-1099-2).
  month               TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  category_concept_id TEXT NOT NULL REFERENCES core_concept(concept_id) ON DELETE CASCADE,
  amount_minor        INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency            TEXT NOT NULL CHECK (length(currency) = 3),
  -- Roll the month's unspent (or overspent) amount into the next month's.
  carry               INTEGER NOT NULL DEFAULT 0 CHECK (carry IN (0,1)),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version         INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (month, category_concept_id)
) STRICT;

CREATE TABLE IF NOT EXISTS money_rule (
  rule_id                 TEXT PRIMARY KEY,
  match_kind              TEXT NOT NULL CHECK (match_kind IN ('is','contains','matches')),
  pattern                 TEXT NOT NULL CHECK (length(trim(pattern)) > 0),
  -- Inclusive bounds on the MAGNITUDE (`core_transaction.amount_minor`, > 0);
  -- either may be absent.
  amount_min_minor        INTEGER CHECK (amount_min_minor IS NULL OR amount_min_minor >= 0),
  amount_max_minor        INTEGER CHECK (amount_max_minor IS NULL OR amount_max_minor >= 0),
  account_id              TEXT REFERENCES core_account(account_id) ON DELETE CASCADE,
  set_category_concept_id TEXT REFERENCES core_concept(concept_id),
  set_display_name        TEXT CHECK (set_display_name IS NULL OR length(trim(set_display_name)) > 0),
  position                INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version             INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  CHECK (amount_min_minor IS NULL OR amount_max_minor IS NULL
         OR amount_min_minor <= amount_max_minor),
  -- A rule that does nothing is not a rule.
  CHECK (set_category_concept_id IS NOT NULL OR set_display_name IS NOT NULL),
  FOREIGN KEY (rule_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS money_import_profile (
  account_id         TEXT NOT NULL REFERENCES core_account(account_id) ON DELETE CASCADE,
  -- A digest of the file's header row: the same bank's export finds its mapping.
  header_fingerprint TEXT NOT NULL CHECK (length(header_fingerprint) > 0),
  delimiter          TEXT NOT NULL CHECK (length(delimiter) = 1),
  skip_lines         INTEGER NOT NULL DEFAULT 0 CHECK (skip_lines >= 0),
  date_order         TEXT NOT NULL CHECK (date_order IN ('mdy','dmy','ymd')),
  -- How the amount's sign is read: one signed column; a debit and a credit
  -- column; an amount plus an indicator column naming which rows go out; or one
  -- signed column whose sign is reversed (a card statement that lists charges as
  -- positive).
  sign_mode          TEXT NOT NULL CHECK (sign_mode IN ('signed','debit_credit','indicator','flip')),
  date_col           INTEGER NOT NULL CHECK (date_col >= 0),
  amount_col         INTEGER CHECK (amount_col IS NULL OR amount_col >= 0),
  debit_col          INTEGER CHECK (debit_col IS NULL OR debit_col >= 0),
  credit_col         INTEGER CHECK (credit_col IS NULL OR credit_col >= 0),
  desc_col           INTEGER NOT NULL CHECK (desc_col >= 0),
  memo_col           INTEGER CHECK (memo_col IS NULL OR memo_col >= 0),
  indicator_col      INTEGER CHECK (indicator_col IS NULL OR indicator_col >= 0),
  -- The indicator word that means money going OUT ("DR", "Debit", "D").
  indicator_out_value TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version        INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (account_id, header_fingerprint),
  CHECK (sign_mode <> 'debit_credit' OR (debit_col IS NOT NULL AND credit_col IS NOT NULL)),
  CHECK (sign_mode = 'debit_credit' OR amount_col IS NOT NULL),
  CHECK (sign_mode <> 'indicator'
         OR (indicator_col IS NOT NULL AND indicator_out_value IS NOT NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS money_balance_checkpoint (
  account_id      TEXT NOT NULL REFERENCES core_account(account_id) ON DELETE CASCADE,
  as_of           TEXT NOT NULL CHECK (as_of GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  source          TEXT NOT NULL CHECK (source IN ('ofx','csv','member')),
  -- SIGNED, in the account's currency.
  balance_minor   INTEGER NOT NULL,
  currency        TEXT NOT NULL CHECK (length(currency) = 3),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  row_version     INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  PRIMARY KEY (account_id, as_of, source)
) STRICT;

CREATE INDEX IF NOT EXISTS money_rule_order_idx
  ON money_rule(position, rule_id);

CREATE INDEX IF NOT EXISTS idx_money_rule_account
  ON money_rule(account_id) WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_money_rule_category
  ON money_rule(set_category_concept_id) WHERE set_category_concept_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_money_target_category
  ON money_target(category_concept_id);

-- ---------------------------------------------------------------------------
-- A rule is an entity; every table that changes carries the touch pair.
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS money_rule_entity_delete
AFTER DELETE ON money_rule
BEGIN
  DELETE FROM core_entity WHERE entity_id = OLD.rule_id;
END;

CREATE TRIGGER IF NOT EXISTS money_rule_entity_insert
BEFORE INSERT ON money_rule
BEGIN
  SELECT RAISE(ABORT, 'entity id is already held by another kind: money_rule (#916)')
   WHERE EXISTS (
     SELECT 1 FROM core_entity
      WHERE entity_id = NEW.rule_id AND entity_type <> 'money.rule');
  INSERT OR IGNORE INTO core_entity (entity_id, entity_type, created_at)
  VALUES (NEW.rule_id, 'money.rule', COALESCE(NEW.created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
END;

CREATE TRIGGER IF NOT EXISTS money_rule_touch_updated_at
AFTER UPDATE ON money_rule
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE money_rule
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE rule_id = NEW.rule_id;
END;

CREATE TRIGGER IF NOT EXISTS money_account_touch_updated_at
AFTER UPDATE ON money_account
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE money_account
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE account_id = NEW.account_id;
END;

CREATE TRIGGER IF NOT EXISTS money_transaction_touch_updated_at
AFTER UPDATE ON money_transaction
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE money_transaction
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE txn_id = NEW.txn_id;
END;

CREATE TRIGGER IF NOT EXISTS money_target_touch_updated_at
AFTER UPDATE ON money_target
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE money_target
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE month = NEW.month AND category_concept_id = NEW.category_concept_id;
END;

CREATE TRIGGER IF NOT EXISTS money_import_profile_touch_updated_at
AFTER UPDATE ON money_import_profile
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE money_import_profile
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE account_id = NEW.account_id AND header_fingerprint = NEW.header_fingerprint;
END;

CREATE TRIGGER IF NOT EXISTS money_balance_checkpoint_touch_updated_at
AFTER UPDATE ON money_balance_checkpoint
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE money_balance_checkpoint
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE account_id = NEW.account_id AND as_of = NEW.as_of AND source = NEW.source;
END;

-- ---------------------------------------------------------------------------
-- One account, one currency; an imported row is never edited.
-- ---------------------------------------------------------------------------

CREATE TRIGGER IF NOT EXISTS core_transaction_currency_matches_money_account_ai
BEFORE INSERT ON core_transaction
WHEN EXISTS (SELECT 1 FROM money_account WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'transaction currency must match its Money account (#1099)')
   WHERE NEW.currency IS NOT (SELECT currency FROM core_account WHERE account_id = NEW.account_id);
END;

CREATE TRIGGER IF NOT EXISTS core_transaction_currency_matches_money_account_au
BEFORE UPDATE OF account_id, currency ON core_transaction
WHEN EXISTS (SELECT 1 FROM money_account WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'transaction currency must match its Money account (#1099)')
   WHERE NEW.currency IS NOT (SELECT currency FROM core_account WHERE account_id = NEW.account_id);
END;

CREATE TRIGGER IF NOT EXISTS money_balance_checkpoint_currency_matches_account_ai
BEFORE INSERT ON money_balance_checkpoint
BEGIN
  SELECT RAISE(ABORT, 'checkpoint currency must match its account (#1099)')
   WHERE NEW.currency IS NOT (SELECT currency FROM core_account WHERE account_id = NEW.account_id);
END;

CREATE TRIGGER IF NOT EXISTS money_balance_checkpoint_currency_matches_account_au
BEFORE UPDATE OF account_id, currency ON money_balance_checkpoint
BEGIN
  SELECT RAISE(ABORT, 'checkpoint currency must match its account (#1099)')
   WHERE NEW.currency IS NOT (SELECT currency FROM core_account WHERE account_id = NEW.account_id);
END;

CREATE TRIGGER IF NOT EXISTS core_transaction_money_rows_are_fixed
BEFORE UPDATE ON core_transaction
WHEN EXISTS (SELECT 1 FROM money_account WHERE account_id = OLD.account_id)
BEGIN
  SELECT RAISE(ABORT, 'a Money transaction is never edited after import: only its category and its void status move (#1099)')
   WHERE NEW.txn_id IS NOT OLD.txn_id
      OR NEW.account_id IS NOT OLD.account_id
      OR NEW.posted_at IS NOT OLD.posted_at
      OR NEW.amount_minor IS NOT OLD.amount_minor
      OR NEW.currency IS NOT OLD.currency
      OR NEW.direction IS NOT OLD.direction
      OR NEW.transfer_group_id IS NOT OLD.transfer_group_id
      OR NEW.counterparty_party_id IS NOT OLD.counterparty_party_id
      OR NEW.description IS NOT OLD.description
      OR NEW.external_id IS NOT OLD.external_id
      OR NEW.created_at IS NOT OLD.created_at
      OR (NEW.status IS NOT OLD.status AND NEW.status <> 'void')
      OR (OLD.status = 'void' AND NEW.status <> 'void');
END;

-- ---------------------------------------------------------------------------
-- Vocabulary: the `transfer` relation, for a vault that already has the scheme.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO core_concept
  (concept_id, scheme_id, notation, pref_label, created_at, updated_at)
SELECT 'money:relation:transfer', scheme_id, 'transfer', 'Transfer',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM core_concept_scheme
 WHERE uri = 'urn:duaility:relations';

-- ---------------------------------------------------------------------------
-- Vocabulary: the categories scheme, nine groups and fourteen categories.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO core_concept_scheme
  (scheme_id, uri, title, publisher, version, created_at)
VALUES ('money:categories', 'urn:centraid:money:categories', 'Money categories', 'centraid', '1',
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

WITH seed(notation, label, parent) AS (VALUES
  ('income',                   'Income',                   NULL),
  ('housing',                  'Housing',                  NULL),
  ('utilities',                'Utilities',                NULL),
  ('food',                     'Food',                     NULL),
  ('transport',                'Transport',                NULL),
  ('shopping',                 'Shopping',                 NULL),
  ('health',                   'Health',                   NULL),
  ('fun',                      'Fun and travel',           NULL),
  ('fees',                     'Fees and taxes',           NULL),
  ('income.pay',               'Pay',                      'income'),
  ('income.other',             'Other income',             'income'),
  ('housing.rent',             'Rent or mortgage',         'housing'),
  ('housing.home',             'Home and repairs',         'housing'),
  ('utilities.bills',          'Power, gas and water',     'utilities'),
  ('utilities.phone',          'Phone and internet',       'utilities'),
  ('food.groceries',           'Groceries',                'food'),
  ('food.dining',              'Dining out',               'food'),
  ('transport.fuel',           'Fuel',                     'transport'),
  ('transport.transit',        'Transit and rideshare',    'transport'),
  ('shopping.general',         'Clothes and household',    'shopping'),
  ('health.care',              'Health care',              'health'),
  ('fun.subscriptions',        'Subscriptions',            'fun'),
  ('fun.entertainment',        'Entertainment and travel', 'fun')
)
INSERT OR IGNORE INTO core_concept
  (concept_id, scheme_id, notation, pref_label, broader_concept_id, stable_id,
   created_at, updated_at)
SELECT 'money:cat:' || seed.notation,
       (SELECT scheme_id FROM core_concept_scheme WHERE uri = 'urn:centraid:money:categories'),
       seed.notation, seed.label,
       CASE WHEN seed.parent IS NULL THEN NULL ELSE 'money:cat:' || seed.parent END,
       seed.notation,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM seed;
