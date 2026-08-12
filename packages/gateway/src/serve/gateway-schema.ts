/*
 * `gateway.db`'s DDL, extracted out of `gateway-db.ts` to keep that file
 * under the 500-line cap (mirrors the P1 precedent of
 * `device-ticket-mint.ts`). Pre-1.0, this repo carries NO backward
 * compatibility for `gateway.db`: there are no legacy-generation migrations
 * here, on principle. `installGatewaySchema` is the single source of truth
 * for the current shape; a `gateway.db` written by an older generation is
 * expected to be erased and re-onboarded, not migrated in place. The
 * function below is pure over a `DatabaseSync` handle — no lock/lease
 * concerns belong here.
 */

import type { DatabaseSync } from "node:sqlite";

export function installGatewaySchema(db: DatabaseSync): void {
  refuseLegacySharingSchema(db);
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
     * The stable identity directory is the only gateway-level record of what
     * a vault id means. Links refer to ids; identity keys and human labels do
     * not get copied into every link. A local vault has no route row. A peer
     * vault has exactly one replaceable route, shared by every link naming it.
     * That makes an endpoint rotation one atomic update instead of an update
     * to whichever link a query happened to find first (#750).
     */
    CREATE TABLE IF NOT EXISTS vault_directory (
      vault_id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      label TEXT,
      locality TEXT NOT NULL CHECK (locality IN ('local', 'peer')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS vault_routes (
      vault_id TEXT PRIMARY KEY REFERENCES vault_directory(vault_id) ON DELETE CASCADE,
      endpoint_id TEXT NOT NULL,
      relay_hints_json TEXT NOT NULL,
      asserted_at INTEGER NOT NULL,
      signature TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS vault_routes_endpoint_idx
      ON vault_routes(endpoint_id);
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
      approved_by_a TEXT,
      approved_by_b TEXT,
      permissions_json TEXT NOT NULL DEFAULT '{}',
      revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
      created_at TEXT NOT NULL,
      FOREIGN KEY (vault_a) REFERENCES vault_directory(vault_id),
      FOREIGN KEY (vault_b) REFERENCES vault_directory(vault_id),
      UNIQUE (vault_a, vault_b),
      CHECK (vault_a < vault_b)
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
     * touches the ceremony/route columns' schema. No row for a pair means
     * 'accept' — the default that makes an approved link behave exactly as
     * P2 already did, before D9 existed.
     */
    CREATE TABLE IF NOT EXISTS link_receive_settings (
      link_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      setting TEXT NOT NULL CHECK (setting IN ('accept', 'ask', 'refuse')),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (link_id, vault_id)
    ) STRICT;
    /* One typed queue for asks, CAS pulls, refusal notices, and Commons
     * invitations. Payloads carry no closure bytes and terminal history is
     * bounded by ShareEffectsStore; no workflow-specific queue survives. */
    CREATE TABLE IF NOT EXISTS share_effects (
      effect_id TEXT PRIMARY KEY,
      edge_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'await-give-decision', 'pull-blob', 'notify-refusal',
        'deliver-commons-invitation'
      )),
      state TEXT NOT NULL CHECK (state IN (
        'queued', 'running', 'parked', 'executed', 'denied',
        'failed', 'cancelled', 'expired'
      )),
      local_vault_id TEXT NOT NULL,
      peer_vault_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (edge_id, kind, payload_json)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS share_effects_drain_idx
      ON share_effects(state, next_attempt_at, created_at);
    /*
     * A Commons bootstrap authorizes its closure once. Chunk reads then use a
     * keyed, expiring authorization row instead of rebuilding and signing the
     * entire export for every range request (#750).
     */
    CREATE TABLE IF NOT EXISTS commons_blob_access (
      grant_id TEXT NOT NULL,
      member_vault_id TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      PRIMARY KEY (grant_id, member_vault_id, sha256)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS commons_blob_access_expiry_idx
      ON commons_blob_access(expires_at);
    /* Durable operation ids make person provisioning resumable and replay-safe. */
    CREATE TABLE IF NOT EXISTS provision_person_operations (
      operation_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN (
        'planned', 'secret-ready', 'vault-ready', 'owner-ready',
        'ownership-ready', 'ticket-ready', 'executed'
      )),
      owner_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      ticket_id TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
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

/**
 * Pre-1.0 sharing schemas are intentionally unsupported. Refusing them is
 * safer than leaving old copied identity/routes and specialized drainers live
 * beside the current single-owner state machine. Recovery is erase and
 * re-onboard, as documented by the file header and recovery runbook.
 */
function refuseLegacySharingSchema(db: DatabaseSync): void {
  const table = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'vault_links'"
    )
    .get();
  if (!table) return;
  const columns = db.prepare("PRAGMA table_info(vault_links)").all() as Array<{
    name: string;
  }>;
  if (columns.some((column) => column.name === "route_a_json")) {
    throw new Error(
      "unsupported pre-#750 gateway.db sharing schema; erase and re-onboard this pre-1.0 gateway"
    );
  }
}
