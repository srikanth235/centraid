// SHAPE CHANGES TO THE CORE SPINE MADE AFTER THE BASELINE FROZE.
//
// `core.ts` is rung one: the composed baseline, which is HISTORY and does not
// grow (`migrate.ts`). Every core-spine change since is a RUNG, and each one
// lives here beside the ruling that made it, so the baseline stays the shape
// v0 shipped and this file is the list of what happened to it.
//
// The three forms a change takes, and what decides which, are documented on
// `VaultMigration` in `migrate.ts`: an added column is an `ALTER` that only
// the rung states, an added table is stated twice (baseline + `IF NOT
// EXISTS`), and a REMOVED constraint is SQLite's twelve-step re-cut, which
// needs foreign keys off and `legacy_alter_table` on.

import { ftsSyncTriggersFor } from "./fts.js";
import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

/**
 * `core_party_identifier` RE-CUT: the interval, the issuer, and the primary
 * preference read over live rows only (#996, ruling R20(e), rung six).
 *
 * Three findings, one shape. (1) The VALUE index has been partial on
 * `valid_to IS NULL` since [#916] because uniqueness is a claim about what is
 * true NOW; the PRIMARY-PREFERENCE index was not, so an end-dated primary —
 * the row that records "this used to be my main handle" — blocked a new one
 * forever, and retiring a primary meant deleting the history of it. (2) An
 * interval could run backwards: `valid_to < valid_from` was representable and
 * makes "was this live on that date" unanswerable. (3) A short handle is not
 * globally unique, so the register had no way to say WHICH namespace a value
 * belongs to — `@alice` on two services was one row's worth of space for two
 * people's identity.
 *
 * A RE-CUT, not `ALTER … ADD COLUMN`: SQLite appends an added column to the
 * table's STORED text, so a migrated file would carry DDL no fresh build can
 * produce, and `golden-vault.test.ts` compares exactly that (the same reason
 * #929's `share_delivery_config` rung is a re-cut).
 *
 * Nothing in the model references `core_party_identifier`, so the rename needs
 * no `legacy_alter_table` guard: there is no child FK clause for SQLite to
 * rewrite.
 */
export const CORE_PARTY_IDENTIFIER_RECUT_DDL = `
ALTER TABLE core_party_identifier RENAME TO core_party_identifier_pre996;
CREATE TABLE core_party_identifier (
  identifier_id TEXT PRIMARY KEY,
  party_id      TEXT NOT NULL REFERENCES core_party(party_id),
  -- No 'email'/'tel' (#883, ruling O-contact): an address you can REACH a
  -- person at is a \`social.contact_channel\`, not an identity register entry.
  scheme        TEXT NOT NULL CHECK (scheme IN ('url','did','handle','iban','other')),
  value         TEXT NOT NULL,
  -- THE NAMESPACE THE VALUE IS UNIQUE WITHIN (#996, R20(e)). NULL means
  -- "globally unique by construction" — a DID, an IBAN, a URL — and the live
  -- index folds NULL to the empty string so those keep the single namespace
  -- they always had.
  issuer        TEXT,
  label         TEXT,
  is_primary    INTEGER NOT NULL CHECK (is_primary IN (0,1)),
  verified_at   TEXT,
  valid_from    TEXT NOT NULL,
  valid_to      TEXT,
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- AN INTERVAL RUNS FORWARD (#996, R20(e)). Table-level: it names two columns.
  CHECK (valid_to IS NULL OR valid_to >= valid_from),
  FOREIGN KEY (identifier_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
  -- No UNIQUE (scheme, value) (#916, R3 / review 2.3). The constraint covered
  -- HISTORICAL rows too, so an address one person stopped using could never be
  -- recorded for the person who now holds it — and identity merge could not
  -- move an identifier without first end-dating and deleting it. Uniqueness is
  -- a claim about what is TRUE NOW, so it is a partial index over the live
  -- rows and nothing else.
) STRICT;
INSERT INTO core_party_identifier
  (identifier_id, party_id, scheme, value, label, is_primary, verified_at,
   valid_from, valid_to, updated_at)
  SELECT identifier_id, party_id, scheme, value, label, is_primary, verified_at,
         valid_from, valid_to, updated_at
    FROM core_party_identifier_pre996;
DROP TABLE core_party_identifier_pre996;
CREATE UNIQUE INDEX IF NOT EXISTS core_party_identifier_live_idx
  ON core_party_identifier(scheme, COALESCE(issuer, ''), value) WHERE valid_to IS NULL;
-- CURRENT PREFERENCE IS NOT HISTORY (#996, R20(e)): both indexes now ask the
-- same question of the same rows.
CREATE UNIQUE INDEX idx_party_identifier_primary
  ON core_party_identifier(party_id, scheme) WHERE is_primary = 1 AND valid_to IS NULL;
${touchUpdatedAt("core_party_identifier", "identifier_id")}
`;

/**
 * `core_concept` gains CONCEPT IDENTITY (#996, ruling R20(d), rung six).
 *
 * A concept's LABEL was its identity: `tagNotation` lowercased a label and
 * stripped everything outside `[a-z0-9]`, so `猫`, `犬`, `कुत्ता` and `बिल्ली`
 * all normalised to `untitled` and selected ONE concept — four animals filed
 * as one idea, silently, on every non-Latin vault. Three columns separate the
 * three jobs the notation was doing at once:
 *
 *   - `stable_id` — a provider's own concept id where the source has one; the
 *     identity a label can never be.
 *   - `normalized_key` — a UNICODE-PRESERVING normalised key (NFKC, collapsed
 *     whitespace, case-folded) for the schemes where only labels exist. It is
 *     what `ensureConcept` selects on now; `notation` goes back to being the
 *     64-character ASCII SLUG it always looked like, with collision cases
 *     given a suffix rather than a shared row.
 *   - `pref_label_lang` — the original label's language tag, so "the label" is
 *     answerable in the language it was written in.
 *
 * Both indexes are partial: a row that carries no stable id, or no key yet,
 * constrains nothing. Existing rows are backfilled ON TOUCH rather than by a
 * migration UPDATE, because NFKC is not a SQLite function and a rung that
 * cannot compute the value must not guess it.
 *
 * `ALTER … ADD COLUMN`, not a re-cut: the column is added by this rung on a
 * FRESH file and on a migrated one alike — it is deliberately NOT in the
 * baseline — so both carry the identical stored DDL text `golden-vault.test.ts`
 * compares. A re-cut would also be wrong here: nine tables key into
 * `core_concept`, and renaming it rewrites every one of their FK clauses.
 */
export const CORE_CONCEPT_IDENTITY_DDL = `
ALTER TABLE core_concept ADD COLUMN stable_id TEXT;
ALTER TABLE core_concept ADD COLUMN normalized_key TEXT;
ALTER TABLE core_concept ADD COLUMN pref_label_lang TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS core_concept_stable_idx
  ON core_concept(scheme_id, stable_id) WHERE stable_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS core_concept_key_idx
  ON core_concept(scheme_id, normalized_key) WHERE normalized_key IS NOT NULL;
`;

/**
 * `core_transaction` RE-CUT: a provider-local id is scoped to its SOURCE
 * (#996, ruling R20(c), rung seven).
 *
 * `external_id` carried a GLOBAL `UNIQUE` while the comment five lines above
 * it said the right key is `(connection_id, external_id)` — a key the table
 * could not express, so the constraint was kept as the nearest available
 * thing. It is not near: two banks both call a statement line `ref-1`, and the
 * global key made the second import of that string either a merge into another
 * institution's transaction or a hard refusal. Neither is a true answer.
 *
 * The authoritative key already exists, one table over:
 * `sync_external_entity (connection_id, external_id)` is UNIQUE and is what
 * `stageCandidates` consults FIRST. Removing the global constraint leaves that
 * as the only claim about provider ids, which is what it always was.
 *
 * A RE-CUT with `{ recut }`, not an `ALTER`: a column-level `UNIQUE` is an
 * implicit index no `DROP INDEX` can name, so the twelve-step rebuild is the
 * only way to remove it — see `migrate.ts`'s `VaultMigration`. The FTS sync
 * triggers come back from `ftsSyncTriggersFor`, because they live ON the base
 * table and go down with it; the fts5 shadow and its rows do not.
 */
export const CORE_TRANSACTION_RECUT_DDL = `
DROP TRIGGER IF EXISTS fts_core_transaction_ai;
DROP TRIGGER IF EXISTS fts_core_transaction_au;
DROP TRIGGER IF EXISTS fts_core_transaction_ad;
ALTER TABLE core_transaction RENAME TO core_transaction_pre996;
CREATE TABLE core_transaction (
  txn_id                TEXT PRIMARY KEY,
  account_id            TEXT NOT NULL REFERENCES core_account(account_id),
  posted_at             TEXT NOT NULL,
  -- A magnitude, never a signed number (#916, R2 / review 10.2): \`direction\`
  -- is the sign, and a negative debit meant two contradicting answers.
  amount_minor          INTEGER NOT NULL CHECK (amount_minor > 0),
  currency              TEXT NOT NULL CHECK (length(currency) = 3),
  direction             TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  status                TEXT NOT NULL CHECK (status IN ('pending','posted','void')),
  transfer_group_id     TEXT,
  counterparty_party_id TEXT REFERENCES core_party(party_id),
  description           TEXT,
  category_concept_id   TEXT REFERENCES core_concept(concept_id),
  -- NO GLOBAL UNIQUE (#996, R20(c)). A provider-local id is scoped to its
  -- source: the authoritative key is \`sync_external_entity
  -- (connection_id, external_id)\`, which \`stageCandidates\` consults before
  -- any publisher probe. Two institutions may both mint \`ref-1\` and they are
  -- two transactions; a cross-source match is explicit reviewable evidence,
  -- never an equal reference string.
  external_id           TEXT,
  created_at            TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at            TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  FOREIGN KEY (txn_id) REFERENCES core_entity(entity_id) ON DELETE CASCADE
) STRICT;
INSERT INTO core_transaction
  (txn_id, account_id, posted_at, amount_minor, currency, direction, status,
   transfer_group_id, counterparty_party_id, description, category_concept_id,
   external_id, created_at, updated_at)
  SELECT txn_id, account_id, posted_at, amount_minor, currency, direction, status,
         transfer_group_id, counterparty_party_id, description, category_concept_id,
         external_id, created_at, updated_at
    FROM core_transaction_pre996;
DROP TABLE core_transaction_pre996;
CREATE INDEX IF NOT EXISTS idx_transaction_account ON core_transaction(account_id);
CREATE INDEX IF NOT EXISTS idx_transaction_counterparty_party ON core_transaction(counterparty_party_id);
CREATE INDEX IF NOT EXISTS idx_transaction_category_concept ON core_transaction(category_concept_id);
-- The pair the sync map keys on, asked of the transaction side: "which rows
-- did this provider id produce" is a real question once it is no longer unique.
CREATE INDEX IF NOT EXISTS core_transaction_external_idx
  ON core_transaction(external_id) WHERE external_id IS NOT NULL;
${touchUpdatedAt("core_transaction", "txn_id")}
${ftsSyncTriggersFor("core.transaction")}
`;

/**
 * `core_content_text` — DECODED BODY TEXT AS A COLUMN (#996, rulings R4 / R8,
 * rung eight). Schema only in wave 0b: the function-free FTS triggers that
 * read it, and the retirement of `vault_content_text`, land in wave 1 with the
 * seat store.
 *
 * The FTS sync triggers call `vault_content_text(media_type, content_uri)`, an
 * APPLICATION-DEFINED SQL function only `openVaultDb` registers — which is
 * exactly why "only the gateway holds connections" was true, and why the
 * search index cannot follow the vault onto a seat: expo-sqlite 57 exposes no
 * way to register a SQL function, and a trigger has to index a COLUMN. So the
 * decode moves to write time on the gateway and lands here.
 *
 * A 1:1 side table, not a column on `core_content_item` (R8): a decoded body
 * is the widest value in the model, and a wide column on a hot table makes
 * every `SELECT *` over it pay for text nobody asked for.
 *
 * `ON DELETE CASCADE` because this is DERIVED, REBUILDABLE data owned by the
 * content row — the "owned child" deletion role (R22): it has no meaning, and
 * no life, apart from the bytes it decodes.
 */
export const CONTENT_TEXT_DDL = `
DROP TRIGGER IF EXISTS core_content_text_touch_updated_at;
CREATE TABLE IF NOT EXISTS core_content_text (
  content_id  TEXT PRIMARY KEY
    REFERENCES core_content_item(content_id) ON DELETE CASCADE,
  -- The decoded text itself. NOT NULL: a row exists because a decode
  -- succeeded, and "we could not decode these bytes" is the ABSENCE of a row,
  -- never an empty string that reads as an empty document.
  body_text   TEXT NOT NULL,
  -- What produced it, so a decoder change can rebuild exactly the rows it
  -- invalidates rather than the whole table.
  decoder     TEXT NOT NULL,
  -- The bytes this text was decoded FROM. Content is hash-addressed and
  -- immutable, so this is a staleness check against the decoder, not the row.
  byte_size   INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  updated_at  TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;
${touchUpdatedAt("core_content_text", "content_id")}
`;
