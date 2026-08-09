import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { describe, afterEach, expect, test, vi } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { KeyStore } from "@centraid/vault";

import { RecoveryKitStateStore } from "../backup/recovery-kit-state.js";
import { daemonLayoutFor } from "../cli/paths.js";
import { EnrollmentStore } from "../serve/enrollment-store.js";
import { recoverPendingVaultErases } from "../serve/erase-recovery.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { runWithVaultContext } from "../serve/vault-context.js";
import { openVaultRegistry } from "../serve/vault-registry.js";
import { WebControlSessionStore } from "../serve/web-session-store.js";
import { makeVaultRouteHandler } from "./vault-routes.js";

const cleanups: Array<() => Promise<void> | void> = [];

function plainRow<T extends object>(row: T): T {
  return { ...row };
}

function plainRows<T extends object>(rows: T[]): T[] {
  return rows.map(plainRow);
}

describe("vault-erase scenarios", () => {
  afterEach(async () =>
    forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) => cleanup())
  );

  async function treeShape(root: string, relative = ""): Promise<string[]> {
    const dir = path.join(root, relative);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const rows = await Promise.all(
      entries.map(async (entry) => {
        const child = path.join(relative, entry.name);
        const row = `${entry.isDirectory() ? "d" : "f"}:${child}`;
        return entry.isDirectory()
          ? [row, ...(await treeShape(root, child))]
          : [row];
      })
    );
    return rows.flat().sort();
  }

  async function markKitVerified(store: RecoveryKitStateStore): Promise<void> {
    await store.begin("test-kit-fingerprint");
    await expect(store.verify("test-kit-fingerprint")).resolves.toBeTruthy();
  }

  test("erasing the last vault cascades gateway state, destroys its DEK, and preserves gateway identity", async () => {
    const dataDir = await tempDir("vault-erase-");
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const layout = daemonLayoutFor(dataDir);
    const database = GatewayDatabase.open(dataDir);
    cleanups.push(() => database.close());
    const keys = new KeyStore(layout.keysDir);
    keys.store("endpoint-key.bin", randomBytes(32));
    const endpointBefore = keys.export("endpoint-key.bin");
    const vaultlessShape = await treeShape(dataDir);

    const registry = openVaultRegistry({
      rootDir: layout.vaultDir,
      cacheRootDir: layout.cacheDir,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    cleanups.push(() => registry.stop());
    const vault = registry.create("Family");
    keys.store(`${vault.vaultId}.sealkey.next`, randomBytes(32));

    const enrollments = EnrollmentStore.open(database);
    enrollments.enroll({
      endpointId: "owner-device",
      vaultIds: [vault.vaultId],
      label: "Owner laptop",
    });
    WebControlSessionStore.open(database).establish({
      tokenHash: "session-hash",
      vaultId: vault.vaultId,
      deviceKey: "owner-device",
      shellOrigin: "http://127.0.0.1:4173",
    });
    const invitedOwner = enrollments.owners.create("Invited");
    database.run(
      `INSERT INTO tickets (
      ticket_id, secret_hash, owner_id, grants_json, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
      "pending-pair",
      "secret-hash",
      invitedOwner.ownerId,
      JSON.stringify([vault.vaultId]),
      new Date(0).toISOString(),
      Date.now() + 60_000
    );
    database.run(
      `INSERT INTO backup_targets (target_id, vault_id, config_json, updated_at)
     VALUES (?, ?, ?, ?)`,
      "backup-target",
      vault.vaultId,
      "{}",
      new Date(0).toISOString()
    );
    database.run(
      `INSERT INTO cas_reconciliations (vault_id, state_json, updated_at)
     VALUES (?, ?, ?)`,
      vault.vaultId,
      "{}",
      new Date(0).toISOString()
    );
    const recoveryKit = new RecoveryKitStateStore(database);
    await markKitVerified(recoveryKit);
    const fenceVaultForErase = vi.fn<(vaultId: string) => Promise<void>>(
      async (vaultId) => {
        expect(vaultId).toBe(vault.vaultId);
        expect(registry.get(vaultId)).toBeTruthy();
      }
    );

    const handler = makeVaultRouteHandler(registry, {
      enrollments,
      gatewayDatabase: database,
      keys,
      recoveryKit,
      fenceVaultForErase,
    });
    const server = http.createServer((req, res) => {
      void runWithVaultContext(
        { vaultId: vault.vaultId, deviceKey: "owner-device" },
        () => handler(req, res)
      );
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await fetch(`${base}/centraid/_vault/vaults:erase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Family" }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      erasedVaultId: vault.vaultId,
      remainingVaults: 0,
    });
    expect(fenceVaultForErase).toHaveBeenCalledOnce();

    expect(registry.isFresh()).toBe(true);
    expect(enrollments.list()).toStrictEqual([]);
    expect(
      plainRow(
        database.db
          .prepare("SELECT COUNT(*) AS count FROM web_sessions")
          .get() as { count: number }
      )
    ).toStrictEqual({
      count: 0,
    });
    const tables = database.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const columns = database.db
        .prepare(`PRAGMA table_info("${name}")`)
        .all() as Array<{
        name: string;
      }>;
      if (!columns.some((column) => column.name === "vault_id")) continue;
      expect(
        plainRow(
          database.db
            .prepare(
              `SELECT COUNT(*) AS count FROM "${name}" WHERE vault_id = ?`
            )
            .get(vault.vaultId) as { count: number }
        ),
        `${name} retained the erased vault id`
      ).toStrictEqual({ count: 0 });
    }
    expect(keys.export(`${vault.vaultId}.sealkey`)).toBeNull();
    expect(keys.export(`${vault.vaultId}.sealkey.next`)).toBeNull();
    expect(keys.export("endpoint-key.bin")).toStrictEqual(endpointBefore);
    await expect(recoveryKit.status()).resolves.toMatchObject({
      confirmedAt: expect.any(Number),
    });
    await expect(treeShape(dataDir)).resolves.toStrictEqual(vaultlessShape);
  });

  test("a crash after erase state commit is completed before the next registry mount", async () => {
    const dataDir = await tempDir("vault-erase-crash-");
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const layout = daemonLayoutFor(dataDir);
    const database = GatewayDatabase.open(dataDir);
    cleanups.push(() => database.close());
    const keys = new KeyStore(layout.keysDir);
    const registry = openVaultRegistry({
      rootDir: layout.vaultDir,
      cacheRootDir: layout.cacheDir,
      keyStore: keys,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    const vault = registry.create("Crash test");
    const enrollments = EnrollmentStore.open(database);
    enrollments.enroll({
      endpointId: "owner-device",
      vaultIds: [vault.vaultId],
      label: "Owner laptop",
    });
    const recoveryKit = new RecoveryKitStateStore(database);
    await markKitVerified(recoveryKit);
    const handler = makeVaultRouteHandler(registry, {
      enrollments,
      gatewayDatabase: database,
      keys,
      recoveryKit,
      afterEraseStateCommitted: () => {
        throw new Error("injected crash after state commit");
      },
    });
    const server = http.createServer((req, res) => {
      void runWithVaultContext(
        { vaultId: vault.vaultId, deviceKey: "owner-device" },
        () => handler(req, res)
      );
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const response = await fetch(`${base}/centraid/_vault/vaults:erase`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Crash test" }),
    });
    expect(response.status).toBe(500);
    expect(enrollments.list()).toStrictEqual([]);
    expect(
      plainRows(
        database.db
          .prepare("SELECT vault_id FROM erase_intents")
          .all() as Array<{ vault_id: string }>
      )
    ).toStrictEqual([{ vault_id: vault.vaultId }]);
    await expect(
      fs.access(path.join(layout.vaultDir, vault.vaultId, "vault.db"))
    ).resolves.toBeUndefined();

    registry.stop();
    expect(
      recoverPendingVaultErases({
        gatewayDatabase: database,
        vaultRoot: layout.vaultDir,
        cacheRoot: layout.cacheDir,
        keys,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      })
    ).toStrictEqual([vault.vaultId]);
    expect(
      plainRow(
        database.db
          .prepare("SELECT COUNT(*) AS count FROM erase_intents")
          .get() as { count: number }
      )
    ).toStrictEqual({
      count: 0,
    });
    await expect(
      fs.access(path.join(layout.vaultDir, vault.vaultId))
    ).rejects.toThrow("ENOENT");
    expect(keys.export(`${vault.vaultId}.sealkey`)).toBeNull();
  });

  /*
   * Every erase REFUSAL path (issue #568 item L).
   *
   * #555's safety argument for putting erase in Settings rather than behind a
   * CLI was typed-name confirmation plus a guaranteed recovery kit. Until now
   * neither guard had a test proving it refuses — only production grep hits —
   * so a regression that turned any of these into a 200 would have shipped
   * green. Erase is irreversible; each of these is the last thing standing
   * between a mistaken click and a destroyed vault.
   */
  async function eraseFixture(
    options: { owner?: boolean; custody?: boolean } = {}
  ): Promise<{
    base: string;
    vaultName: string;
    recoveryKit: RecoveryKitStateStore;
    erase: (body: unknown) => Promise<Response>;
    eraseWithMethod: (method: string) => Promise<Response>;
    deleteVault: () => Promise<Response>;
  }> {
    const dataDir = await tempDir("vault-erase-refusal-");
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const layout = daemonLayoutFor(dataDir);
    const database = GatewayDatabase.open(dataDir);
    cleanups.push(() => database.close());
    const keys = new KeyStore(layout.keysDir);
    keys.store("endpoint-key.bin", randomBytes(32));
    const registry = openVaultRegistry({
      rootDir: layout.vaultDir,
      cacheRootDir: layout.cacheDir,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    cleanups.push(() => registry.stop());
    const vault = registry.create("Family");
    const enrollments = EnrollmentStore.open(database);
    // `owner: false` models a device whose owner does NOT own this vault —
    // the enrollment view then simply has no row for (device, vault).
    enrollments.enroll({
      endpointId: "caller-device",
      vaultIds: options.owner === false ? ["vault-elsewhere"] : [vault.vaultId],
      label: "Caller",
    });
    const recoveryKit = new RecoveryKitStateStore(database);
    const handler = makeVaultRouteHandler(registry, {
      enrollments,
      // `custody: false` models a host wired without erase custody — the
      // gateway must refuse rather than half-erase.
      ...(options.custody === false
        ? {}
        : { gatewayDatabase: database, keys, recoveryKit }),
    });
    const server = http.createServer((req, res) => {
      void runWithVaultContext(
        { vaultId: vault.vaultId, deviceKey: "caller-device" },
        () =>
          handler(req, res).then((handled) => {
            if (!handled) {
              res.statusCode = 404;
              res.end();
            }
          })
      );
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      base,
      vaultName: vault.name,
      recoveryKit,
      erase: (body: unknown) =>
        fetch(`${base}/centraid/_vault/vaults:erase`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      eraseWithMethod: (method: string) =>
        fetch(`${base}/centraid/_vault/vaults:erase`, { method }),
      deleteVault: () =>
        fetch(`${base}/centraid/_vault/vaults/${vault.vaultId}`, {
          method: "DELETE",
        }),
    };
  }

  test("erase refuses a non-owner caller", async () => {
    const fixture = await eraseFixture({ owner: false });
    const response = await fixture.erase({ name: fixture.vaultName });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "owner_required",
    });
  });

  test("erase refuses a host with no custody wiring", async () => {
    const fixture = await eraseFixture({ custody: false });
    const response = await fixture.erase({ name: fixture.vaultName });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "erase_unavailable",
    });
  });

  test("erase refuses a wrong, missing, or near-miss typed name", async () => {
    const fixture = await eraseFixture();
    await markKitVerified(fixture.recoveryKit);
    const bodies: unknown[] = [
      {},
      { name: "" },
      { name: "family" },
      { name: " Family" },
      { name: "Family " },
      { name: "Personal" },
    ];
    await forEachSequentially(bodies, async (body) => {
      const response = await fixture.erase(body);
      expect(response.status, JSON.stringify(body)).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: "typed_name_required",
      });
    });
  });

  test("erase refuses while the recovery kit is unverified", async () => {
    const fixture = await eraseFixture();
    // Begun but never verified — the ceremony's own half-open state.
    await fixture.recoveryKit.begin("unverified-fingerprint");
    const response = await fixture.erase({ name: fixture.vaultName });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "recovery_kit_not_verified",
    });
  });

  test("a generic vault DELETE is refused and redirected to the erase ceremony", async () => {
    const fixture = await eraseFixture();
    await markKitVerified(fixture.recoveryKit);
    const response = await fixture.deleteVault();
    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      error: "erase_ceremony_required",
    });
  });

  test("erase refuses a non-POST method before any guard runs", async () => {
    const fixture = await eraseFixture();
    const response = await fixture.eraseWithMethod("GET");
    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toMatchObject({
      error: "method_not_allowed",
    });
  });
});
