import { UPDATED_AT_DEFAULT, touchUpdatedAt } from "./updated-at.js";

// The one authority plane (#883 V-table): every standing answer about who may
// do what — person, circle, harness, or the member's own device — is a row in
// `share_authority`. App-strategy machinery, gateway-side enrollment
// attenuation and runtime provider consent stay out of it (V-split).

// Polymorphic BOTH ways, so neither pair can carry a SQL foreign key. The
// trigger on `core_entity` that revokes a purged subject's answers writes to
// this table, so it is composed before that trigger (#916, E2).
/**
 * PRINCIPAL KINDS THAT ARE ROWS, and the entity kind each one's id lives in
 * (#916, audit F3).
 *
 * `principal_id` carries no foreign key — it cannot, it is polymorphic on
 * `principal_kind` — so `core_entity_revoke_on_purge` is what ends an answer
 * whose PRINCIPAL is purged, and it generates its clause from this map. The
 * clause was written for `person` alone, which left a circle-principal answer
 * standing after `tally.delete_group` or `share/removal.ts` deleted the circle:
 * a live answer whose audience no longer exists, which is exactly what the
 * trigger says must not happen.
 *
 * The three kinds NOT here are not rows: a `harness` principal is an engine
 * class (its ids are a closed vocabulary, see the CHECK below), a `device`
 * lives in the access plane, which is machinery rather than an ontology pack
 * and so has no `core_entity` row to purge, and an `automation` is named by
 * its MANIFEST REF (`<app_id>/<automation_id>`, `automation/manifest/ref.ts`)
 * — a compiled manifest, not a row of any table in this file; the closest
 * thing it has to storage is `automation_state`, keyed by that same ref with
 * no foreign key. `ontology-shape.test.ts` holds the CHECK's vocabulary to
 * being exactly this map plus that set, so a further principal kind cannot be
 * added without answering the question.
 */
export const PRINCIPAL_ENTITY_KINDS: ReadonlyMap<string, string> = new Map([
  ["person", "core.party"],
  ["circle", "social.circle"],
]);

/** Principal kinds whose id is not an entity id — see the map above. */
export const NON_ENTITY_PRINCIPAL_KINDS: ReadonlySet<string> = new Set([
  "harness",
  "device",
  "automation",
]);

export const SHARE_AUTHORITY_DDL = `
CREATE TABLE share_authority (
  authority_id   TEXT PRIMARY KEY,
  -- 'automation' is ACCEPTED here with no writer yet: #928 wave 3 writes it,
  -- when an automation's compiled manifest mints one row per (pack or entity
  -- x read|act) and the owner's refusals become 'declined' rows. Accepting it
  -- a wave early is what lets that wave land without a schema change. The
  -- 'app' kind is deliberately NOT here — first-party apps are not principals
  -- (#928 A1), and a third-party door would be a new answer, not a new value.
  principal_kind TEXT NOT NULL CHECK (principal_kind IN
    ('person','circle','harness','device','automation')),
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
  -- Why the answer ended, when it ended for a reason the member did not state
  -- in the moment (#916, E2): the purge of the subject revokes every live
  -- answer about it through a trigger on \`core_entity\`, and 'subject-purged'
  -- is what that trigger writes. NULL for an ordinary owner revoke, where the
  -- receipt is the reason.
  revoked_reason TEXT,
  -- -> access.receipt, in the append-only audit band. A VALUE, not a key: an
  -- audit outlives its subject (#916). NULL until the receipt is written,
  -- never a second copy of it.
  receipt_id     TEXT,
  CHECK ((duration = 'until-date') = (expires_at IS NOT NULL)),
  -- 'automation' is deliberately NOT exempted: the owner APPROVES an
  -- automation's manifest, so there is always a party who answered, and a row
  -- minted without one would be an automation that granted itself (#928 A3).
  CHECK (granted_by IS NOT NULL OR principal_kind IN ('harness','device')),
  -- The one principal whose id is a closed vocabulary rather than a row id:
  -- a harness principal is an ENGINE CLASS, and an egress class outside the
  -- three enrich-gate.ts knows is unrepresentable here exactly as it was
  -- unrepresentable in \`enrich_consent.egress\` (#807).
  CHECK (principal_kind <> 'harness'
         OR principal_id IN ('on-device','gateway','provider'))
) STRICT;
-- One LIVE answer per (principal x subject x verb). Revoked rows are history
-- and are deliberately outside the constraint, so re-answering after a revoke
-- inserts rather than resurrecting — which is what makes the plane auditable:
-- a row is immutable except for \`revoked_at\`.
--
-- \`duration\` LEFT THE KEY under #916 (R7 / review 6.2). With it in, the same
-- principal could hold a 'standing' answer AND an 'until-date' answer to the
-- same question at the same time, and every resolver had to pick one — so the
-- constraint that exists to make "what did the member say" have ONE answer
-- allowed two. Duration is part of the ANSWER, not of the question.
CREATE UNIQUE INDEX IF NOT EXISTS share_authority_live_answer
  ON share_authority(principal_kind, principal_id, subject_type, subject_id,
                     verb)
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
CREATE TABLE share_delivery_config (
  grant_id       TEXT PRIMARY KEY
    REFERENCES share_authority(authority_id) ON DELETE CASCADE,
  max_size_bytes INTEGER CHECK (max_size_bytes IS NULL OR max_size_bytes >= 0)
) STRICT;

-- Per-audience-vault DELIVERY state for one authority row. The FK's child
-- column is the leftmost column of the primary key, which is the index cover
-- schema/fk-index.test.ts requires.
--
-- \`delivered_at\` is the DURABLE memory of delivery, deliberately not derivable
-- from \`state\`, which is a live freshness reading: an unreachable pass drops a
-- \`delivered\` row to \`syncing\`. Revocation asks a different question — "did
-- this peer ever receive the subject?" — and answering it from \`state\` settles
-- a degraded grant \`removed\` while the audience still holds the projection
-- (#846). Set once on first delivery, cleared only by a verified removal.
CREATE TABLE share_fulfillment (
  grant_id      TEXT NOT NULL
    REFERENCES share_authority(authority_id) ON DELETE CASCADE,
  peer_vault_id TEXT NOT NULL,
  -- awaiting_channel means the peer vault is known and the link to it has
  -- ended (#903). It is deliberately NOT narrowed out of this CHECK: that
  -- state is still reachable — link, share, then unlink — and only the
  -- retired reading of it ("waiting on an invitation to be claimed") is gone.
  state         TEXT NOT NULL CHECK (state IN
    ('awaiting_channel','syncing','delivered','remove_sent','removed')),
  updated_at    TEXT NOT NULL DEFAULT ${UPDATED_AT_DEFAULT},
  -- Latest note: a refusal reason, a transport error, why a removal stalled.
  detail        TEXT,
  -- When the subject first reached this peer. NULL = never delivered.
  delivered_at  TEXT,
  PRIMARY KEY (grant_id, peer_vault_id)
) STRICT;
${touchUpdatedAt("share_fulfillment", ["grant_id", "peer_vault_id"])}
`;

/**
 * `share_delivery_config` RE-CUT with the rail's second half (#929, rung three).
 *
 * A grant's delivery config now carries `departure_policy` beside its ceiling:
 * what a departing audience leaves behind in the REMAINING audiences'
 * projections — `remove-member-only` scrubs their rows, `retain-ledger-history`
 * keeps them so an accounting group's balances stay computable (SECURITY.md
 * § departure). It is the commons rail's own column, carried across by
 * `migrateCommonsToSubscriptions` before the rail is dropped.
 *
 * A RE-CUT, not an `ALTER … ADD COLUMN`: SQLite appends an added column to the
 * table's STORED text, so a migrated file would carry DDL no fresh build can
 * produce, and `golden-vault.test.ts` compares exactly that. Rebuilding the
 * table leaves one text for both.
 */
export const SHARE_DELIVERY_CONFIG_RECUT_DDL = `
ALTER TABLE share_delivery_config RENAME TO share_delivery_config_pre929;
CREATE TABLE share_delivery_config (
  grant_id         TEXT PRIMARY KEY
    REFERENCES share_authority(authority_id) ON DELETE CASCADE,
  max_size_bytes   INTEGER CHECK (max_size_bytes IS NULL OR max_size_bytes >= 0),
  departure_policy TEXT NOT NULL DEFAULT 'remove-member-only'
    CHECK (departure_policy IN ('remove-member-only','retain-ledger-history'))
) STRICT;
INSERT INTO share_delivery_config (grant_id, max_size_bytes)
  SELECT grant_id, max_size_bytes FROM share_delivery_config_pre929;
DROP TABLE share_delivery_config_pre929;
`;
