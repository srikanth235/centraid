/*
 * Exit evidence #3 (#726): the vault identity keypair rides beside
 * the sealing key on the SAME recovery-kit path. `recover()` restores a
 * vault into a fresh data dir carrying its id, its identity keypair, AND its
 * data (grants included, since the whole `vault.db` restores) — proven here
 * by signing a challenge on the recovered vault and verifying it against the
 * public key recorded BEFORE the move. A local backup provider is enough:
 * this test is about key custody surviving the move, not the snapshot wire.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { wrapRecoveryKit } from "@centraid/backup";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  KeyStore,
  signWithVaultIdentity,
  vaultIdentityPublicKey,
  verifyVaultIdentitySignature,
} from "@centraid/vault";

import { GatewayDatabase } from "../serve/gateway-db.js";
import { HealthRegistry } from "../serve/health-registry.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import { openVaultRegistry } from "../serve/vault-registry.js";
import { BackupService } from "./backup-service.js";
import { recover } from "./recover.js";

const KIT_PASSWORD = "correct horse battery staple";
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function invoke(
  plane: VaultPlane,
  command: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  const out = plane.gateway.invoke(plane.ownerCredential, { command, input });
  if (out.status !== "executed")
    throw new Error(`${command} failed: ${JSON.stringify(out)}`);
  return (out as { output: Record<string, unknown> }).output;
}

const cleanups: Array<() => Promise<void> | void> = [];

describe("recover() restores the vault identity keypair alongside the DEK (#726 P1)", () => {
  afterEach(async () =>
    forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) => cleanup())
  );

  test("a recovered vault signs a challenge that verifies against the pre-move public key", async () => {
    const vaultRootA = await tempDir("recover-identity-a-vault");
    const keysA = new KeyStore(path.join(vaultRootA, "keys"));
    const registryA = openVaultRegistry({
      rootDir: vaultRootA,
      keyStore: keysA,
      logger: silentLogger,
      ownerName: "Mara",
    });
    cleanups.push(() => registryA.stop());
    registryA.create("Mara's vault");
    const vaultId = registryA.defaultVaultId();
    const planeA = registryA.get(vaultId)!;

    // The vault's identity, recorded BEFORE the move — this is what a peer
    // would have pinned ahead of time.
    const publicKeyBeforeMove = vaultIdentityPublicKey(planeA.db.identitySeed);

    // A real data row, so "recovers with data intact" is more than the
    // schema alone.
    const taskId = invoke(planeA, "schedule.add_task", {
      title: "Frame the print",
    })["task_id"] as string;

    const providerDir = await tempDir("recover-identity-provider");
    const backupDirA = await tempDir("recover-identity-a-backup");
    const serviceA = new BackupService({
      config: { enabled: true, provider: { kind: "local", dir: providerDir } },
      cacheDir: backupDirA,
      keyStore: keysA,
      vaults: registryA,
      health: new HealthRegistry(),
      logger: silentLogger,
    });
    cleanups.push(() => serviceA.stop());
    await serviceA.runBackup(vaultId);
    const kitDocument = wrapRecoveryKit(
      await serviceA.recoveryKitDocument(),
      KIT_PASSWORD
    );
    // The kit MUST carry the identity seed beside the seal key.
    expect(kitDocument.fingerprint, "kit did not wrap").toBeTruthy();

    await serviceA.stop();
    registryA.stop();

    const dataDirB = await tempDir("recover-identity-b-data");
    const vaultRootB = path.join(dataDirB, "vault");
    const keysB = new KeyStore(path.join(dataDirB, "keys"));
    const gatewayDatabaseB = GatewayDatabase.open(dataDirB);
    cleanups.push(() => gatewayDatabaseB.close());

    const report = await recover({
      kitDocument,
      password: KIT_PASSWORD,
      apiKey: "unused-for-a-local-provider",
      vaultRoot: vaultRootB,
      dataDir: dataDirB,
      gatewayDatabase: gatewayDatabaseB,
      keyStore: keysB,
      log: silentLogger,
    });
    expect(report.vaultId).toBe(vaultId);
    await expect(
      fs.stat(path.join(vaultRootB, vaultId, "vault.db"))
    ).resolves.toBeDefined();

    // Mount the recovered vault and pull ITS identity seed — restored from
    // the kit, not re-minted (a re-mint would fail the signature check below).
    const registryB = openVaultRegistry({
      rootDir: vaultRootB,
      keyStore: keysB,
      logger: silentLogger,
    });
    cleanups.push(() => registryB.stop());
    const planeB = registryB.get(vaultId)!;
    expect(planeB.db.identitySeed).toStrictEqual(planeA.db.identitySeed);

    const challenge = Buffer.from("prove you are the same vault");
    const signature = signWithVaultIdentity(planeB.db.identitySeed, challenge);
    expect(
      verifyVaultIdentitySignature(publicKeyBeforeMove, challenge, signature)
    ).toBe(true);
    // A tampered challenge must NOT verify — the check is load-bearing.
    expect(
      verifyVaultIdentitySignature(
        publicKeyBeforeMove,
        Buffer.from("a different challenge"),
        signature
      )
    ).toBe(false);

    const tasks = planeB.db.vault
      .prepare("SELECT task_id FROM schedule_task WHERE task_id = ?")
      .get(taskId) as { task_id: string } | undefined;
    expect(tasks?.task_id).toBe(taskId);
  });
});
