import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, afterEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { GatewayDatabase } from "./gateway-db.js";

const opened: GatewayDatabase[] = [];

function plainRow<T extends object>(row: T): T {
  return { ...row };
}

describe("gateway-db lend retirement (#731)", () => {
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close();
  });

  test("a #726-era gateway.db retires the lend plane without erasing give receipts (#731)", async () => {
    const dir = await tempDir();
    // Hand-write the #726 P4 generation the migration probes for: a
    // `share_edges` CHECK that still admits `mode = 'live'`, plus the four
    // lend-only stores and some pre-existing give-plane receipts that must
    // survive untouched.
    const legacy = new DatabaseSync(path.join(dir, "gateway.db"));
    legacy.exec(`
      CREATE TABLE owners (
        owner_id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE devices (
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
      CREATE TABLE share_edges (
        edge_id TEXT PRIMARY KEY,
        created_by_device TEXT NOT NULL REFERENCES devices(endpoint_id) ON DELETE CASCADE,
        owner_id TEXT NOT NULL REFERENCES owners(owner_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('add', 'move')),
        mode TEXT NOT NULL CHECK (mode IN ('snapshot', 'live')),
        item_type TEXT NOT NULL,
        scope_json TEXT,
        origin_vault_id TEXT NOT NULL,
        audience_vault_id TEXT NOT NULL,
        verbs TEXT NOT NULL CHECK (verbs IN ('read', 'read+act')),
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
      CREATE TABLE share_access_receipts (
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
      CREATE TABLE link_borrow_budgets (
        link_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        budget_bytes INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (link_id, vault_id)
      ) STRICT;
      CREATE TABLE peer_pending_lend_closes (
        edge_id TEXT PRIMARY KEY,
        link_id TEXT NOT NULL,
        peer_vault_id TEXT NOT NULL,
        local_vault_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE lent_edges (
        edge_id TEXT PRIMARY KEY,
        origin_vault_id TEXT NOT NULL,
        audience_vault_id TEXT NOT NULL,
        grantee_party_id TEXT NOT NULL,
        grant_id TEXT NOT NULL,
        row_key_secret TEXT NOT NULL,
        item_type TEXT NOT NULL,
        verbs TEXT NOT NULL DEFAULT 'read' CHECK (verbs IN ('read', 'read+act')),
        lease_expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE borrowed_edges (
        edge_id TEXT PRIMARY KEY,
        link_id TEXT NOT NULL,
        origin_vault_id TEXT NOT NULL,
        audience_vault_id TEXT NOT NULL,
        item_type TEXT NOT NULL,
        holder_label TEXT NOT NULL,
        origin_public_key TEXT NOT NULL,
        verbs TEXT NOT NULL DEFAULT 'read' CHECK (verbs IN ('read', 'read+act')),
        state TEXT NOT NULL CHECK (state IN ('offered', 'established', 'parked', 'dropped')),
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO owners VALUES ('owner', 'Priya', 0);
      INSERT INTO devices VALUES ('e1', 'ep-1', 'owner', 'Laptop', NULL, 1, NULL, NULL, 0, '2026-01-01T00:00:00.000Z');
      INSERT INTO share_edges VALUES (
        'edge-live', 'ep-1', 'owner', 'add', 'live', 'photo', '{}', 'v1', 'v2',
        'read', NULL, 'executed', 'not-needed', 'established', NULL,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO share_access_receipts VALUES (
        'receipt-1', 'edge-live', 'owner', 'share', 'photo', 'v1', '["i1"]', 'v2', '["i1"]', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO share_access_receipts VALUES (
        'receipt-2', NULL, NULL, 'unshare', 'photo', 'v1', '["i2"]', 'v2', '["i2"]', '2026-01-02T00:00:00.000Z'
      );
      INSERT INTO lent_edges VALUES (
        'edge-live', 'v1', 'v2', 'party-1', 'grant-1', 'secret', 'photo', 'read',
        '2027-01-01T00:00:00.000Z', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO borrowed_edges VALUES (
        'edge-borrowed', 'link-1', 'v3', 'v1', 'photo', 'Sid', 'pubkey', 'read',
        'established', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
      INSERT INTO link_borrow_budgets VALUES ('link-1', 'v1', 1000000, '2026-01-01T00:00:00.000Z');
      INSERT INTO peer_pending_lend_closes VALUES (
        'edge-live', 'link-1', 'v2', 'v1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacy.close();

    const gateway = GatewayDatabase.open(dir);
    opened.push(gateway);
    const tables = (
      gateway.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    // The lend-only stores are gone outright — lease caches and transport
    // bookkeeping, no portable owner data worth retaining (#731).
    expect(tables).not.toContain("lent_edges");
    expect(tables).not.toContain("borrowed_edges");
    expect(tables).not.toContain("link_borrow_budgets");
    expect(tables).not.toContain("peer_pending_lend_closes");
    // share_edges is recreated so its CHECK can no longer admit 'live'.
    expect(tables).toContain("share_edges");
    expect(
      (
        gateway.db.prepare("SELECT count(*) AS n FROM share_edges").get() as {
          n: number;
        }
      ).n
    ).toBe(0);
    const shareEdgesSql = (
      gateway.db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'share_edges'"
        )
        .get() as { sql: string }
    ).sql;
    expect(shareEdgesSql).not.toContain("'live'");
    // share_access_receipts carries no FK to share_edges and no `mode`
    // column — the lend retirement gives it no reason to be touched, and
    // every pre-existing receipt must survive intact (#731).
    expect(
      (
        gateway.db
          .prepare(
            "SELECT receipt_id, edge_id, owner_id, action, item_type, origin_vault_id, origin_item_ids_json, audience_vault_id, audience_item_ids_json, created_at FROM share_access_receipts ORDER BY receipt_id"
          )
          .all() as Array<Record<string, unknown>>
      ).map(plainRow)
    ).toStrictEqual([
      {
        receipt_id: "receipt-1",
        edge_id: "edge-live",
        owner_id: "owner",
        action: "share",
        item_type: "photo",
        origin_vault_id: "v1",
        origin_item_ids_json: '["i1"]',
        audience_vault_id: "v2",
        audience_item_ids_json: '["i1"]',
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        receipt_id: "receipt-2",
        edge_id: null,
        owner_id: null,
        action: "unshare",
        item_type: "photo",
        origin_vault_id: "v1",
        origin_item_ids_json: '["i2"]',
        audience_vault_id: "v2",
        audience_item_ids_json: '["i2"]',
        created_at: "2026-01-02T00:00:00.000Z",
      },
    ]);
    // Idempotent: a second open finds the new CHECK and no lend tables, and
    // changes nothing further.
    const again = GatewayDatabase.open(dir);
    again.close();
  });
});
