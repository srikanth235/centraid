// The grant plane (issue #825). A share is a STANDING GRANT — an audience, a
// subject, a capability — and that meaning lives in `share_grant`. Delivery is
// a separate question: `share_fulfillment` holds one row per audience vault,
// so "who may see this" never again depends on whether a transport succeeded.
// The channel is not a third table: `share_party_vault_binding` (#731) already
// answers "does this person have a vault to deliver into", reframed by
// grant/channel.ts rather than duplicated. Commons (`share_circle_grant` and
// its op log) is NOT superseded — it stays the fulfillment STRATEGY for edit
// capability, the way closure reprojection is the strategy for view.

// Polymorphic `(subject_type, subject_id)`: the subject vocabulary is
// `ShareableItemType` (share/closure.ts), which spans core, docs, media and
// tally tables, so no SQL foreign key can express it. `audience_id` is
// likewise polymorphic BY KIND — `core_party.party_id` when `audience_kind`
// is 'party', `social_circle.circle_id` when 'circle' — and carries no FK for
// the same reason. `granted_by` is always an owner party, so that one is a
// real reference.
/**
 * `share_fulfillment`'s columns, named once so the delivery-memory rung below
 * can rebuild the table against exactly this shape.
 *
 * `delivered_at` is the DURABLE memory of delivery, and it is deliberately not
 * derivable from `state`. `state` is a live freshness reading: a pass that
 * cannot reach the peer drops a `delivered` row back to `syncing`, which is
 * honest about the copy possibly being stale. Revocation asks a different
 * question — "did this peer ever receive the subject?" — and reading the
 * answer off `state` made a delivered-then-degraded grant settle `removed`
 * ("nothing had been delivered") while the audience vault still held the whole
 * projection: the owner was told a share was gone when it was not (#846 P1).
 * Set once, on the first delivery, and cleared only by a removal that
 * verifiably took the projection with it.
 */
const SHARE_FULFILLMENT_COLUMNS = `
  grant_id      TEXT NOT NULL REFERENCES share_grant(grant_id) ON DELETE CASCADE,
  peer_vault_id TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN
    ('awaiting_channel','syncing','delivered','remove_sent','removed')),
  updated_at    TEXT NOT NULL,
  -- Latest note: a refusal reason, a transport error, why a removal stalled.
  detail        TEXT,
  -- When the subject first reached this peer. NULL = never delivered.
  delivered_at  TEXT,
  PRIMARY KEY (grant_id, peer_vault_id)`;

export const SHARE_GRANT_DDL = `
CREATE TABLE IF NOT EXISTS share_grant (
  grant_id       TEXT PRIMARY KEY,
  audience_kind  TEXT NOT NULL CHECK (audience_kind IN ('party','circle')),
  audience_id    TEXT NOT NULL,
  subject_type   TEXT NOT NULL,
  subject_id     TEXT NOT NULL,
  capability     TEXT NOT NULL CHECK (capability IN ('view','edit')),
  granted_at     TEXT NOT NULL,
  revoked_at     TEXT,
  granted_by     TEXT NOT NULL REFERENCES core_party(party_id),
  -- Per-grant ceiling carried from the commons grant it descends from; NULL
  -- means the vault-wide default applies.
  max_size_bytes INTEGER CHECK (max_size_bytes IS NULL OR max_size_bytes >= 0)
) STRICT;
-- One LIVE grant per audience x subject. Revoked rows are history and are
-- deliberately outside the constraint, so re-granting after a revoke inserts
-- rather than resurrecting.
CREATE UNIQUE INDEX IF NOT EXISTS share_grant_live_audience_subject
  ON share_grant(audience_kind, audience_id, subject_type, subject_id)
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS share_grant_subject
  ON share_grant(subject_type, subject_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS share_grant_audience
  ON share_grant(audience_kind, audience_id);
CREATE INDEX IF NOT EXISTS share_grant_granted_by
  ON share_grant(granted_by);

-- Per-audience-vault delivery state for one grant. The FK's child column is
-- the leftmost column of the primary key, which is the index cover
-- schema/fk-index.test.ts requires.
CREATE TABLE IF NOT EXISTS share_fulfillment (${SHARE_FULFILLMENT_COLUMNS}
) STRICT;
`;

// Rung: create the two tables on vaults stamped before #825, then restate the
// live commons grants as standing grants. Pure SQL, no host clock — every
// timestamp is carried from the source row, and minted ids may be random
// because a grant id is never replayed or reconciled across vaults.
//
// Audience shape. An implicit circle is an anonymous roster wrapper, never a
// thing the owner named, so its grant becomes one PARTY grant per member. A
// named circle stays a CIRCLE grant only when nobody has refused AND its
// members agree on one capability; a circle row over a roster containing a
// refused party would reach that party again (roster unions have no refusal
// filter), and one row over disagreeing capabilities could only lie about
// someone — either way the grant decomposes into party rows. Refused members
// get no grant: a refused invitation was never a standing permission. The
// limit case is deliberate: a live named-circle grant EVERY member refused
// decomposes to nothing and does not migrate — it permits no one, the refusals
// and the commons row both survive untouched as the record, and re-sharing
// the circle re-creates it.
//
// Collisions. Two commons grants can reach the same party for the same
// subject (two circles, one member). The live-uniqueness index forbids two
// rows there, so candidates are ranked deterministically — strongest
// capability, then earliest grant, then source grant id — and the winner is
// the one that lands. Nothing in share_circle_grant or any other commons
// table is read for anything but SELECT.
export const SHARE_GRANT_BACKFILL_DDL = `
${SHARE_GRANT_DDL}

-- One candidate per (live commons grant x roster member). A named circle with
-- an empty roster still produces one row, with a NULL member, so its grant is
-- not silently dropped.
CREATE TEMP TABLE share_grant_seed AS
SELECT
  g.grant_id AS source_grant_id,
  g.circle_id AS circle_id,
  CASE WHEN g.implicit_circle = 0
        AND NOT EXISTS (
          SELECT 1 FROM social_circle_member r
            LEFT JOIN share_commons_member_state rs
              ON rs.grant_id = g.grant_id AND rs.party_id = r.party_id
           WHERE r.circle_id = g.circle_id
             AND COALESCE(rs.status, 'invited') = 'refused'
        )
        AND (
          SELECT COUNT(DISTINCT v.capability)
            FROM social_circle_member v
           WHERE v.circle_id = g.circle_id
        ) <= 1 THEN 'circle' ELSE 'party' END AS audience_kind,
  m.party_id AS member_party_id,
  COALESCE(ms.status, 'invited') AS member_status,
  g.container_type AS subject_type,
  g.container_id AS subject_id,
  CASE m.capability WHEN 'read+write' THEN 'edit' ELSE 'view' END AS capability,
  g.created_at AS granted_at,
  g.steward_party_id AS granted_by,
  g.max_size_bytes AS max_size_bytes,
  b.vault_id AS peer_vault_id,
  b.binding_live AS binding_live
FROM share_circle_grant g
LEFT JOIN social_circle_member m ON m.circle_id = g.circle_id
LEFT JOIN share_commons_member_state ms
  ON ms.grant_id = g.grant_id AND ms.party_id = m.party_id
LEFT JOIN (
  SELECT party_id, vault_id, (revoked_at IS NULL) AS binding_live,
         ROW_NUMBER() OVER (
           PARTITION BY party_id
           ORDER BY (revoked_at IS NULL) DESC, linked_at DESC, binding_id
         ) AS pick
    FROM share_party_vault_binding
) b ON b.party_id = m.party_id AND b.pick = 1
WHERE g.revoked_at IS NULL
  AND g.plane = 'commons'
  AND COALESCE(ms.status, 'invited') <> 'refused';

CREATE TEMP TABLE share_grant_mint AS
SELECT lower(hex(randomblob(16))) AS grant_id, audience_kind, audience_id,
       subject_type, subject_id, capability, granted_at, granted_by,
       max_size_bytes
FROM (
  SELECT
    s.audience_kind AS audience_kind,
    CASE WHEN s.audience_kind = 'circle' THEN s.circle_id
         ELSE s.member_party_id END AS audience_id,
    s.subject_type AS subject_type,
    s.subject_id AS subject_id,
    s.capability AS capability,
    s.granted_at AS granted_at,
    s.granted_by AS granted_by,
    s.max_size_bytes AS max_size_bytes,
    ROW_NUMBER() OVER (
      PARTITION BY s.audience_kind,
        CASE WHEN s.audience_kind = 'circle' THEN s.circle_id
             ELSE s.member_party_id END,
        s.subject_type, s.subject_id
      ORDER BY CASE s.capability WHEN 'edit' THEN 0 ELSE 1 END,
               s.granted_at, s.source_grant_id
    ) AS pick
  FROM share_grant_seed s
  WHERE s.audience_kind = 'circle' OR s.member_party_id IS NOT NULL
)
WHERE pick = 1;

INSERT INTO share_grant
  (grant_id, audience_kind, audience_id, subject_type, subject_id, capability,
   granted_at, revoked_at, granted_by, max_size_bytes)
SELECT grant_id, audience_kind, audience_id, subject_type, subject_id,
       capability, granted_at, NULL, granted_by, max_size_bytes
FROM share_grant_mint;

-- Delivery state per audience vault. A member with no binding row at all has
-- no vault to name, and the primary key needs one, so no fulfillment row is
-- written: absence simply means "no channel yet" — the channel question is
-- answered separately (channelForParty, over bindings and pending
-- invitations), so nothing needs a placeholder row. A member whose only
-- binding is revoked keeps that vault id at 'awaiting_channel' — the peer is
-- known, the channel is not open.
INSERT INTO share_fulfillment (grant_id, peer_vault_id, state, updated_at, detail)
SELECT grant_id, peer_vault_id, state, updated_at, NULL
FROM (
  SELECT
    n.grant_id AS grant_id,
    s.peer_vault_id AS peer_vault_id,
    CASE WHEN s.binding_live = 0 THEN 'awaiting_channel'
         WHEN s.member_status = 'current' THEN 'delivered'
         ELSE 'syncing' END AS state,
    n.granted_at AS updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY n.grant_id, s.peer_vault_id
      ORDER BY CASE WHEN s.binding_live = 0 THEN 2
                    WHEN s.member_status = 'current' THEN 0 ELSE 1 END,
               s.source_grant_id
    ) AS pick
  FROM share_grant_seed s
  JOIN share_grant_mint n
    ON n.audience_kind = s.audience_kind
   AND n.audience_id = CASE WHEN s.audience_kind = 'circle' THEN s.circle_id
                            ELSE s.member_party_id END
   AND n.subject_type = s.subject_type
   AND n.subject_id = s.subject_id
  WHERE s.peer_vault_id IS NOT NULL
)
WHERE pick = 1;

DROP TABLE share_grant_seed;
DROP TABLE share_grant_mint;
`;

// Rung (issue #846 P1): carry `share_fulfillment.delivered_at` to vaults
// stamped before it. Editing the baseline above only reaches files created
// after the edit — `migrate()` applies rungs past `PRAGMA user_version`, so a
// file already at the grant-plane rung keeps the shape it was born with, and
// every read of `delivered_at` would throw at SQLite.
//
// The standard table rebuild (SQLite docs, "Making Other Kinds Of Table Schema
// Changes") rather than `ALTER TABLE ... ADD COLUMN`, for the same reason the
// people_profile rung uses one: SQLite has no `ADD COLUMN IF NOT EXISTS`, and
// this rung must also be walked by a FRESH file that just got the column from
// the baseline. The copy names its source columns explicitly and does NOT read
// `delivered_at`, so the same statement is correct against both shapes — an
// upgrade for an old file, a faithful no-op re-creation for a new one.
//
// Backfill. `delivered` and `remove_sent` both mean the projection reached the
// peer, so those rows are stamped with the only delivery instant the file
// carries (`updated_at`). Everything else is left NULL: a `syncing` row that
// was in fact delivered before this rung cannot be recovered from the file,
// and inventing a timestamp for it would be worse than not knowing. That gap
// is bounded in practice because the removal path also LOOKS inside a
// reachable audience vault rather than trusting the row alone.
//
// Foreign keys: `defer_foreign_keys` is the in-transaction equivalent of the
// `foreign_keys=off` SQLite's 12-step procedure wants — the pragma is a no-op
// inside a transaction and every rung runs in one. Constraint enforcement
// moves to COMMIT, so the intermediate DROP/RENAME cannot trip a check while a
// real violation still aborts the rung. Nothing REFERENCES share_fulfillment,
// so the drop orphans no children; its own FK to share_grant is re-declared
// verbatim and the copied rows point at the same parents.
export const SHARE_FULFILLMENT_DELIVERY_MEMORY_DDL = `
PRAGMA defer_foreign_keys = ON;
CREATE TABLE share_fulfillment_new (${SHARE_FULFILLMENT_COLUMNS}
) STRICT;
INSERT INTO share_fulfillment_new
  (grant_id, peer_vault_id, state, updated_at, detail, delivered_at)
SELECT
  grant_id, peer_vault_id, state, updated_at, detail,
  CASE WHEN state IN ('delivered','remove_sent') THEN updated_at END
FROM share_fulfillment;
DROP TABLE share_fulfillment;
ALTER TABLE share_fulfillment_new RENAME TO share_fulfillment;
`;
