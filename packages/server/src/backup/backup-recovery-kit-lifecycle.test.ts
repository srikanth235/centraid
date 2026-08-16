import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { WAL_DB_FILES, wrapRecoveryKit } from "@centraid/backup";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";

import { HealthRegistry } from "../serve/health-registry.js";
import { openVaultRegistry } from "../serve/vault-registry.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import type { BackupConfig } from "./backup-config.js";
import { BackupService } from "./backup-service.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];

describe("backup-recovery-kit-lifecycle", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });

  interface Harness {
    service: BackupService;
    registry: VaultRegistry;
    vaultId: string;
    clock: { now: number };
  }

  async function harness(): Promise<Harness> {
    const vaultRoot = await tempDir("backup-kit-vault");
    const providerDir = await tempDir("backup-kit-provider");
    const backupDir = await tempDir("backup-kit-state");
    const fixtureDir = await tempDir("backup-kit-fixture");
    const fixtureFile = path.join(fixtureDir, "vault.db");
    await fs.writeFile(fixtureFile, "v0");

    const registry = openVaultRegistry({
      rootDir: vaultRoot,
      logger: silentLogger,
      ownerName: "Priya",
    });
    registry.create("Test vault");
    cleanups.push(() => registry.stop());

    const clock = { now: Date.now() };
    const config: BackupConfig = {
      enabled: true,
      provider: { kind: "local", dir: providerDir },
    };
    const service = new BackupService({
      config,
      cacheDir: backupDir,
      vaults: registry,
      health: new HealthRegistry(),
      logger: silentLogger,
      now: () => clock.now,
      assembleEntries: ({ plane }) =>
        Promise.resolve([
          ...plane.walShipper!.currentBases().map((base) => ({
            path: WAL_DB_FILES[base.db],
            kind: "db" as const,
            absolutePath: base.file,
            sha256: base.sha256,
            walGeneration: base.generation,
            baseTickMs: base.createdAtMs,
          })),
          {
            path: "fixture.bin",
            kind: "blob" as const,
            absolutePath: fixtureFile,
          },
        ]),
    });

    return { service, registry, vaultId: registry.defaultVaultId(), clock };
  }

  async function verifyExportedKit(h: Harness) {
    const kit = wrapRecoveryKit(
      await h.service.recoveryKitDocument(),
      "test-password"
    );
    return h.service.verifyRecoveryKit({
      kit,
      password: "test-password",
      lossConsent: true,
    });
  }

  test("confirming again refreshes the timestamp rather than erroring", async () => {
    const h = await harness();
    h.clock.now = Date.UTC(2026, 6, 11, 12, 0, 0);
    await verifyExportedKit(h);

    h.clock.now += 60_000;
    const second = await verifyExportedKit(h);
    expect(second.confirmedAt).toBe(Math.floor(h.clock.now / 1000));
  });

  test("verifying the exported kit does not disturb existing per-vault target state", async () => {
    const h = await harness();
    await h.service.runBackup(h.vaultId);
    const beforeTargets = await h.service.status();

    await verifyExportedKit(h);

    await expect(h.service.status()).resolves.toStrictEqual(beforeTargets);
  });

  test("target and epoch changes stale the kit once; local-only vaults and unchanged exports do not", async () => {
    const h = await harness();
    await verifyExportedKit(h);
    const initial = await h.service.recoveryKitStatus();
    expect(initial.confirmedAt).not.toBeNull();

    h.registry.create("Local only");
    await expect(h.service.recoveryKitStatus()).resolves.toStrictEqual(initial);

    await h.service.runBackup(h.vaultId);
    const firstTargetStale = await h.service.recoveryKitStatus();
    expect(firstTargetStale.confirmedAt).toBeNull();
    expect(firstTargetStale.kitFingerprint).not.toBe(initial.kitFingerprint);
    const oneTarget = await h.service.recoveryKitDocument();
    expect(oneTarget.targets.map((target) => target.vaultId)).toStrictEqual([
      h.vaultId,
    ]);
    await expect(h.service.recoveryKitStatus()).resolves.toStrictEqual(
      firstTargetStale
    );

    await verifyExportedKit(h);
    const confirmedOneTarget = await h.service.recoveryKitStatus();
    await h.service.recoveryKitDocument();
    await expect(h.service.recoveryKitStatus()).resolves.toStrictEqual(
      confirmedOneTarget
    );

    const secondVault = h.registry
      .list()
      .find((vault) => vault.name === "Local only")!;
    await h.service.runBackup(secondVault.vaultId);
    const secondTargetStale = await h.service.recoveryKitStatus();
    expect(secondTargetStale.confirmedAt).toBeNull();
    expect(secondTargetStale.kitFingerprint).not.toBe(
      confirmedOneTarget.kitFingerprint
    );
    expect((await h.service.recoveryKitDocument()).targets).toHaveLength(2);

    await verifyExportedKit(h);
    const beforeRotation = await h.service.recoveryKitStatus();
    const rotated = await h.service.rotateKeyEpoch();
    expect(rotated.active).toBe(2);
    const epochStale = await h.service.recoveryKitStatus();
    expect(epochStale.confirmedAt).toBeNull();
    expect(epochStale.kitFingerprint).not.toBe(beforeRotation.kitFingerprint);
  });
});
