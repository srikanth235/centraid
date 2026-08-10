// Steward-absence detection, local sync instrumentation, and replica-export
// recovery lineage for the Commons plane (issue #731).
//
// The structural weakness these tables answer: a grant has exactly ONE steward
// vault, and its loss is silent and terminal for every member. Members already
// hold the whole state, so the missing pieces are (a) noticing, and (b) a
// ceremony that re-founds the group from a member's replica.
//
// Everything here is LOCAL to the device. Nothing in these tables is exported
// over the wire, projected into a member seat, or included in a bootstrap
// frame — they are this device's own observations about its own syncing.

export const COMMONS_RESILIENCE_DDL = `
-- Per (grant, member vault) record of contact with that grant's steward, plus
-- the cheap local counters the fixed-window-sync decision needs. One row is
-- written by the member's pull path on every attempt; nothing else writes it.
CREATE TABLE share_commons_steward_contact (
  grant_id             TEXT NOT NULL,
  member_vault_id      TEXT NOT NULL,
  steward_vault_id     TEXT,
  -- Last moment this seat PROVED it reached the steward (any successful pull,
  -- including a caught-up no-op). Absence is measured from here, never from a
  -- raw failure count: a laptop closed overnight fails many times and is not
  -- absent.
  last_contact_at      TEXT,
  last_attempt_at      TEXT,
  -- First failed attempt of the CURRENT unreachable episode; NULL while
  -- reachable. Escalation compares this against the wall clock.
  absence_since        TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  last_outcome         TEXT NOT NULL DEFAULT 'unknown' CHECK (last_outcome IN
    ('unknown','noop','tail','snapshot','tombstone','parked','unreachable')),
  last_error           TEXT,
  -- A NAMED divergence fault (not a transport failure). A seat carrying one is
  -- parked: it may not be used to re-found a group, because its replica is
  -- state it could not verify.
  fault                TEXT CHECK (fault IS NULL OR fault IN
    ('history-diverged','digest-mismatch')),
  faulted_at           TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  contacts             INTEGER NOT NULL DEFAULT 0 CHECK (contacts >= 0),
  pull_noop            INTEGER NOT NULL DEFAULT 0 CHECK (pull_noop >= 0),
  pull_tail            INTEGER NOT NULL DEFAULT 0 CHECK (pull_tail >= 0),
  pull_snapshot        INTEGER NOT NULL DEFAULT 0 CHECK (pull_snapshot >= 0),
  pull_tombstone       INTEGER NOT NULL DEFAULT 0 CHECK (pull_tombstone >= 0),
  pull_parked          INTEGER NOT NULL DEFAULT 0 CHECK (pull_parked >= 0),
  pull_unreachable     INTEGER NOT NULL DEFAULT 0 CHECK (pull_unreachable >= 0),
  absence_episodes     INTEGER NOT NULL DEFAULT 0 CHECK (absence_episodes >= 0),
  absent_ms            INTEGER NOT NULL DEFAULT 0 CHECK (absent_ms >= 0),
  longest_absence_ms   INTEGER NOT NULL DEFAULT 0 CHECK (longest_absence_ms >= 0),
  PRIMARY KEY (grant_id, member_vault_id)
) STRICT;

-- This DEVICE's own evidence that its network/peer link works at all: the last
-- moment any peer-plane request completed a round trip, whatever it answered.
-- Without this, every flight would look like every steward dying at once. A
-- grant escalates past "reachable" only when the device can show it was
-- reaching SOMETHING while that grant's steward stayed silent.
CREATE TABLE share_commons_device_reach (
  row_id             INTEGER PRIMARY KEY CHECK (row_id = 1),
  last_round_trip_at TEXT,
  round_trips        INTEGER NOT NULL DEFAULT 0 CHECK (round_trips >= 0),
  updated_at         TEXT NOT NULL
) STRICT;

-- Replica-export recovery lineage. The superseded grant is NEVER deleted: its
-- ops, receipts and projected rows stay exactly where they were. This row is
-- the local explanation of where the successor grant came from, and the
-- idempotency key for the ceremony (one successor per superseded grant).
CREATE TABLE share_commons_supersession (
  old_grant_id             TEXT PRIMARY KEY,
  new_grant_id             TEXT NOT NULL UNIQUE,
  new_circle_id            TEXT NOT NULL,
  old_steward_party_id     TEXT NOT NULL,
  new_steward_party_id     TEXT NOT NULL,
  new_steward_vault_id     TEXT NOT NULL,
  container_type           TEXT NOT NULL,
  old_container_id         TEXT NOT NULL,
  new_container_id         TEXT NOT NULL,
  -- The successor starts a FRESH genesis chain; this records the point in the
  -- old chain the replica was verified to, and the digest of the closure the
  -- successor was seeded from.
  source_sequence          INTEGER NOT NULL CHECK (source_sequence >= 0),
  source_chain_head_hash   TEXT NOT NULL,
  source_verified_sequence INTEGER NOT NULL CHECK (source_verified_sequence >= 0),
  source_state_digest      TEXT NOT NULL,
  reason                   TEXT NOT NULL,
  recovered_at             TEXT NOT NULL
) STRICT;
`;
