import { promises as fs } from "node:fs";
import path from "node:path";

import {
  openLocalBackupProvider,
  wrapRecoveryKit,
  WAL_DB_FILES,
  type BackupProvider,
} from "@centraid/backup";
import { forEachSequentially } from "@centraid/test-kit/sequential";
import { tempDir } from "@centraid/test-kit/temp-dir";
import {
  updateBackupPolicy,
  updateBlobStoreSettings,
  KeyStore,
  ReplicaIndex,
  sealKeyFileFor,
  type BackupPolicyPatch,
} from "@centraid/vault";
import { afterEach, describe, expect, test, vi } from "vitest";

import { HealthRegistry } from "../serve/health-registry.js";
import {
  openVaultRegistry,
  type VaultRegistry,
} from "../serve/vault-registry.js";
import { runCasOnlyReconciliation } from "./backup-cas-reconciliation.js";
import type { BackupConfig } from "./backup-config.js";
import { conflictAfterFirstCall } from "./backup-conflict-provider.js";
import {
  BackupService,
  recoveryWindowMs,
  walDrainDelayMs,
} from "./backup-service.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const cleanups: Array<() => Promise<void> | void> = [];
describe("backup-service", () => {
  afterEach(async () => {
    await forEachSequentially(cleanups.splice(0).toReversed(), (cleanup) =>
      cleanup()
    );
  });
  function openRegistry(rootDir: string): VaultRegistry {
    const registry = openVaultRegistry({
      rootDir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    registry.create("Test vault");
    cleanups.push(() => registry.stop());
    return registry;
  }

  interface Harness {
    service: BackupService;
    registry: VaultRegistry;
    health: HealthRegistry;
    vaultId: string;
    fixtureFile: string;
    clock: { now: number };
    providerDir: string;
    backupDir: string;
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

  async function harness(
    policy: BackupPolicyPatch = {},
    wrapProvider?: (real: BackupProvider) => BackupProvider
  ): Promise<Harness> {
    const vaultRoot = await tempDir("backup-svc-vault");
    const providerDir = await tempDir("backup-svc-provider");
    const backupDir = await tempDir("backup-svc-state");
    const registry = openRegistry(vaultRoot);
    const health = new HealthRegistry();
    const vaultId = registry.defaultVaultId();

    const fixtureDir = await tempDir("backup-svc-fixture");
    const fixtureFile = path.join(fixtureDir, "vault.db");
    await fs.writeFile(fixtureFile, "v0");

    const clock = { now: Date.now() };
    const config: BackupConfig = {
      enabled: true,
      provider: { kind: "local", dir: providerDir },
    };
    updateBackupPolicy(registry.current().db.vault, policy);
    const realProvider = openLocalBackupProvider({ rootDir: providerDir });
    const service = new BackupService({
      config,
      cacheDir: backupDir,
      vaults: registry,
      health,
      logger: silentLogger,
      now: () => clock.now,
      provider: wrapProvider ? wrapProvider(realProvider) : realProvider,
      assembleEntries: ({ plane }) => {
        const bases = plane.walShipper!.currentBases();
        return Promise.resolve([
          ...bases.map((base) => ({
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
        ]);
      },
    });

    return {
      service,
      registry,
      health,
      vaultId,
      fixtureFile,
      clock,
      providerDir,
      backupDir,
    };
  }

  test("recoveryWindowMs maps a retention ladder to its daily rung, non-ladder to none (issue #439 R4)", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    expect(
      recoveryWindowMs({
        kind: "ladder",
        keepAllDays: 7,
        dailyDays: 30,
        weeklyDays: 90,
        neverPruneNewest: true,
      })
    ).toBe(30 * DAY_MS);
    expect(recoveryWindowMs({ kind: "none" })).toBeUndefined();
    expect(recoveryWindowMs(undefined)).toBeUndefined();
  });

  test("the WAL clock is absent without a backend and follows actual remaining RPO (#456 I4)", () => {
    const now = 1_000_000;
    expect(walDrainDelayMs(false, [{ rpoSeconds: 30 }], now)).toBeUndefined();
    expect(
      walDrainDelayMs(
        true,
        [
          { rpoSeconds: 120, lastAttemptMs: now - 30_000 },
          { rpoSeconds: 60, lastAttemptMs: now - 30_000 },
          { rpoSeconds: 300, lastAttemptMs: now - 250_000 },
        ],
        now
      )
    ).toBe(30_000);
    expect(
      walDrainDelayMs(
        true,
        [{ rpoSeconds: 60, lastAttemptMs: now - 90_000 }],
        now
      )
    ).toBe(0);
    expect(walDrainDelayMs(true, [{ rpoSeconds: 60 }], now)).toBe(60_000);
    expect(walDrainDelayMs(true, [], now)).toBe(30_000);
  });

  test("first run creates a target, mints a keyring, and registers a snapshot", async () => {
    const h = await harness();
    await h.service.runBackup(h.vaultId);

    const status = (await h.service.status())[h.vaultId];
    expect(status?.targetId).toBeTruthy();
    expect(status?.generation).toBe(1);
    expect(status?.lastSeq).toBe(1);
    expect(status?.lastBackupAt).toBeTruthy();
    expect(status?.lastError).toBeUndefined();
    expect(status?.providerPolicy?.status).toBe("synced");

    const keys = new KeyStore(
      path.dirname(sealKeyFileFor(h.registry.current().dir))
    );
    expect(keys.export("keyring.key")).not.toBeNull();
    await expect(
      fs.access(path.join(h.backupDir, "keys"))
    ).rejects.toMatchObject({
      code: "ENOENT",
    });

    const snap = await h.health.snapshot();
    const backups = snap.components.find((c) => c.component === "backups");
    expect(backups?.status).toBe("ok");
  });

  test("erase fencing advances the provider generation before local state is removed", async () => {
    const h = await harness();
    await h.service.runBackup(h.vaultId);
    const target = (await h.service.status())[h.vaultId]!;
    expect(target.generation).toBe(1);

    await h.service.fenceVaultForErase(h.vaultId);

    const provider = openLocalBackupProvider({ rootDir: h.providerDir });
    expect((await provider.getTarget(target.targetId)).currentGeneration).toBe(
      2
    );
    expect((await h.service.status())[h.vaultId]?.generation).toBe(2);
  });

  test("a local policy change is pushed and its provider echo is persisted", async () => {
    const h = await harness();
    await h.service.runBackup(h.vaultId);
    updateBackupPolicy(h.registry.current().db.vault, { rpoSeconds: 15 * 60 });

    const synced = await h.service.syncPolicy(h.vaultId);
    const status = (await h.service.status())[h.vaultId];
    expect(synced).toMatchObject({
      status: "synced",
      desired: { rpoSeconds: 15 * 60 },
    });
    expect(status?.providerPolicy?.echo?.rpoSeconds).toBe(15 * 60);
  });

  test("a backup run pushes a policy changed outside the route", async () => {
    const h = await harness();
    await h.service.runBackup(h.vaultId);
    updateBackupPolicy(h.registry.current().db.vault, { verifyEveryDays: 3 });

    await h.service.runBackup(h.vaultId);

    expect((await h.service.status())[h.vaultId]?.providerPolicy).toMatchObject(
      {
        status: "synced",
        desired: { verifyEveryDays: 3 },
        echo: { verifyEveryDays: 3 },
      }
    );
  });

  test("remote-primary CAS is reconciled and persisted on policy cadence without a backup target", async () => {
    const vaultRoot = await tempDir("backup-svc-cas-only-vault");
    const backupDir = await tempDir("backup-svc-cas-only-state");
    const registry = openRegistry(vaultRoot);
    const plane = registry.current();
    updateBlobStoreSettings(plane.db, {
      blob_store: {
        kind: "s3",
        connectionId: "cas-only",
        connectionKind: "provider",
      },
    });
    const clock = { now: Date.now() };
    const casReconcile = vi.fn<typeof runCasOnlyReconciliation>((opts) =>
      runCasOnlyReconciliation({
        ...opts,
        collect: async () => ({
          configured: true,
          collection: {
            source: "bucket",
            providerAttested: false,
            objects: [],
          },
        }),
      })
    );
    const health = new HealthRegistry();
    const service = new BackupService({
      cacheDir: backupDir,
      vaults: registry,
      health,
      logger: silentLogger,
      now: () => clock.now,
      casReconcile,
    });
    cleanups.push(() => service.stop());

    await service.tick();
    expect(casReconcile).toHaveBeenCalledOnce();
    await expect(service.status()).resolves.toStrictEqual({});
    expect(
      (await service.casReconciliationStatus())[plane.boot.vaultId]
    ).toMatchObject({
      status: "ok",
      backup: { configured: false },
      cas: { configured: true, source: "bucket" },
    });
    const snapshot = await health.snapshot();
    expect(
      snapshot.components.find((component) => component.component === "backups")
    ).toMatchObject({
      status: "degraded",
      detail: expect.stringMatching(
        /offsite bytes.*recovery kit cannot restore/iu
      ),
    });

    await service.tick();
    expect(casReconcile).toHaveBeenCalledOnce();
    clock.now += 8 * 24 * 60 * 60 * 1000;
    await service.tick();
    expect(casReconcile).toHaveBeenCalledTimes(2);
  });

  test("CAS-only authenticated corruption remains an error through the health probe", async () => {
    const vaultRoot = await tempDir("backup-svc-cas-health-vault");
    const backupDir = await tempDir("backup-svc-cas-health-state");
    const registry = openRegistry(vaultRoot);
    const plane = registry.current();
    updateBlobStoreSettings(plane.db, {
      blob_store: {
        kind: "s3",
        connectionId: "cas-only",
        connectionKind: "provider",
      },
    });
    const corrupt = "b".repeat(64);
    new ReplicaIndex(plane.db.vault).mark(corrupt, 10);
    const health = new HealthRegistry();
    const service = new BackupService({
      cacheDir: backupDir,
      vaults: registry,
      health,
      logger: silentLogger,
      casReconcile: (opts) =>
        runCasOnlyReconciliation({
          ...opts,
          collect: async () => ({
            configured: true,
            collection: {
              source: "provider",
              providerAttested: true,
              objects: [
                {
                  key: `blobs/sha256/${corrupt}`,
                  sizeBytes: 10,
                  etagOrHash: corrupt,
                  storedAt: 1,
                  state: "live",
                },
              ],
            },
            authenticatedFailures: [corrupt],
          }),
        }),
    });
    cleanups.push(() => service.stop());

    await service.runReconciliation(plane.boot.vaultId);
    const first = await health.snapshot();
    const second = await health.snapshot();
    for (const snapshot of [first, second]) {
      expect(
        snapshot.components.find((row) => row.component === "backups")
      ).toMatchObject({
        status: "error",
      });
      expect(
        snapshot.components.find((row) => row.component === "backups")?.detail
      ).toMatch(/1 missing\/corrupt/u);
    }
  });

  test("stop refuses new backup work after the in-flight chain is drained", async () => {
    const h = await harness();
    await h.service.stop();

    await expect(h.service.runBackup(h.vaultId)).rejects.toThrow(
      "backup service is stopped"
    );
    await expect(h.service.runVerify(h.vaultId)).rejects.toThrow(
      "backup service is stopped"
    );
    await expect(h.service.runRestoreVerify(h.vaultId)).rejects.toThrow(
      "backup service is stopped"
    );
  });

  test("a second run with nothing changed registers no new snapshot", async () => {
    const h = await harness();
    await h.service.runBackup(h.vaultId);
    const first = (await h.service.status())[h.vaultId];

    await h.service.runBackup(h.vaultId);
    const second = (await h.service.status())[h.vaultId];

    expect(second?.lastSeq).toBe(first?.lastSeq); // still seq 1 — no registration
    expect(second?.generation).toBe(1);
  });

  test("scheduled backups do not postpone the first restore-verification forever", async () => {
    const h = await harness();
    await h.service.runBackup(h.vaultId);
    const firstBackupAt = (await h.service.status())[h.vaultId]!.firstBackupAt;
    let restoreVerifies = 0;
    h.service.runRestoreVerify = () => {
      restoreVerifies++;
      return Promise.resolve();
    };

    h.clock.now += 8 * 24 * 60 * 60 * 1000;
    await h.service.tick(); // performs a fresh backup first, then checks restore due-ness

    expect(restoreVerifies).toBe(1);
    expect((await h.service.status())[h.vaultId]!.firstBackupAt).toBe(
      firstBackupAt
    );
  });

  test("a real change registers an incremental snapshot", async () => {
    const h = await harness();
    await h.service.runBackup(h.vaultId);
    expect((await h.service.status())[h.vaultId]?.lastSeq).toBe(1);

    await fs.writeFile(h.fixtureFile, "v1 — actually different content");
    await h.service.runBackup(h.vaultId);
    expect((await h.service.status())[h.vaultId]?.lastSeq).toBe(2);

    const rows = await h.service.listSnapshots(h.vaultId);
    expect(rows).toHaveLength(2);
  });

  test("conflict_generation fences the target: health error, no bump, no further auto-backup", async () => {
    const h = await harness({}, conflictAfterFirstCall);
    await h.service.runBackup(h.vaultId); // call #1 — succeeds, mints seq 1

    await fs.writeFile(h.fixtureFile, "v2 — after the rogue takeover");
    await h.service.runBackup(h.vaultId); // call #2 — the wrapped provider 409s

    const fenced = (await h.service.status())[h.vaultId];
    expect(fenced?.fenced).toBe(true);
    expect(fenced?.generation).toBe(1); // never bumped automatically (PROTOCOL.md fencing rule)
    expect(fenced?.lastError).toMatch(/another machine has taken over/u);

    const snap = await h.health.snapshot();
    expect(snap.components.find((c) => c.component === "backups")?.status).toBe(
      "error"
    );

    const before = fenced?.lastBackupAt;
    await h.service.runBackup(h.vaultId);
    expect((await h.service.status())[h.vaultId]?.lastBackupAt).toBe(before);
  });

  test("the staleness probe flips after the clock advances past 2x the interval/verify window", async () => {
    const h = await harness({ snapshotIntervalHours: 1, verifyEveryDays: 1 });
    await h.service.runBackup(h.vaultId);
    await h.service.runVerify(h.vaultId);

    let snap = await h.health.snapshot();
    expect(snap.components.find((c) => c.component === "backups")?.status).toBe(
      "ok"
    );

    h.clock.now += 3 * 24 * 60 * 60 * 1000;
    snap = await h.health.snapshot();
    const backups = snap.components.find((c) => c.component === "backups");
    expect(backups?.status).toBe("error");
    expect(backups?.detail).toMatch(/stale/u);
  });

  test("verify-only staleness (backup fresh, verify old) degrades without erroring", async () => {
    const h = await harness({ snapshotIntervalHours: 24, verifyEveryDays: 7 });
    await h.service.runBackup(h.vaultId);
    await h.service.runVerify(h.vaultId);

    h.clock.now += 20 * 24 * 60 * 60 * 1000;
    await h.service.runBackup(h.vaultId); // no fixture change — refreshes lastBackupAt only
    await h.service.runRestoreVerify(h.vaultId); // isolate ordinary verify staleness

    const snap = await h.health.snapshot();
    const backups = snap.components.find((c) => c.component === "backups");
    expect(backups?.status).toBe("degraded");
    expect(backups?.detail).toMatch(/verification is stale/u);
  });

  test("recoveryKitStatus starts unconfirmed", async () => {
    const h = await harness();
    await expect(h.service.recoveryKitStatus()).resolves.toStrictEqual({
      confirmedAt: null,
      kitFingerprint: expect.any(String),
    });
  });

  test("re-selecting and decrypting the exported kit stamps the current clock and persists it", async () => {
    const h = await harness();
    h.clock.now = Date.UTC(2026, 6, 11, 12, 0, 0);
    const result = await verifyExportedKit(h);
    expect(result).toStrictEqual({
      confirmedAt: Math.floor(h.clock.now / 1000),
      kitFingerprint: expect.any(String),
    });
    await expect(h.service.recoveryKitStatus()).resolves.toMatchObject({
      confirmedAt: Math.floor(h.clock.now / 1000),
      kitFingerprint: expect.any(String),
    });
  });

  test("the hourly scheduler skips its tick while host power-context posture defers (#528 Phase D)", async () => {
    vi.useFakeTimers();
    try {
      const vaultRoot = await tempDir("backup-svc-posture-vault");
      const backupDir = await tempDir("backup-svc-posture-state");
      const registry = openRegistry(vaultRoot);
      let defer = true;
      const service = new BackupService({
        cacheDir: backupDir,
        vaults: registry,
        health: new HealthRegistry(),
        logger: silentLogger,
        shouldDeferPosture: () => defer,
      });
      cleanups.push(() => service.stop());
      const tick = vi.spyOn(service, "tick").mockResolvedValue(undefined);

      service.start();
      await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
      expect(tick).not.toHaveBeenCalled();

      defer = false;
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(tick).toHaveBeenCalledWith();
    } finally {
      vi.useRealTimers();
    }
  });
});
