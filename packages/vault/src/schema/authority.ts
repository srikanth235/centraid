// The one authority plane (#883 V-table): every standing answer about who may
// do what — person, circle, harness, or the member's own device — is a row in
// `share_authority`. App-strategy machinery, gateway-side enrollment
// attenuation and runtime provider consent stay out of it (V-split).

const SHARE_FULFILLMENT_COLUMNS = `
  grant_id      TEXT NOT NULL REFERENCES share_authority(authority_id) ON DELETE CASCADE,
  peer_vault_id TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN
    ('awaiting_channel','syncing','delivered','remove_sent','removed')),
  updated_at    TEXT NOT NULL,
  -- Latest note: a refusal reason, a transport error, why a removal stalled.
  detail        TEXT,
  -- When the subject first reached this peer. NULL = never delivered.
  delivered_at  TEXT,
  PRIMARY KEY (grant_id, peer_vault_id)`;

// Polymorphic BOTH ways, so neither pair can carry a SQL foreign key.
const SHARE_AUTHORITY_DDL = `
CREATE TABLE IF NOT EXISTS share_authority (
  authority_id   TEXT PRIMARY KEY,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN
    ('person','circle','harness','device')),
  principal_id   TEXT NOT NULL,
  subject_type   TEXT NOT NULL,
  -- '' where the subject is the whole of something the principal is already
  -- scoped to: this vault, for a device; every scope, for a vault-wide egress
  -- answer. Same empty-string argument as enrich_policy_rule.scope_ref — a NULL
  -- would let one vault-wide answer be recorded twice under the live index.
  subject_id     TEXT NOT NULL,
  -- Per (principal_kind x subject_type) vocabulary, not one global union:
  -- 'view'/'edit' for a share and for a device's reach over its vault, the
  -- enrichment capability for an egress answer. The registry that closes those
  -- triples is ruling V-registry's, and lands with the share.* command pack.
  verb           TEXT NOT NULL CHECK (length(verb) BETWEEN 1 AND 64),
  duration       TEXT NOT NULL CHECK (duration IN ('standing','until-date')),
  expires_at     TEXT,
  -- A refusal is an ANSWER, not an absent grant (ruling V-table): forgetting a
  -- 'declined' row would make "asked and told no" indistinguishable from "never
  -- asked", and it is what ruling V-mask's per-party refusal mask is written as.
  decision       TEXT NOT NULL CHECK (decision IN ('granted','declined')),
  granted_at     TEXT NOT NULL,
  -- The party who answered. NULL only where the member answered about their own
  -- machinery and no actor party was ever recorded (the egress answers carry
  -- none); the CHECK below keeps every person/circle row honest, which is what
  -- makes grant/grant-store.ts's non-null narrowing sound.
  granted_by     TEXT REFERENCES core_party(party_id),
  revoked_at     TEXT,
  -- -> consent.receipt (journal.db). Cross-file, so engine-unenforceable and
  -- gateway-validated like every other journal pointer; NULL until the receipt
  -- is written, never a second copy of it.
  receipt_id     TEXT,
  CHECK ((duration = 'until-date') = (expires_at IS NOT NULL)),
  CHECK (granted_by IS NOT NULL OR principal_kind IN ('harness','device')),
  -- The one principal whose id is a closed vocabulary rather than a row id:
  -- a harness principal is an ENGINE CLASS, and an egress class outside the
  -- three enrich-gate.ts knows is unrepresentable here exactly as it was
  -- unrepresentable in \`enrich_consent.egress\` (#807).
  CHECK (principal_kind <> 'harness'
         OR principal_id IN ('on-device','gateway','provider'))
) STRICT;
-- One LIVE answer per (principal x subject x verb x duration). Revoked rows are
-- history and are deliberately outside the constraint, so re-answering after a
-- revoke inserts rather than resurrecting — which is what makes the plane
-- auditable: a row is immutable except for \`revoked_at\`.
CREATE UNIQUE INDEX IF NOT EXISTS share_authority_live_answer
  ON share_authority(principal_kind, principal_id, subject_type, subject_id,
                     verb, duration)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS share_authority_subject
  ON share_authority(subject_type, subject_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS share_authority_principal
  ON share_authority(principal_kind, principal_id);
CREATE INDEX IF NOT EXISTS share_authority_granted_by
  ON share_authority(granted_by);

-- Per-grant DELIVERY-strategy configuration, keyed by the authority row it
-- serves (ruling V-delivery: \`max_size_bytes\` belongs to delivery-strategy
-- config, not to the authority row — a ceiling is a property of how a subject
-- is shipped, not of whether the member said yes). Absent row = the vault-wide
-- default applies, exactly as a NULL \`share_grant.max_size_bytes\` did.
CREATE TABLE IF NOT EXISTS share_delivery_config (
  grant_id       TEXT PRIMARY KEY
    REFERENCES share_authority(authority_id) ON DELETE CASCADE,
  max_size_bytes INTEGER CHECK (max_size_bytes IS NULL OR max_size_bytes >= 0)
) STRICT;
`;

// Rung six (#883): fold the legacy authority stores into the table above and
// drop them in one pass. There is no baseline copy — a fresh file reaches this
// shape by walking the rung once, so the copies select from empty tables.
//
// `defer_foreign_keys` is the in-transaction form of `foreign_keys=off`: the
// plain pragma is a no-op inside a transaction, and every rung runs in one.
//
// `consent_device` DROPS A COLUMN, never rebuilds. Deferral defers VIOLATIONS,
// not ACTIONS, and `DROP TABLE` fires every child's ON DELETE CASCADE — a
// rebuild silently takes `blob_device_wrap_key` and `blob_device_content_key`
// with it. Replica triggers drop first: SQLite refuses to drop a column a
// trigger reads.
export const SHARE_AUTHORITY_MIGRATION_DDL = `
PRAGMA defer_foreign_keys = ON;

${SHARE_AUTHORITY_DDL}

INSERT INTO share_authority
  (authority_id, principal_kind, principal_id, subject_type, subject_id, verb,
   duration, expires_at, decision, granted_at, granted_by, revoked_at,
   receipt_id)
SELECT grant_id,
       CASE audience_kind WHEN 'party' THEN 'person' ELSE 'circle' END,
       audience_id, subject_type, subject_id, capability,
       'standing', NULL, 'granted', granted_at, granted_by, revoked_at, NULL
FROM share_grant;

INSERT INTO share_delivery_config (grant_id, max_size_bytes)
SELECT grant_id, max_size_bytes FROM share_grant WHERE max_size_bytes IS NOT NULL;

INSERT INTO share_authority
  (authority_id, principal_kind, principal_id, subject_type, subject_id, verb,
   duration, expires_at, decision, granted_at, granted_by, revoked_at,
   receipt_id)
SELECT consent_id, 'harness', egress, 'enrich.scope', scope_ref, capability,
       'standing', NULL, decision, decided_at, NULL, NULL, receipt_id
FROM enrich_consent;

INSERT INTO share_authority
  (authority_id, principal_kind, principal_id, subject_type, subject_id, verb,
   duration, expires_at, decision, granted_at, granted_by, revoked_at,
   receipt_id)
SELECT lower(hex(randomblob(16))), 'device', device_id, 'core.vault', '',
       CASE trust WHEN 'full' THEN 'edit' ELSE 'view' END,
       'standing', NULL,
       CASE trust WHEN 'revoked' THEN 'declined' ELSE 'granted' END,
       enrolled_at, owner_party_id, NULL, NULL
FROM consent_device;

CREATE TABLE share_fulfillment_new (${SHARE_FULFILLMENT_COLUMNS}
) STRICT;
INSERT INTO share_fulfillment_new
  (grant_id, peer_vault_id, state, updated_at, detail, delivered_at)
SELECT grant_id, peer_vault_id, state, updated_at, detail, delivered_at
FROM share_fulfillment;
DROP TABLE share_fulfillment;
ALTER TABLE share_fulfillment_new RENAME TO share_fulfillment;

DROP TRIGGER IF EXISTS trg_replica_consent_device_ai;
DROP TRIGGER IF EXISTS trg_replica_consent_device_au;
DROP TRIGGER IF EXISTS trg_replica_consent_device_ad;
ALTER TABLE consent_device DROP COLUMN trust;

DROP TABLE share_grant;
DROP TABLE enrich_consent;
`;
