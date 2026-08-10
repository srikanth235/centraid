/*
 * `gateway.db`'s DDL and its one legacy migration, extracted out of
 * `gateway-db.ts` to keep that file under the 500-line cap (mirrors the P1
 * precedent of `device-ticket-mint.ts`). Both functions are pure over a
 * `DatabaseSync` handle — no lock/lease concerns belong here.
 */

import type { DatabaseSync } from "node:sqlite";

export function installGatewaySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS prefs (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL
    ) STRICT;
    /*
     * L2 — principals (issue #726). An owner is a human on this gateway: a
     * stable id the whole system keys on, plus an editable label.
     * People-as-principals live here; people-as-data live in the vault's
     * 'core_party'. There is deliberately no pointer between them.
     */
    CREATE TABLE IF NOT EXISTS owners (
      owner_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    /*
     * Authorization collapses to two questions, neither a role (issue #726):
     * whose device is this (the 'devices' binding), and does that owner own
     * this vault (this table). A vault has EXACTLY ONE owner — the PRIMARY
     * KEY is the invariant, structurally, with no check code. A device
     * reaches the vaults its owner owns; there is no partial authority over
     * a vault, because there is no such thing as being partly its owner.
     */
    CREATE TABLE IF NOT EXISTS vault_owners (
      vault_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE
    ) STRICT;
    /*
     * L1 — authentication. A device row is a pure BINDING of a proved iroh
     * EndpointId to an owner; it carries no authored authority. 'revoked' is
     * the device-level tombstone — "this phone was stolen" — and leaves the
     * owner untouched.
     */
    CREATE TABLE IF NOT EXISTS devices (
      enrollment_id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      platform TEXT,
      remember_device INTEGER NOT NULL CHECK (remember_device IN (0, 1)),
      grant_profile_json TEXT,
      compute_json TEXT,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
      added_at TEXT NOT NULL
    ) STRICT;
    /*
     * Replica checkpoints are the one genuinely per-(device, vault) fact, so
     * they keep their own table now that 'devices' no longer fans out.
     */
    CREATE TABLE IF NOT EXISTS device_checkpoints (
      endpoint_id TEXT NOT NULL REFERENCES devices(endpoint_id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL,
      checkpoint_json TEXT NOT NULL,
      PRIMARY KEY (endpoint_id, vault_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_sessions (
      token_hash TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      device_key TEXT REFERENCES devices(endpoint_id) ON DELETE CASCADE,
      shell_origin TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    ) STRICT;
    /*
     * The expiry sweep is the only full-table predicate on web_sessions and it
     * runs on a timer, not per request (issue #659 G3). Without this index the
     * sweep's DELETE scans every live session row.
     */
    CREATE INDEX IF NOT EXISTS web_sessions_expires_idx
      ON web_sessions(expires_at);
    /*
     * A ticket is an INVITATION: which owner the joining device binds to,
     * and the vault-id list (grants_json — no roles, just ids) the device
     * lands in. One scan, many vaults, atomically. There is only one kind of
     * ticket since #603 retired the founding ceremony — a gateway founds
     * itself.
     */
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE,
      grants_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS erase_intents (
      vault_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS recovery_kit (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      confirmed_at INTEGER,
      kit_fingerprint TEXT,
      kit_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (kit_confirmed IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS backup_targets (
      target_id TEXT PRIMARY KEY,
      vault_id TEXT NOT NULL,
      config_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS cas_reconciliations (
      vault_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS storage_connections (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind = 'provider'),
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      sealed_credentials TEXT NOT NULL,
      target_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS storage_limits (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      total_limit_bytes INTEGER,
      warn_at_percent REAL NOT NULL,
      journal_limit_bytes INTEGER
    ) STRICT;
    /*
     * A cross-vault EDGE is a recoverable two-step workflow, not a
     * distributed SQLite transaction (#726 P2 — succeeds placement_intents,
     * deleted outright, pre-1.0, no dual write). One edge covers a SET of
     * items: scope_json is that set for a snapshot edge, so three
     * photographs sharing one edge project through ONE reconcile pass, not
     * three. The audience projection always commits before a move deletes
     * its source; replay resumes from target_state/source_state.
     *
     * The retired live/lend relationship is not represented (#731).
     */
    CREATE TABLE IF NOT EXISTS share_edges (
      edge_id TEXT PRIMARY KEY,
      created_by_device TEXT NOT NULL REFERENCES devices(endpoint_id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('add', 'move')),
      mode TEXT NOT NULL CHECK (mode = 'snapshot'),
      item_type TEXT NOT NULL,
      scope_json TEXT,
      origin_vault_id TEXT NOT NULL,
      audience_vault_id TEXT NOT NULL,
      verbs TEXT NOT NULL CHECK (verbs = 'read'),
      target_item_ids_json TEXT,
      target_state TEXT NOT NULL CHECK (target_state IN ('queued', 'executed')),
      source_state TEXT NOT NULL CHECK (source_state IN ('not-needed', 'queued', 'executed')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'in-flight', 'established', 'parked', 'denied', 'revoked', 'completed', 'failed')),
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (mode != 'snapshot' OR scope_json IS NOT NULL),
      CHECK (kind != 'move' OR mode = 'snapshot')
    ) STRICT;
    CREATE INDEX IF NOT EXISTS share_edges_device_status
      ON share_edges(created_by_device, status, updated_at);
    /*
     * Durable access audit, one row per EDGE regardless of item count (#726
     * P2) — three photographs placed by one edge leave one receipt, not
     * three. Owner ids are deliberately not foreign keys: removing an owner
     * must revoke authority without erasing the fact that access was granted
     * or removed. edge_id makes offline edge replay exactly-once at this
     * control-plane boundary.
     */
    CREATE TABLE IF NOT EXISTS share_access_receipts (
      receipt_id TEXT PRIMARY KEY,
      edge_id TEXT UNIQUE,
      owner_id TEXT,
      action TEXT NOT NULL CHECK (action IN ('share', 'unshare')),
      item_type TEXT NOT NULL,
      origin_vault_id TEXT,
      origin_item_ids_json TEXT,
      audience_vault_id TEXT NOT NULL,
      audience_item_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS share_access_receipts_audience_idx
      ON share_access_receipts(audience_vault_id, created_at);
    /*
     * A LINK is the standing permission for an edge to cross between two
     * vaults (#726 P2 §3 + P3 decisions 1–3). ONE table covers both
     * localities because D3 makes locality ROUTING, not semantics: sharing to
     * a vault means the same thing whether that vault sits on this machine or
     * across the world. Two tables would mean two answerers for "may an edge
     * cross to vault X" — precisely the semantic split D3 forbids.
     * Same-owner edges (Work→Personal) need no row at all: owning both vaults
     * already IS the authorization.
     *
     * vault_a/vault_b are stored with the lexicographically smaller vault id
     * first (the CHECK), so a pair resolves to one row regardless of who
     * proposed it; UNIQUE then also forbids a reversed duplicate.
     *
     * public_key_a/public_key_b are the vaults' own Ed25519 identity keys —
     * P1 mints one for EVERY vault, so a local side carries exactly what a
     * remote side carries. approved_by_a/approved_by_b are the ceremony in
     * both localities: on one machine each owner's device approves its own
     * side; across machines minting the ticket is one side's approval and
     * redeeming it is the other's. An edge crosses only with BOTH non-NULL.
     *
     * route_a_json/route_b_json are the ONLY thing remoteness adds: a
     * replaceable {endpointId, relayHints, assertedAt, signature} cache
     * re-learned from a signed route assertion whenever that vault moves.
     * A route is never identity and never an authorization input — grants,
     * edges, and receipts bind vault_id alone (decision 1) — and these two
     * columns are the only place outside the device-pairing tables where
     * gateway.db holds an iroh EndpointId at all. "Is this side remote" is
     * "does this side need routing", which is the D3 statement itself. This
     * gateway holds at least one side of every link it stores, so the second
     * CHECK forbids a row that routes both ways.
     */
    CREATE TABLE IF NOT EXISTS vault_links (
      link_id TEXT PRIMARY KEY,
      vault_a TEXT NOT NULL,
      vault_b TEXT NOT NULL,
      public_key_a TEXT NOT NULL,
      public_key_b TEXT NOT NULL,
      label_a TEXT,
      label_b TEXT,
      approved_by_a TEXT,
      approved_by_b TEXT,
      route_a_json TEXT,
      route_b_json TEXT,
      permissions_json TEXT NOT NULL DEFAULT '{}',
      revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
      created_at TEXT NOT NULL,
      UNIQUE (vault_a, vault_b),
      CHECK (vault_a < vault_b),
      CHECK (route_a_json IS NULL OR route_b_json IS NULL)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS vault_links_vault_a_idx ON vault_links(vault_a);
    CREATE INDEX IF NOT EXISTS vault_links_vault_b_idx ON vault_links(vault_b);
    /*
     * The remote half of the ceremony's one-time capability (#726 P3
     * decision 3): 15-minute TTL, secret held only as a sha256, burned in the
     * same transaction that writes the link. vault_public_key pins what the
     * ticket PROMISED, so the link records the key the far side was shown
     * rather than whatever the vault holds by redemption time.
     */
    CREATE TABLE IF NOT EXISTS peer_link_tickets (
      ticket_id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      vault_public_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    /*
     * D9 (#726 P3 decision 9): each side's own accept|ask|refuse preference
     * for gives ARRIVING at its vault over a link. Keyed by (link_id,
     * vault_id) rather than added as vault_links columns, so setting it never
     * touches the ceremony/route columns' schema or their migration probe. No
     * row for a pair means 'accept' — the default that makes an approved link
     * behave exactly as P2 already did, before D9 existed.
     */
    CREATE TABLE IF NOT EXISTS link_receive_settings (
      link_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      setting TEXT NOT NULL CHECK (setting IN ('accept', 'ask', 'refuse')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (link_id, vault_id)
    ) STRICT;
    /*
     * A give the audience ASKED about (D9 'ask') and has not yet answered.
     * Deliberately carries no closure/bytes: nothing is written until the
     * owner accepts, at which point the audience PULLS the closure fresh from
     * the origin (peer plane's edge/closure/:edgeId route) rather than one
     * being staged here to go stale. One row per edge; the P6 UI reads this
     * table to list what is awaiting an answer.
     */
    CREATE TABLE IF NOT EXISTS peer_pending_gives (
      edge_id TEXT PRIMARY KEY,
      link_id TEXT NOT NULL,
      peer_vault_id TEXT NOT NULL,
      local_vault_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    /*
     * A remote-give ORIGINAL still being pulled by sha (#726 P3 decision 7):
     * derivatives already crossed with the closure, so what remains here is
     * only the byte-heavy rung. tmp_path is minted ONCE (the audience
     * vault's own promotionTempPathSync, same filesystem as its CAS) and
     * reused across resumes — the file's on-disk length IS the resume offset,
     * so an interrupted pull continues a Range request rather than
     * restarting. The row is deleted the moment the sha is verified and
     * adopted into the CAS; its mere existence means "not yet durable".
     */
    CREATE TABLE IF NOT EXISTS peer_blob_pulls (
      pull_id TEXT PRIMARY KEY,
      edge_id TEXT NOT NULL,
      link_id TEXT NOT NULL,
      local_vault_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      tmp_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (local_vault_id, sha256)
    ) STRICT;
    /*
     * A D9 'refuse' the AUDIENCE has decided but the ORIGIN has not yet heard
     * (#726 P3 decision 9). The owner's answer is durable the instant this
     * row lands — before any network attempt — so a refusal is never lost to
     * an offline peer; drainPeerRefusals (the same background tick that
     * drains peer_blob_pulls) POSTs it to the peer plane's edge/deny route
     * and deletes the row once the origin acknowledges. One row per edge: a
     * second 'refuse' on the same edge is unreachable (the route that writes
     * this row requires a live peer_pending_gives row, which the first
     * refusal already deleted).
     */
    CREATE TABLE IF NOT EXISTS peer_pending_refusals (
      edge_id TEXT PRIMARY KEY,
      link_id TEXT NOT NULL,
      peer_vault_id TEXT NOT NULL,
      local_vault_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS push_registrations (
      device_id TEXT PRIMARY KEY REFERENCES devices(endpoint_id) ON DELETE CASCADE,
      expo_token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_push_vapid (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      public_key TEXT NOT NULL,
      private_key TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS web_push_registrations (
      endpoint TEXT PRIMARY KEY,
      device_id TEXT NOT NULL REFERENCES devices(endpoint_id) ON DELETE CASCADE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS web_push_registrations_device_idx
      ON web_push_registrations(device_id);
  `);
}

/*
 * Pre-1.0 link-table merge (issue #726 P3): two phases landed two link
 * tables — `vault_links` for pairs on this machine and `peer_links` for pairs
 * across machines — and D3 permits exactly one answerer for "may an edge
 * cross to vault X". Both shapes are unreleased, so they are DROPPED rather
 * than dual-written; `installGatewaySchema` then creates the unified
 * `vault_links`. Idempotent by construction: the probe finds neither the
 * superseded table nor the superseded column shape on a merged database.
 */
export function migrateSupersededLinks(db: DatabaseSync): void {
  const hasTable = (name: string): boolean =>
    db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(name) !== undefined;
  const merged =
    !hasTable("vault_links") ||
    (
      db.prepare("PRAGMA table_info(vault_links)").all() as Array<{
        name: string;
      }>
    ).some((column) => column.name === "public_key_a");
  if (merged && !hasTable("peer_links")) return;
  db.exec(`
    BEGIN IMMEDIATE;
    DROP TABLE IF EXISTS peer_links;
    ${merged ? "" : "DROP TABLE IF EXISTS vault_links;"}
    COMMIT;
  `);
}

/** Pre-1.0 retirement for issue #731. The live-edge stores contain no
 * portable owner data: they were lease caches and transport bookkeeping.
 * Drop them instead of retaining a dormant second sharing model. An older
 * `share_edges` shape is also recreated so its CHECK constraint cannot admit
 * `mode = 'live'` after the route has stopped accepting it.
 *
 * `share_access_receipts` is untouched by this migration: its shape carries
 * no `mode` and never referenced the lend tables (no FK — owner ids are
 * deliberately not foreign keys, see the table's own comment), so it needs
 * no recreation. It records that access was GRANTED or removed, which must
 * survive the lend plane's retirement exactly as it survives an owner's
 * removal — dropping it here would erase give history the retirement never
 * asked to erase. */
export function migrateRetiredLending(db: DatabaseSync): void {
  const shareEdgesSql = (
    db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'share_edges'"
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  const recreateEdges = shareEdgesSql?.includes("'live'") === true;
  db.exec(`
    BEGIN IMMEDIATE;
    DROP TABLE IF EXISTS peer_pending_lend_closes;
    DROP TABLE IF EXISTS lent_edges;
    DROP TABLE IF EXISTS borrowed_edges;
    DROP TABLE IF EXISTS link_borrow_budgets;
    ${recreateEdges ? "DROP TABLE share_edges;" : ""}
    COMMIT;
  `);
}

/*
 * Pre-1.0 legacy migration (issue #726 P0): a gateway.db written under the
 * #599 household model carries `members`/`member_roles`. Rename the tables
 * and columns to the ownership vocabulary, seed `vault_owners` with each
 * vault's earliest-created admin (fallback: earliest member holding any
 * role), and drop the role lattice. Idempotent by construction: the probe
 * finds no `members` table on a migrated or fresh database.
 */
export function migrateLegacyMembers(db: DatabaseSync): void {
  const legacy = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'members'"
    )
    .get();
  if (!legacy) return;
  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE members RENAME TO owners;
    ALTER TABLE owners RENAME COLUMN member_id TO owner_id;
    ALTER TABLE devices RENAME COLUMN member_id TO owner_id;
    ALTER TABLE tickets RENAME COLUMN member_id TO owner_id;
    CREATE TABLE IF NOT EXISTS vault_owners (
      vault_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE
    ) STRICT;
    INSERT OR IGNORE INTO vault_owners (vault_id, owner_id)
      SELECT vault_id, owner_id FROM (
        SELECT mr.vault_id AS vault_id, mr.member_id AS owner_id,
               ROW_NUMBER() OVER (
                 PARTITION BY mr.vault_id
                 ORDER BY (mr.role = 'admin') DESC, o.created_at, o.owner_id
               ) AS pick
          FROM member_roles mr
          JOIN owners o ON o.owner_id = mr.member_id
      ) WHERE pick = 1;
    DROP TABLE member_roles;
    -- Legacy tickets carry role-bearing grants that can no longer be
    -- honoured; they are 15-minute invitations, so dropping them is cheaper
    -- and safer than rewriting their grant shape.
    DELETE FROM tickets;
    -- #726 P2 replaced both tables' column shapes (single item → an item
    -- SET, one receipt per edge rather than per item); pre-1.0, this audit
    -- trail carries no migration promise, same call already made for
    -- tickets above. installGatewaySchema recreates both fresh below.
    DROP TABLE IF EXISTS placement_intents;
    DROP TABLE IF EXISTS share_access_receipts;
    -- The default share-target pointer died with the /share plane (#726).
    DELETE FROM prefs
      WHERE key = 'share.defaultTargetVaultId'
         OR key GLOB 'member.*.share.defaultTargetVaultId';
    COMMIT;
  `);
}
