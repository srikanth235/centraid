import { promises as fs } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { openLocalBackupProvider, WAL_DB_FILES } from "@centraid/backup";
import type { BackupProvider } from "@centraid/backup";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import { updateBlobStoreSettings } from "@centraid/vault";
import type { BlobStore, RemoteTier } from "@centraid/vault";

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
describe("backup-service-restore", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  interface Harness {
    service: BackupService;
    registry: VaultRegistry;
    vaultId: string;
  }

  async function harness(
    wrapProvider?: (real: BackupProvider) => BackupProvider,
    opts: { blobEntry?: boolean } = {}
  ): Promise<Harness> {
    const includeBlobEntry = opts.blobEntry ?? true;
    const vaultRoot = await tempDir("r439-vault");
    const providerDir = await tempDir("r439-provider");
    const backupDir = await tempDir("r439-state");
    const registry = openVaultRegistry({
      rootDir: vaultRoot,
      logger: silentLogger,
      ownerName: "Priya",
    });
    registry.create("Personal");
    cleanups.push(() => registry.stop());
    const vaultId = registry.defaultVaultId();

    const fixtureDir = await tempDir("r439-fixture");
    const fixtureFile = path.join(fixtureDir, "vault.db");
    await fs.writeFile(fixtureFile, "v0");

    const config: BackupConfig = {
      enabled: true,
      provider: { kind: "local", dir: providerDir },
    };
    const realProvider = openLocalBackupProvider({ rootDir: providerDir });
    const service = new BackupService({
      config,
      cacheDir: backupDir,
      vaults: registry,
      health: new HealthRegistry(),
      logger: silentLogger,
      provider: wrapProvider ? wrapProvider(realProvider) : realProvider,
      assembleEntries: ({ plane }) => {
        const base = plane.walShipper!.currentBase()!;
        return Promise.resolve([
          {
            path: WAL_DB_FILES.vault,
            kind: "db" as const,
            absolutePath: base.file,
            sha256: base.sha256,
            walGeneration: base.generation,
            baseTickMs: base.createdAtMs,
          },
          ...(includeBlobEntry
            ? [
                {
                  path: "fixture.bin",
                  kind: "blob" as const,
                  absolutePath: fixtureFile,
                },
              ]
            : []),
        ]);
      },
    });
    return { service, registry, vaultId };
  }

  function declareRemoteTier(registry: VaultRegistry): void {
    updateBlobStoreSettings(registry.current().db, {
      blob_store: {
        kind: "s3",
        endpoint: "https://remote.invalid",
        bucket: "r439",
      },
    });
  }

  function undialedRemote(): RemoteTier {
    const store: BlobStore = {
      kind: "undialed-remote",
      put: () =>
        Promise.reject(new Error("undialed-remote.put must not be called")),
      get: () => Promise.resolve(null),
      has: () => Promise.resolve(false),
      delete: () => Promise.resolve(),
      list: () => Promise.resolve([]),
      stat: () => Promise.resolve(null),
    };
    return { store };
  }

  function withRestoreCostClass(
    real: BackupProvider,
    restoreCostClass: "free-egress" | "metered-egress"
  ): BackupProvider {
    return {
      capabilities: async (...a) => {
        const caps = await real.capabilities(...a);
        return caps.backup
          ? { ...caps, backup: { ...caps.backup, restoreCostClass } }
          : caps;
      },
      createTarget: (...a) => real.createTarget(...a),
      deleteTarget: (...a) => real.deleteTarget(...a),
      undeleteTarget: (...a) => real.undeleteTarget(...a),
      purgeTarget: (...a) => real.purgeTarget(...a),
      openDataPlane: (...a) => real.openDataPlane(...a),
      registerSnapshot: (...a) => real.registerSnapshot(...a),
      listSnapshots: (...a) => real.listSnapshots(...a),
      getSnapshot: (...a) => real.getSnapshot(...a),
      getTarget: (...a) => real.getTarget(...a),
      usage: (...a) => real.usage(...a),
    };
  }

  test("VaultDb.remote() is null without an s3 tier and resolves one when declared (#439 R2)", async () => {
    const h = await harness();
    expect(h.registry.current().db.remote()).toBeNull();
    declareRemoteTier(h.registry);
    expect(h.registry.current().db.remote()).not.toBeNull();
  });

  test("restore auto-resolves to a FULL materialization with no durable remote tier (#439 R2)", async () => {
    const h = await harness();
    await h.service.runBackup(h.vaultId);
    const destDir = path.join(await tempDir("r439-auto-full-dest"), "restored");
    const result = await h.service.restore({ vaultId: h.vaultId, destDir });
    expect(result.previewsWarm).toBeUndefined();
    expect(result.skippedBlobs).toStrictEqual([]);
  });

  test("restore is LAZY by default when the vault has a durable remote CAS tier (#439 R2)", async () => {
    const h = await harness(undefined, { blobEntry: false });
    declareRemoteTier(h.registry);
    await h.service.runBackup(h.vaultId);
    const destDir = path.join(await tempDir("r439-auto-lazy-dest"), "restored");
    const result = await h.service.restore({ vaultId: h.vaultId, destDir });
    expect(result.previewsWarm).toBeDefined();
    expect(result.previewsWarm?.tiniesTotal).toBe(0);
    expect(result.skippedBlobs).toStrictEqual([]);
  });

  test("restore honors full:true even when a durable remote CAS tier exists (#439 R2)", async () => {
    const h = await harness();
    declareRemoteTier(h.registry);
    await h.service.runBackup(h.vaultId);
    const destDir = path.join(
      await tempDir("r439-full-override-dest"),
      "restored"
    );
    const result = await h.service.restore({
      vaultId: h.vaultId,
      destDir,
      full: true,
    });
    expect(result.previewsWarm).toBeUndefined();
  });

  test("an explicit lazy option wins over full:true (#439 R2)", async () => {
    const h = await harness(undefined, { blobEntry: false });
    await h.service.runBackup(h.vaultId);
    const destDir = path.join(
      await tempDir("r439-explicit-lazy-dest"),
      "restored"
    );
    const result = await h.service.restore({
      vaultId: h.vaultId,
      destDir,
      lazy: { remote: undialedRemote() },
      full: true,
    });
    expect(result.previewsWarm).toBeDefined();
  });

  test("restoreEgressEstimate reports the metered cost class and full snapshot size (#439 R2)", async () => {
    const h = await harness((real) =>
      withRestoreCostClass(real, "metered-egress")
    );
    await h.service.runBackup(h.vaultId);
    const est = await h.service.restoreEgressEstimate({ vaultId: h.vaultId });
    expect(est.costClass).toBe("metered-egress");
    expect(est.seq).toBe(1);
    expect(est.fullBytes).toBeGreaterThan(0);
    expect(est.lazyAvailable).toBe(false);
  });

  test("restoreEgressEstimate reports a free-egress home and a resolvable lazy tier (#439 R2)", async () => {
    const h = await harness(undefined, { blobEntry: false });
    declareRemoteTier(h.registry);
    await h.service.runBackup(h.vaultId);
    const est = await h.service.restoreEgressEstimate({ vaultId: h.vaultId });
    expect(est.costClass).toBe("free-egress");
    expect(est.lazyAvailable).toBe(true);
  });
});
