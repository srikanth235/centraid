import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, afterEach, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";
import { aesGcmKeyProtector, KeyStore } from "@centraid/vault";

import { StorageConnectionStore } from "../backup/storage-connections.js";
import {
  darwinNetworkFileSystem,
  GatewayDatabase,
  GatewayLockError,
  parseDarwinFileSystemType,
} from "./gateway-db.js";
import { openVaultRegistry } from "./vault-registry.js";

const opened: GatewayDatabase[] = [];

function plainRow<T extends object>(row: T): T {
  return { ...row };
}

describe("gateway-db scenarios", () => {
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close();
  });

  test("installs the full vaultless schema without a vault catalog or shm sidecar", async () => {
    const dir = await tempDir();
    const gateway = GatewayDatabase.open(dir);
    opened.push(gateway);

    const tables = (
      gateway.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).toStrictEqual([
      "backup_targets",
      "cas_reconciliations",
      "device_checkpoints",
      "devices",
      "erase_intents",
      "gateway_meta",
      "link_receive_settings",
      "owners",
      "peer_blob_pulls",
      "peer_link_tickets",
      "peer_pending_gives",
      "peer_pending_refusals",
      "prefs",
      "push_registrations",
      "recovery_kit",
      "share_access_receipts",
      "share_edges",
      "storage_connections",
      "storage_limits",
      "tickets",
      "vault_links",
      "vault_owners",
      "web_push_registrations",
      "web_push_vapid",
      "web_sessions",
    ]);
    expect(tables).not.toContain("vaults");
    // #726 P3 merged the two link tables into one: locality is routing, not
    // semantics, so there is exactly one answerer for "may an edge cross".
    expect(tables).not.toContain("peer_links");
    // #603 retired the founding ceremony: no reservation table, and a ticket
    // has one shape (an invitation) rather than a `kind` discriminant.
    expect(tables).not.toContain("founding_ticket_reservations");
    expect(
      (
        gateway.db.prepare("PRAGMA table_info(tickets)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    ).not.toContain("kind");
    expect(existsSync(path.join(dir, "gateway.db-shm"))).toBe(false);
    for (const retired of [
      "prefs.json",
      "devices.json",
      "tickets.json",
      "recovery-kit.json",
      "backup.json",
      "endpoint.json",
      "gateway.lease",
      "gateway.lock.db",
      "profile.json",
      "gateway.status.json",
      "gateway.ownership.json",
      "token.bin",
      "storage",
      "backup",
    ]) {
      expect(existsSync(path.join(dir, retired)), retired).toBe(false);
    }
  });

  test("the gateway database itself is the exclusive lifetime lock", async () => {
    const dir = await tempDir();
    const first = GatewayDatabase.open(dir, { lock: "exclusive" });
    opened.push(first);

    expect(
      (
        first.db.prepare("PRAGMA locking_mode").get() as {
          locking_mode: string;
        }
      ).locking_mode
    ).toBe("exclusive");
    expect(() => GatewayDatabase.open(dir, { lock: "exclusive" })).toThrow(
      GatewayLockError
    );
    expect(existsSync(path.join(dir, "gateway.lock.db"))).toBe(false);
    expect(existsSync(path.join(dir, "gateway.db-shm"))).toBe(false);

    first.close();
    opened.pop();
    const afterStop = new DatabaseSync(path.join(dir, "gateway.db"), {
      readOnly: true,
    });
    expect(
      plainRow(
        afterStop
          .prepare("SELECT value FROM gateway_meta WHERE key = 'schema'")
          .get() as { value: string }
      )
    ).toStrictEqual({
      value: "1",
    });
    afterStop.close();
  });

  test("device deletion cascades its durable browser sessions", async () => {
    const dir = await tempDir();
    const gateway = GatewayDatabase.open(dir);
    opened.push(gateway);
    gateway.run(
      "INSERT INTO owners (owner_id, label, created_at) VALUES (?, ?, ?)",
      "owner",
      "Priya",
      0
    );
    gateway.run(
      `INSERT INTO devices (
      enrollment_id, endpoint_id, owner_id, label, remember_device, added_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
      "enrollment",
      "endpoint",
      "owner",
      "Laptop",
      1,
      new Date(0).toISOString()
    );
    gateway.run(
      `INSERT INTO web_sessions (
      token_hash, vault_id, device_key, shell_origin, created_at, expires_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      "abc",
      "vault",
      "endpoint",
      "https://app.centraid.dev",
      new Date(0).toISOString(),
      100,
      0
    );

    gateway.run("DELETE FROM devices WHERE enrollment_id = ?", "enrollment");

    expect(
      plainRow(
        gateway.db.prepare("SELECT count(*) AS n FROM web_sessions").get() as {
          n: number;
        }
      )
    ).toStrictEqual({
      n: 0,
    });
  });

  test("the two superseded link tables merge into one (#726 P3)", async () => {
    const dir = await tempDir();
    // The two shapes the two phases landed, hand-written so the merge probes
    // find exactly what a mid-P3 gateway.db carries.
    const superseded = new DatabaseSync(path.join(dir, "gateway.db"));
    superseded.exec(`
      CREATE TABLE vault_links (
        link_id TEXT PRIMARY KEY,
        vault_a TEXT NOT NULL,
        vault_b TEXT NOT NULL,
        created_at TEXT NOT NULL,
        approved_by_a TEXT,
        approved_by_b TEXT,
        UNIQUE (vault_a, vault_b)
      ) STRICT;
      CREATE TABLE peer_links (
        link_id TEXT PRIMARY KEY,
        local_vault_id TEXT NOT NULL,
        peer_vault_id TEXT NOT NULL,
        peer_public_key TEXT NOT NULL,
        peer_endpoint_id TEXT NOT NULL,
        revoked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE (local_vault_id, peer_vault_id)
      ) STRICT;
      INSERT INTO vault_links VALUES ('l1', 'vault-a', 'vault-b', '2026-01-01', NULL, NULL);
      INSERT INTO peer_links VALUES ('l2', 'vault-a', 'vault-far', 'k', 'ep', 0, '2026-01-01');
    `);
    superseded.close();

    const gateway = GatewayDatabase.open(dir);
    opened.push(gateway);
    const tables = (
      gateway.db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).not.toContain("peer_links");
    expect(tables).toContain("vault_links");
    // Pre-1.0, no dual write: the rows go with the shapes, and the merged
    // table carries the columns both localities now share.
    expect(
      gateway.db.prepare("SELECT count(*) AS n FROM vault_links").get()
    ).toMatchObject({ n: 0 });
    const columns = (
      gateway.db.prepare("PRAGMA table_info(vault_links)").all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    expect(columns).toContain("public_key_a");
    expect(columns).toContain("route_a_json");
    // Idempotent: a second open finds a merged database and leaves it alone.
    gateway.close();
    opened.pop();
    const reopened = GatewayDatabase.open(dir);
    opened.push(reopened);
    expect(
      reopened.db.prepare("PRAGMA table_info(vault_links)").all()
    ).toHaveLength(columns.length);
  });

  test("a legacy members/member_roles database migrates to owners + vault_owners (#726)", async () => {
    const dir = await tempDir();
    // Hand-write the #599 household schema generation the migration probes
    // for — installGatewaySchema must never have run on this file.
    const legacy = new DatabaseSync(path.join(dir, "gateway.db"));
    legacy.exec(`
      CREATE TABLE prefs (key TEXT PRIMARY KEY, value_json TEXT NOT NULL) STRICT;
      CREATE TABLE members (
        member_id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE member_roles (
        member_id TEXT NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
        vault_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'write', 'read')),
        PRIMARY KEY (member_id, vault_id)
      ) STRICT;
      CREATE TABLE devices (
        enrollment_id TEXT PRIMARY KEY,
        endpoint_id TEXT NOT NULL UNIQUE,
        member_id TEXT NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        platform TEXT,
        remember_device INTEGER NOT NULL CHECK (remember_device IN (0, 1)),
        grant_profile_json TEXT,
        compute_json TEXT,
        revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
        added_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE tickets (
        ticket_id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        member_id TEXT NOT NULL REFERENCES members(member_id) ON DELETE CASCADE,
        grants_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE placement_intents (
        link_token TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        item_type TEXT NOT NULL,
        item_id TEXT NOT NULL,
        source_vault_id TEXT NOT NULL,
        target_vault_id TEXT NOT NULL,
        target_item_id TEXT,
        target_state TEXT NOT NULL,
        source_state TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE share_access_receipts (
        receipt_id TEXT PRIMARY KEY,
        link_token TEXT UNIQUE,
        member_id TEXT,
        action TEXT NOT NULL,
        item_type TEXT NOT NULL,
        origin_vault_id TEXT,
        origin_item_id TEXT,
        audience_vault_id TEXT NOT NULL,
        audience_item_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO members VALUES ('m-early', 'Priya', 100);
      INSERT INTO members VALUES ('m-late', 'Sid', 200);
      -- v1: two admins — the EARLIEST-created admin becomes the owner.
      INSERT INTO member_roles VALUES ('m-late', 'v1', 'admin');
      INSERT INTO member_roles VALUES ('m-early', 'v1', 'admin');
      -- v2: no admin at all — the earliest member holding any role wins.
      INSERT INTO member_roles VALUES ('m-late', 'v2', 'write');
      -- v3: a lone writer beside v1's admins.
      INSERT INTO member_roles VALUES ('m-late', 'v3', 'admin');
      INSERT INTO devices VALUES ('e1', 'ep-1', 'm-early', 'Laptop', NULL, 1, NULL, NULL, 0, '2026-01-01T00:00:00.000Z');
      INSERT INTO tickets VALUES ('t1', 'hash', 'm-early', '[{"vaultId":"v1","role":"write"}]', '2026-01-01T00:00:00.000Z', 9999999999999);
      INSERT INTO prefs VALUES ('share.defaultTargetVaultId', '"v1"');
      INSERT INTO prefs VALUES ('member.m-early.share.defaultTargetVaultId', '"v2"');
      INSERT INTO prefs VALUES ('agent.runner.kind', '"codex"');
    `);
    legacy.close();

    const gateway = GatewayDatabase.open(dir);
    opened.push(gateway);
    const tables = (
      gateway.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(tables).not.toContain("members");
    expect(tables).not.toContain("member_roles");
    // #726 P2: the legacy shapes cannot be carried forward (single item →
    // an item SET, one receipt per edge); both are dropped and recreated
    // fresh rather than column-migrated.
    expect(tables).not.toContain("placement_intents");
    expect(tables).toContain("share_edges");
    expect(
      (
        gateway.db
          .prepare("PRAGMA table_info(share_access_receipts)")
          .all() as Array<{
          name: string;
        }>
      ).map((column) => column.name)
    ).toStrictEqual([
      "receipt_id",
      "edge_id",
      "owner_id",
      "action",
      "item_type",
      "origin_vault_id",
      "origin_item_ids_json",
      "audience_vault_id",
      "audience_item_ids_json",
      "created_at",
    ]);
    expect(
      (
        gateway.db
          .prepare("SELECT owner_id, label FROM owners ORDER BY owner_id")
          .all() as Array<{ owner_id: string; label: string }>
      ).map(plainRow)
    ).toStrictEqual([
      { owner_id: "m-early", label: "Priya" },
      { owner_id: "m-late", label: "Sid" },
    ]);
    expect(
      (
        gateway.db
          .prepare(
            "SELECT vault_id, owner_id FROM vault_owners ORDER BY vault_id"
          )
          .all() as Array<{ vault_id: string; owner_id: string }>
      ).map(plainRow)
    ).toStrictEqual([
      { vault_id: "v1", owner_id: "m-early" },
      { vault_id: "v2", owner_id: "m-late" },
      { vault_id: "v3", owner_id: "m-late" },
    ]);
    expect(
      (
        gateway.db.prepare("SELECT owner_id FROM devices").all() as Array<{
          owner_id: string;
        }>
      ).map(plainRow)
    ).toStrictEqual([{ owner_id: "m-early" }]);
    // Role-bearing invitations cannot be honoured; 15-minute tickets drop.
    expect(
      plainRow(
        gateway.db.prepare("SELECT count(*) AS n FROM tickets").get() as {
          n: number;
        }
      )
    ).toStrictEqual({ n: 0 });
    // The share-target pointer died with the /share plane; other prefs stay.
    expect(gateway.prefRows().map((row) => row.key)).toStrictEqual([
      "agent.runner.kind",
    ]);
    // Idempotent: a second open finds no `members` table and changes nothing.
    const again = GatewayDatabase.open(dir);
    again.close();
  });

  test("the real gateway tree and every database table contain no raw or base64 key bytes", async () => {
    const dir = await tempDir();
    const gateway = GatewayDatabase.open(dir);
    opened.push(gateway);
    const keyStore = new KeyStore(path.join(dir, "keys"), {
      protector: aesGcmKeyProtector(Buffer.alloc(32, 0xa5)),
    });
    const endpointSecret = Buffer.alloc(32, 0x11);
    const connectionsSecret = Buffer.alloc(32, 0x33);
    const keyringSecret = Buffer.alloc(32, 0x44);
    keyStore.store("endpoint-key.bin", endpointSecret);
    keyStore.store("connections.sealkey", connectionsSecret);
    keyStore.store("keyring.key", keyringSecret);
    const registry = openVaultRegistry({
      rootDir: path.join(dir, "vault"),
      cacheRootDir: path.join(dir, "cache"),
      keyStore,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      ownerName: "Priya",
    });
    const vault = registry.create("Protected vault");
    const plane = registry.get(vault.vaultId)!;
    expect(
      plane.gateway.invoke(plane.ownerCredential, {
        command: "locker.add_item",
        input: {
          type: "login",
          title: "example.com",
          username: "priya",
          password: "real-sealed-row",
        },
        purpose: "dpv:ServiceProvision",
      }).status
    ).toBe("executed");
    const vaultSecret = keyStore.export(`${vault.vaultId}.sealkey`);
    expect(vaultSecret).toHaveLength(32);
    registry.stop();
    const secrets = [
      endpointSecret,
      vaultSecret!,
      connectionsSecret,
      keyringSecret,
    ];
    const connections = await StorageConnectionStore.open({
      database: gateway,
      keyStore,
    });
    await connections.create({
      kind: "provider",
      name: "Encrypted provider",
      baseUrl: "https://storage.example.test",
      apiKey: "provider-credential-not-a-key-store-secret",
    });

    const tables = gateway.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const rows = gateway.db.prepare(`SELECT * FROM "${name}"`).all() as Array<
        Record<string, unknown>
      >;
      const bytes = Buffer.from(
        JSON.stringify(rows, (_key, value) =>
          Buffer.isBuffer(value) ? value.toString("base64") : value
        )
      );
      for (const secret of secrets) {
        expect(bytes).not.toContain(secret);
        expect(bytes.toString("utf8")).not.toContain(secret.toString("base64"));
      }
    }

    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name));
    expect(files).toContain(path.join(dir, "gateway.db"));
    for (const file of files) {
      const bytes = readFileSync(file);
      for (const secret of secrets) {
        expect(bytes).not.toContain(secret);
        expect(bytes.toString("utf8")).not.toContain(secret.toString("base64"));
      }
    }
  });

  /*
   * Issue #568 item I. The previous darwin probe shelled out to
   * `/usr/bin/stat -f '%T'`, which is the `ls -F` type indicator, not a
   * filesystem type — it exited 0 with a value nothing could match and, worse,
   * suppressed the `statfsSync` fallback. These cover the replacement, which
   * reads the mount table's `f_fstypename` the way `/sbin/mount` prints it.
   */
  const MOUNT_TABLE = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)",
    "//guest@nas._smb._tcp.local/media on /Volumes/media (smbfs, nodev, nosuid, mounted by srikanth)",
    "nas:/export/backups on /Volumes/backups (nfs, nodev, nosuid)",
    "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)",
  ].join("\n");

  test("darwin filesystem detection reads the mount table type, longest mount point wins", () => {
    expect(
      parseDarwinFileSystemType(MOUNT_TABLE, "/Users/srikanth/gw-data")
    ).toBe("apfs");
    expect(
      parseDarwinFileSystemType(MOUNT_TABLE, "/Volumes/media/gw-data")
    ).toBe("smbfs");
    expect(parseDarwinFileSystemType(MOUNT_TABLE, "/Volumes/backups")).toBe(
      "nfs"
    );
    // `/System/Volumes/Data/home` must not lose to the shorter `/` or
    // `/System/Volumes/Data` prefixes.
    expect(
      parseDarwinFileSystemType(MOUNT_TABLE, "/System/Volumes/Data/home/x")
    ).toBe("autofs");
  });

  test("darwin network detection answers true on remote mounts and false on local ones", () => {
    const read = (): string => MOUNT_TABLE;
    expect(darwinNetworkFileSystem("/Volumes/media/gw-data", read)).toBe(true);
    expect(darwinNetworkFileSystem("/Volumes/backups/gw-data", read)).toBe(
      true
    );
    expect(darwinNetworkFileSystem("/Users/srikanth/gw-data", read)).toBe(
      false
    );
  });

  test("an unreadable mount table stays undefined so the statfs fallback still runs", () => {
    expect(
      darwinNetworkFileSystem("/anywhere", () => undefined)
    ).toBeUndefined();
    // A path under no listed mount point is equally inconclusive.
    expect(
      darwinNetworkFileSystem("relative/not/absolute", () => MOUNT_TABLE)
    ).toBeUndefined();
  });
});
