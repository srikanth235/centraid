/*
 * `gateway.db`'s DDL. Pre-1.0, this repo carries NO backward
 * compatibility for `gateway.db`: there are no legacy-generation migrations
 * here, on principle. `installGatewaySchema` is the single source of truth
 * for the current shape; a `gateway.db` written by an older generation is
 * expected to be erased and re-onboarded, not migrated in place. The
 * function below is pure over a `DatabaseSync` handle — no lock/lease
 * concerns belong here.
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
      /*
       * Is this device confined to a subset of the owner's surfaces (#928 A6)?
       * The SET of surfaces is not here — it is share_authority rows in the
       * vault, principal 'device' over subject type 'app.surface'. This flag
       * is the one fact the gateway must know BEFORE any vault is open, and
       * it is the reason a missing projection can deny instead of guessing:
       * attenuated with nothing projected is a refusal, not a full device.
       */
      attenuated INTEGER NOT NULL DEFAULT 0 CHECK (attenuated IN (0, 1)),
      compute_json TEXT,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
      added_at TEXT NOT NULL
    ) STRICT;
    /*
     * Replica checkpoints are the one genuinely per-(device, vault) fact, so
     * they keep their own table now that 'devices' no longer fans out.
     */
    /*
     * The PROJECTION of a Companion device's attenuation (#928 A6), per
     * (device, vault) because the answer lives in a vault and a device may be
     * enrolled in several. The authority rows are the source of truth; this
     * table exists only because the gateway authorizes a Companion request
     * BEFORE it opens a vault. It is rebuilt from those rows whenever the
     * vault opens or the answer changes, and an absent row denies.
     */
    CREATE TABLE IF NOT EXISTS device_surface_projection (
      endpoint_id TEXT NOT NULL REFERENCES devices(endpoint_id) ON DELETE CASCADE,
      vault_id TEXT NOT NULL,
      surfaces_json TEXT NOT NULL,
      projected_at TEXT NOT NULL,
      PRIMARY KEY (endpoint_id, vault_id)
    ) STRICT;
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
     * ticket (#603) — a gateway founds itself.
     */
    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      owner_id TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE,
      grants_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    /*
     * Idempotency ledger for the *Add someone* mint (issue #750): one row per
     * client-chosen operation id on POST /devices/ticket + forPerson,
     * storing the FULL original response. A replay returns result_json
     * verbatim and re-mints nothing. The row commits in the SAME transaction
     * as the owner/ownership/ticket rows it describes, so a failed mint
     * records nothing and a recorded operation always names committed rows.
     *
     * request_hash fingerprints the request's defining inputs (label,
     * vaultName, ttlMs) so an operation id reused with DIFFERENT inputs is
     * refused instead of silently replaying the first request's result —
     * without it a typo'd retry could believe a never-performed request
     * succeeded.
     */
    CREATE TABLE IF NOT EXISTS provision_operations (
      operation_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL
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
     * SAME-OWNER PLACEMENT HISTORY (#726 P2, reduced to history by #928 A7).
     * The edge rows, the effect outbox and their reducer are gone: a
     * placement between two of one owner's vaults is one synchronous vault
     * call, not a distributed obligation, and the durable INTENT belongs to
     * the caller's own offline queue.
     *
     * One row per PLACEMENT regardless of item count — three photographs
     * moved by one act leave one receipt, not three. Owner ids are
     * deliberately not foreign keys: removing an owner must revoke authority
     * without erasing the fact that access was granted or removed. edge_id is
     * the caller's placement token and is UNIQUE, which is what makes a
     * replayed placement exactly-once at this control-plane boundary.
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
      placement_kind TEXT CHECK (placement_kind IS NULL OR placement_kind IN ('add', 'move')),
      created_by_device TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS share_access_receipts_audience_idx
      ON share_access_receipts(audience_vault_id, created_at);
    /*
     * The vault DIRECTORY (issue #750 invariant 1): ONE stable identity
     * record per known vault — local and peer alike. vault_id plus the
     * vault's own Ed25519 identity public key (P1 mints one for EVERY
     * vault), plus a display label. Identity lives HERE and nowhere else:
     * before #750, vault_links carried a key and label PER LINK, so a peer
     * vault linked to two local vaults existed twice, and the copies could
     * drift. Now every link, route, and signature check resolves a vault
     * through this one row.
     *
     * A directory row is written by the link ceremony (propose/recordPeer/
     * redeem) — never by a route assertion, which may only MOVE an address
     * (decision 1: a route is never identity).
     */
    CREATE TABLE IF NOT EXISTS vault_directory (
      vault_id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      label TEXT,
      created_at TEXT NOT NULL
    ) STRICT;
    /*
     * ONE route per peer vault (issue #750 invariant 2). The mere PRESENCE
     * of a row means "this vault lives elsewhere" — a vault on this gateway
     * never has one, which is the D3 statement itself ("is this vault
     * remote" is "does this vault need routing"). The row is a replaceable
     * {endpoint, relay hints, assertedAt, signature} cache re-learned from a
     * signed route assertion whenever the vault moves; asserted_at is the
     * replay-ordering key (an older assertion never wins the route back),
     * and signature keeps the cache self-attesting.
     *
     * PRIMARY KEY (vault_id) is the invariant, structurally: two local
     * vaults linked to the SAME peer vault resolve through this single row,
     * so one accepted assertion re-routes every link at once — routes can no
     * longer be duplicated (or half-updated) per link. This table and the
     * device-pairing tables are the only places gateway.db holds an iroh
     * EndpointId at all; a route is never an authorization input — grants,
     * edges, and receipts bind vault_id alone (decision 1).
     */
    CREATE TABLE IF NOT EXISTS vault_routes (
      vault_id TEXT PRIMARY KEY REFERENCES vault_directory(vault_id) ON DELETE CASCADE,
      endpoint_id TEXT NOT NULL,
      relay_hints_json TEXT NOT NULL,
      asserted_at INTEGER NOT NULL,
      signature TEXT
    ) STRICT;
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
     * A link row is PURE permission (issue #750): approved_by_a/approved_by_b
     * are the ceremony in both localities — on one machine each owner's
     * device approves its own side; across machines minting the ticket is one
     * side's approval and redeeming it is the other's. An edge crosses only
     * with BOTH non-NULL. Identity (public keys, labels) lives in
     * vault_directory; reachability lives in vault_routes — a link never
     * carries either, so linking one peer vault from two local vaults stores
     * that vault's identity and route exactly once.
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
      UNIQUE (vault_a, vault_b),
      CHECK (vault_a < vault_b)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS vault_links_vault_a_idx ON vault_links(vault_a);
    CREATE INDEX IF NOT EXISTS vault_links_vault_b_idx ON vault_links(vault_b);
    /*
     * The remote half of the ceremony's one-time capability (#726 P3
     * decision 3): 15-minute TTL, secret held only as a sha256, burned in the
     * same transaction that writes the link. vault_public_key pins what the
     * ticket PROMISED, so redemption records into vault_directory the key the
     * far side was shown rather than whatever the vault holds by redemption
     * time (#750: the directory row, not the link, now carries it).
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
     * link_receive_settings is NOT here. An accept|ask|refuse preference
     * answers one question — "may another person's vault push a copy into
     * mine?" — and nothing pushes a copy (#825, ruling G-copy), so nothing
     * arrives for it to govern: a grant is a standing permission the AUDIENCE
     * accepts through the channel invitation, not a push it pre-authorizes.
     * retireDeadShareEffects drops the table where an older generation left
     * one, rather than keeping a setting no code reads.
     */
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
