import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, afterEach, expect, test } from "vitest";

import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { KeyStore } from "@centraid/vault";

import { RecoveryKitStateStore } from "../backup/recovery-kit-state.js";
import { daemonLayoutFor } from "../cli/paths.js";
import { EnrollmentStore } from "../serve/enrollment-store.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import { runWithVaultContext } from "../serve/vault-context.js";
import { openVaultRegistry } from "../serve/vault-registry.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { makeBackupRouteHandler } from "./backup-routes.js";
import { parseVaultIds, resolveInvitation } from "./device-invitations.js";
import { makeVaultRouteHandler } from "./vault-routes.js";

const cleanups: Array<() => Promise<void> | void> = [];
const HOST_CUSTODY = () => true;

async function mountedRegistry(): Promise<{
  dataDir: string;
  database: GatewayDatabase;
  keys: KeyStore;
  registry: VaultRegistry;
  enrollments: EnrollmentStore;
}> {
  const dataDir = await tempDir("p1-owner-only-");
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
  cleanups.push(() => registry.stop());
  const enrollments = EnrollmentStore.open(database);
  return { dataDir, database, keys, registry, enrollments };
}

describe("host custody loses erase/mint/backup-config on a vault it does not own (#726 P1)", () => {
  afterEach(async () =>
    forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) => cleanup())
  );

  test("erase: host custody on an unowned vault gets owner_only naming the owner", async () => {
    const { registry, enrollments, database, keys } = await mountedRegistry();
    const vault = registry.create("Bob's Library");
    enrollments.enroll({
      endpointId: "bobs-phone",
      vaultIds: [vault.vaultId],
      label: "Bob's phone",
      ownerLabel: "Bob",
    });
    const recoveryKit = new RecoveryKitStateStore(database);
    await recoveryKit.begin("kit-fp");
    await expect(recoveryKit.verify("kit-fp")).resolves.toBeTruthy();

    const handler = makeVaultRouteHandler(registry, {
      enrollments,
      gatewayDatabase: database,
      keys,
      recoveryKit,
      isHostCustody: HOST_CUSTODY,
    });
    const server = http.createServer((req, res) => {
      void runWithVaultContext(
        { vaultId: vault.vaultId, deviceKey: undefined },
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
      body: JSON.stringify({ name: "Bob's Library" }),
    });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "owner_only",
      message: expect.stringContaining("Bob"),
    });
    expect(registry.get(vault.vaultId)).toBeTruthy();
  });

  test("backup-target config: host custody on an unowned vault gets owner_only naming the owner", async () => {
    const { registry, enrollments } = await mountedRegistry();
    const vault = registry.create("Bob's Library");
    enrollments.enroll({
      endpointId: "bobs-phone",
      vaultIds: [vault.vaultId],
      label: "Bob's phone",
      ownerLabel: "Bob",
    });

    const handler = makeBackupRouteHandler({
      vaults: registry,
      enrollments,
      isHostCustody: HOST_CUSTODY,
    });
    const server = http.createServer((req, res) => {
      void handler(req, res).then((owned) => {
        if (!owned) {
          res.statusCode = 404;
          res.end();
        }
      });
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

    const response = await fetch(
      `${base}/centraid/_gateway/backup/policy/${vault.vaultId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rpoSeconds: 60 }),
      }
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "owner_only",
      message: expect.stringContaining("Bob"),
    });
  });

  test("ticket-mint: host custody targeting a vault it does not own gets owner_only naming the owner", async () => {
    const { registry, enrollments } = await mountedRegistry();
    const shared = registry.create("Shared");
    const bobsVault = registry.create("Bob's Library");
    const alice = enrollments.enroll({
      endpointId: "alices-laptop",
      vaultIds: [shared.vaultId],
      label: "Alice's laptop",
      ownerLabel: "Alice",
    });
    enrollments.enroll({
      endpointId: "bobs-phone",
      vaultIds: [bobsVault.vaultId],
      label: "Bob's phone",
      ownerLabel: "Bob",
    });

    const decision = resolveInvitation({
      enrollments,
      vaultName: (id) => registry.get(id)?.name,
      callerKey: undefined,
      hostCustody: true,
      target: bobsVault.vaultId,
      body: { ownerId: alice.ownerId },
      vaultIds: parseVaultIds([bobsVault.vaultId]) ?? [],
    });
    expect(decision).toMatchObject({
      status: 403,
      error: "owner_only",
    });
    expect("message" in decision && decision.message).toContain("Bob");
  });
});
