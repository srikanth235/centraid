// Circle-backed commons sharing (#731). Consent and the roster live in
// vault.db so backup/restore retains the relationship; the gateway compiles
// these rows into transport and projection mechanics after every mount.

import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

export const SHARE_COMMONS_DDL = `
ALTER TABLE social_circle_member ADD COLUMN capability TEXT NOT NULL DEFAULT 'read'
  CHECK (capability IN ('read','read+write'));

CREATE TABLE share_party_vault_binding (
  binding_id TEXT PRIMARY KEY,
  party_id   TEXT NOT NULL REFERENCES core_party(party_id),
  vault_id   TEXT NOT NULL,
  vault_public_key TEXT,
  linked_at  TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (party_id, vault_id)
) STRICT;
CREATE UNIQUE INDEX share_party_vault_binding_live_party
  ON share_party_vault_binding(party_id) WHERE revoked_at IS NULL;

-- A BINDING IS ABOUT SOMEONE ELSE (#916, R9 / review 6.5). The table says
-- "this person is reachable at that vault", and nothing stopped it recording
-- the member's own party at the member's own vault — a self-binding that makes
-- the member their own peer, so a share to them would be delivered by the
-- transport to the file it came from. SQLite cannot express "different from a
-- value in another table" in a CHECK, so it is a pair of triggers.
CREATE TRIGGER share_party_vault_binding_not_self_ai
BEFORE INSERT ON share_party_vault_binding
WHEN NEW.vault_id = (SELECT vault_id FROM core_vault LIMIT 1)
  OR NEW.party_id = (SELECT self_party_id FROM core_vault LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'share.party_vault_binding: a binding names another party''s vault, never this vault or its self party');
END;
CREATE TRIGGER share_party_vault_binding_not_self_au
BEFORE UPDATE OF party_id, vault_id ON share_party_vault_binding
WHEN NEW.vault_id = (SELECT vault_id FROM core_vault LIMIT 1)
  OR NEW.party_id = (SELECT self_party_id FROM core_vault LIMIT 1)
BEGIN
  SELECT RAISE(ABORT, 'share.party_vault_binding: a binding names another party''s vault, never this vault or its self party');
END;

CREATE TABLE share_circle_grant (
  grant_id          TEXT PRIMARY KEY,
  circle_id         TEXT NOT NULL REFERENCES social_circle(circle_id),
  container_type    TEXT NOT NULL,
  container_id      TEXT NOT NULL,
  plane             TEXT NOT NULL CHECK (plane IN ('give','commons')),
  departure_policy  TEXT NOT NULL DEFAULT 'remove-member-only'
    CHECK (departure_policy IN ('remove-member-only','retain-ledger-history')),
  implicit_circle   INTEGER NOT NULL DEFAULT 0 CHECK (implicit_circle IN (0,1)),
  steward_party_id  TEXT NOT NULL REFERENCES core_party(party_id),
  created_at        TEXT NOT NULL,
  revoked_at        TEXT,
  -- 'container-purged' when the trigger on \`core_entity\` ended it (#916, E2);
  -- NULL for an ordinary revoke, where the receipt is the reason.
  revoked_reason    TEXT,
  last_sequence     INTEGER NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  checkpoint_sequence INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_sequence >= 0),
  checkpoint_json   TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
  -- The chain head survives compaction: it lives here, not on the last
  -- surviving op, so pruning the verbose tail never loses the chain.
  chain_head_sequence INTEGER NOT NULL DEFAULT 0 CHECK (chain_head_sequence >= 0),
  chain_head_hash   TEXT NOT NULL,
  -- The steward's signature over (op_hash, state_digest, sequence) for the
  -- checkpoint in checkpoint_json.
  checkpoint_op_hash TEXT,
  checkpoint_state_digest TEXT,
  checkpoint_signature TEXT,
  checkpoint_signer_vault_id TEXT,
  max_size_bytes    INTEGER CHECK (max_size_bytes IS NULL OR max_size_bytes >= 0),
  UNIQUE (circle_id, container_type, container_id)
) STRICT;
CREATE INDEX share_circle_grant_container
  ON share_circle_grant(container_type, container_id) WHERE revoked_at IS NULL;
CREATE INDEX share_circle_grant_steward
  ON share_circle_grant(steward_party_id);

CREATE TABLE share_commons_member_state (
  grant_id    TEXT NOT NULL REFERENCES share_circle_grant(grant_id) ON DELETE CASCADE,
  party_id    TEXT NOT NULL REFERENCES core_party(party_id),
  status      TEXT NOT NULL CHECK (status IN ('invited','current','refused')),
  accepted_at TEXT,
  PRIMARY KEY (grant_id, party_id)
) STRICT;
CREATE INDEX share_commons_member_state_party
  ON share_commons_member_state(party_id);

CREATE TABLE share_commons_op (
  grant_id        TEXT NOT NULL REFERENCES share_circle_grant(grant_id) ON DELETE CASCADE,
  sequence        INTEGER NOT NULL CHECK (sequence > 0),
  op_id           TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN
    ('command','member_added','member_joined','member_refused','member_removed','capability_changed',
     'grant_revoked','steward_transferred','delete')),
  actor_party_id  TEXT NOT NULL REFERENCES core_party(party_id),
  command         TEXT,
  input_json      TEXT CHECK (input_json IS NULL OR json_valid(input_json)),
  member_signature TEXT,
  signing_vault_id TEXT,
  signature_nonce TEXT,
  outcome         TEXT NOT NULL CHECK (outcome IN ('executed','refused')),
  reason          TEXT,
  created_at      TEXT NOT NULL,
  -- Verifiable history: every op commits to its predecessor's hash, so a
  -- rewound or forked steward log cannot pass as a continuation.
  prev_hash       TEXT NOT NULL,
  op_hash         TEXT NOT NULL,
  PRIMARY KEY (grant_id, sequence)
) STRICT;
CREATE UNIQUE INDEX share_commons_op_signature_replay
  ON share_commons_op(grant_id, signing_vault_id, signature_nonce)
  WHERE signature_nonce IS NOT NULL;
CREATE INDEX share_commons_op_actor
  ON share_commons_op(actor_party_id);

-- Checkpoint compaction may discard verbose operations only after every
-- current member cursor passes them. Signed nonces retain this compact replay
-- decision so pruning never reopens an old member command.
CREATE TABLE share_commons_replay (
  grant_id         TEXT NOT NULL REFERENCES share_circle_grant(grant_id) ON DELETE CASCADE,
  signing_vault_id TEXT NOT NULL,
  signature_nonce  TEXT NOT NULL,
  sequence         INTEGER NOT NULL CHECK (sequence > 0),
  outcome          TEXT NOT NULL CHECK (outcome IN ('executed','refused')),
  reason           TEXT,
  PRIMARY KEY (grant_id, signing_vault_id, signature_nonce)
) STRICT;

CREATE TABLE share_commons_receipt (
  grant_id       TEXT NOT NULL REFERENCES share_circle_grant(grant_id) ON DELETE CASCADE,
  sequence       INTEGER NOT NULL CHECK (sequence > 0),
  kind           TEXT NOT NULL,
  actor_party_id TEXT NOT NULL,
  outcome        TEXT NOT NULL CHECK (outcome IN ('executed','refused')),
  reason         TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (grant_id, sequence)
) STRICT;

CREATE TABLE share_commons_cursor (
  grant_id        TEXT NOT NULL
    REFERENCES share_circle_grant(grant_id) ON DELETE CASCADE,
  member_vault_id TEXT NOT NULL,
  sequence        INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  updated_at      TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  PRIMARY KEY (grant_id, member_vault_id)
) STRICT;

-- What a member seat has PROVEN about its steward's history. Compaction may
-- drop the verbose ops behind it; the proven point must outlive them.
CREATE TABLE share_commons_verified (
  grant_id   TEXT PRIMARY KEY
    REFERENCES share_circle_grant(grant_id) ON DELETE CASCADE,
  sequence   INTEGER NOT NULL CHECK (sequence >= 0),
  op_hash    TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT}
) STRICT;

CREATE TABLE share_commons_lineage (
  grant_id       TEXT NOT NULL
    REFERENCES share_circle_grant(grant_id) ON DELETE CASCADE,
  -- \`target_*\`, the one name a polymorphic pair has in this vault (#916),
  -- and a real composite key into the entity supertype.
  target_type    TEXT NOT NULL,
  target_id      TEXT NOT NULL,
  origin_item_id TEXT NOT NULL,
  PRIMARY KEY (grant_id, target_type, target_id),
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX share_commons_lineage_item
  ON share_commons_lineage(target_type, target_id);

CREATE TABLE share_commons_retained (
  grant_id    TEXT NOT NULL
    REFERENCES share_circle_grant(grant_id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  retained_at TEXT NOT NULL,
  PRIMARY KEY (grant_id, target_type, target_id),
  FOREIGN KEY (target_type, target_id)
    REFERENCES core_entity(entity_type, entity_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX share_commons_retained_item
  ON share_commons_retained(target_type, target_id);

CREATE TABLE share_commons_intent (
  intent_id       TEXT PRIMARY KEY,
  -- NO FOREIGN KEY, deliberately (#916), for the same reason
  -- share_commons_invitation.grant_id has none: an intent is queued in the
  -- MEMBER seat, and queueCommonsIntent states outright that a seat with no
  -- local share_circle_grant row is legal -- no local grant row means 0, an
  -- unobserved history is honestly all-stale. A key here would make the ASK
  -- depend on having already projected the ANSWER, which is precisely the
  -- state a member queues an intent from.
  grant_id        TEXT NOT NULL,
  actor_party_id  TEXT NOT NULL,
  command         TEXT NOT NULL,
  input_json      TEXT NOT NULL CHECK (json_valid(input_json)),
  -- The grant sequence this member had projected locally when the command
  -- was composed (issue #731 stale-context protection). Computed and stored
  -- by queueCommonsIntent itself from the seat's own projected
  -- share_circle_grant.last_sequence -- never caller-supplied, so it cannot
  -- be a legacy-shape optional: every intent row states its own baseline.
  based_on_sequence INTEGER NOT NULL,
  -- ONE intent grammar (issue #750): these are the replica pending-write
  -- outbox's own state names, not a third vocabulary. 'queued' is what the
  -- outbox calls a durable write waiting to leave the seat; the commons rail
  -- adds no state the outbox lacks, so it borrows the outbox's word instead
  -- of rendering 'pending' beside 'queued' in the same user-visible list.
  status          TEXT NOT NULL CHECK (status IN
    ('queued','parked','denied','executed','expired','cancelled')),
  reason          TEXT,
  steward_label   TEXT,
  created_at      TEXT NOT NULL,
  settled_at      TEXT
) STRICT;
CREATE INDEX share_commons_intent_open
  ON share_commons_intent(grant_id, created_at)
  WHERE status IN ('queued','parked');

-- A peer invitation is consent metadata, not a projected grant. The full
-- authenticated consent metadata is held durably; no closure/domain row is
-- transmitted or applied until the receiving vault owner explicitly accepts.
CREATE TABLE share_commons_invitation (
  invitation_id     TEXT PRIMARY KEY,
  -- NO FOREIGN KEY, deliberately (#916, W2a). An invitation is queued in the
  -- RECEIVING vault, which does not hold the grant yet — holding it is what
  -- accepting the invitation DOES. A key here would make the ask depend on the
  -- answer. Same reading as \`member_party_id\` (schema/party-pointers.ts): a
  -- row the receiver may not have yet.
  grant_id          TEXT NOT NULL,
  steward_vault_id  TEXT NOT NULL,
  member_vault_id   TEXT,
  member_party_id   TEXT NOT NULL,
  capability        TEXT NOT NULL CHECK (capability IN ('read','read+write')),
  container_type    TEXT NOT NULL,
  container_id      TEXT NOT NULL,
  container_label   TEXT,
  current_size_bytes INTEGER NOT NULL CHECK (current_size_bytes >= 0),
  max_size_bytes    INTEGER CHECK (max_size_bytes IS NULL OR max_size_bytes >= 0),
  claim_token_hash  TEXT UNIQUE,
  status            TEXT NOT NULL CHECK (status IN ('pending','accepted','refused')),
  created_at        TEXT NOT NULL,
  answered_at       TEXT,
  UNIQUE (grant_id, member_party_id)
) STRICT;
CREATE INDEX share_commons_invitation_pending
  ON share_commons_invitation(member_vault_id, created_at)
  WHERE status = 'pending';
${touchUpdatedAt("share_commons_cursor", ["grant_id", "member_vault_id"])}
${touchUpdatedAt("share_commons_verified", "grant_id")}
`;
