// `BackupService` (PROTOCOL.md/FORMAT.md wiring): a real `VaultRegistry` +
// `LocalBackupProvider` over temp dirs, with an INJECTED `assembleEntries`
// seam standing in for the real `stageVaultDbs`/blob-walk/git-bundle
// assembly. The real assembly VACUUM-INTOs a fresh `vault.db`/`journal.db`
// on every run (and `stageVaultDbs` itself receipts into the journal —
// FORMAT.md's ordering rule notwithstanding), so a real vault's staged
// files never hash byte-identical twice in a row; the "no visible change
// registers nothing" and "a real change is incremental" contracts belong
// to the engine (`packages/backup`, 107 tests) and are exercised here
// against a fixture file this test controls directly instead.

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  BackupProviderError,
  openLocalBackupProvider,
  type BackupProvider,
} from '@centraid/backup';
import { openVaultRegistry, type VaultRegistry } from '../serve/vault-registry.js';
import { HealthRegistry } from '../serve/health-registry.js';
import { BackupService } from './backup-service.js';
import type { BackupConfig } from './backup-config.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function openRegistry(rootDir: string): VaultRegistry {
  const registry = openVaultRegistry({ rootDir, logger: silentLogger, ownerName: 'Priya' });
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

/**
 * Wraps a real provider so its `registerSnapshot` throws `conflict_generation`
 * from the SECOND call onward — standing in for "another machine already
 * took over this target at the provider" without depending on
 * `LocalBackupProvider`'s per-instance registry cache (which never observes
 * a second same-process instance's disk writes; that staleness is a real
 * property of the local provider across OS processes, not something this
 * unit test should have to fight to exercise our own fencing logic).
 */
function conflictAfterFirstCall(real: BackupProvider): BackupProvider {
  let calls = 0;
  return {
    capabilities: (...a) => real.capabilities(...a),
    createTarget: (...a) => real.createTarget(...a),
    deleteTarget: (...a) => real.deleteTarget(...a),
    undeleteTarget: (...a) => real.undeleteTarget(...a),
    purgeTarget: (...a) => real.purgeTarget(...a),
    openDataPlane: (...a) => real.openDataPlane(...a),
    registerSnapshot: (...a) => {
      calls += 1;
      if (calls === 1) return real.registerSnapshot(...a);
      return Promise.reject(
        BackupProviderError.of('conflict_generation', 'another machine has taken over this vault', {
          currentGeneration: 5,
        }),
      );
    },
    listSnapshots: (...a) => real.listSnapshots(...a),
    getSnapshot: (...a) => real.getSnapshot(...a),
    getTarget: (...a) => real.getTarget(...a),
    usage: (...a) => real.usage(...a),
  };
}

/** One vault, a fixture file standing in for the staged DB, and a mutable clock. */
async function harness(
  overrides: Partial<BackupConfig> = {},
  wrapProvider?: (real: BackupProvider) => BackupProvider,
): Promise<Harness> {
  const vaultRoot = await tempDir('backup-svc-vault');
  const providerDir = await tempDir('backup-svc-provider');
  const backupDir = await tempDir('backup-svc-state');
  const registry = openRegistry(vaultRoot);
  const health = new HealthRegistry();
  const vaultId = registry.defaultVaultId();

  const fixtureDir = await tempDir('backup-svc-fixture');
  const fixtureFile = path.join(fixtureDir, 'vault.db');
  await fs.writeFile(fixtureFile, 'v0');

  const clock = { now: Date.now() };
  const config: BackupConfig = {
    enabled: true,
    intervalHours: 1,
    verifyEveryDays: 1,
    provider: { kind: 'local', dir: providerDir },
    ...overrides,
  };
  const realProvider = openLocalBackupProvider({ rootDir: providerDir });
  const service = new BackupService({
    config,
    backupDir,
    vaults: registry,
    health,
    logger: silentLogger,
    now: () => clock.now,
    provider: wrapProvider ? wrapProvider(realProvider) : realProvider,
    // The seam FORMAT.md's engine needs a `SourceEntry[]` for — a single
    // "db" entry over the fixture file the test mutates directly.
    assembleEntries: () =>
      Promise.resolve([{ path: 'vault.db', kind: 'db', absolutePath: fixtureFile }]),
  });

  return { service, registry, health, vaultId, fixtureFile, clock, providerDir, backupDir };
}

test('first run creates a target, mints a keyring, and registers a snapshot', async () => {
  const h = await harness();
  await h.service.runBackup(h.vaultId);

  const status = (await h.service.status())[h.vaultId];
  expect(status?.targetId).toBeTruthy();
  expect(status?.generation).toBe(1);
  expect(status?.lastSeq).toBe(1);
  expect(status?.lastBackupAt).toBeTruthy();
  expect(status?.lastError).toBeUndefined();

  await expect(fs.access(path.join(h.backupDir, 'keyring.json'))).resolves.toBeUndefined();

  const snap = await h.health.snapshot();
  const backups = snap.components.find((c) => c.component === 'backups');
  expect(backups?.status).toBe('ok');
});

test('a second run with nothing changed registers no new snapshot', async () => {
  const h = await harness();
  await h.service.runBackup(h.vaultId);
  const first = (await h.service.status())[h.vaultId];

  await h.service.runBackup(h.vaultId);
  const second = (await h.service.status())[h.vaultId];

  expect(second?.lastSeq).toBe(first?.lastSeq); // still seq 1 — no registration
  expect(second?.generation).toBe(1);
});

test('a real change registers an incremental snapshot', async () => {
  const h = await harness();
  await h.service.runBackup(h.vaultId);
  expect((await h.service.status())[h.vaultId]?.lastSeq).toBe(1);

  await fs.writeFile(h.fixtureFile, 'v1 — actually different content');
  await h.service.runBackup(h.vaultId);
  expect((await h.service.status())[h.vaultId]?.lastSeq).toBe(2);

  const rows = await h.service.listSnapshots(h.vaultId);
  expect(rows).toHaveLength(2);
});

test('conflict_generation fences the target: health error, no bump, no further auto-backup', async () => {
  const h = await harness({}, conflictAfterFirstCall);
  await h.service.runBackup(h.vaultId); // call #1 — succeeds, mints seq 1

  await fs.writeFile(h.fixtureFile, 'v2 — after the rogue takeover');
  await h.service.runBackup(h.vaultId); // call #2 — the wrapped provider 409s

  const fenced = (await h.service.status())[h.vaultId];
  expect(fenced?.fenced).toBe(true);
  expect(fenced?.generation).toBe(1); // never bumped automatically (PROTOCOL.md fencing rule)
  expect(fenced?.lastError).toMatch(/another machine has taken over/);

  const snap = await h.health.snapshot();
  expect(snap.components.find((c) => c.component === 'backups')?.status).toBe('error');

  // A subsequent scheduler-driven attempt refuses outright — no retry loop.
  const before = fenced?.lastBackupAt;
  await h.service.runBackup(h.vaultId);
  expect((await h.service.status())[h.vaultId]?.lastBackupAt).toBe(before);
});

test('the staleness probe flips after the clock advances past 2x the interval/verify window', async () => {
  const h = await harness({ intervalHours: 1, verifyEveryDays: 1 });
  await h.service.runBackup(h.vaultId);
  await h.service.runVerify(h.vaultId);

  let snap = await h.health.snapshot();
  expect(snap.components.find((c) => c.component === 'backups')?.status).toBe('ok');

  // Past 2x verifyEveryDays (1 day) but under 2x intervalHours (1 hour) is
  // impossible to isolate with these units, so move the clock far enough
  // that BOTH would trip and assert the worse of the two (error) wins.
  h.clock.now += 3 * 24 * 60 * 60 * 1000;
  snap = await h.health.snapshot();
  const backups = snap.components.find((c) => c.component === 'backups');
  expect(backups?.status).toBe('error');
  expect(backups?.detail).toMatch(/stale/);
});

test('verify-only staleness (backup fresh, verify old) degrades without erroring', async () => {
  const h = await harness({ intervalHours: 24, verifyEveryDays: 7 });
  await h.service.runBackup(h.vaultId);
  await h.service.runVerify(h.vaultId);

  // Advance past 2x verifyEveryDays (14 days) but stay under 2x
  // intervalHours (48 hours would trip first) — so bump the clock, then
  // immediately refresh lastBackupAt so only verification looks stale.
  h.clock.now += 20 * 24 * 60 * 60 * 1000;
  await h.service.runBackup(h.vaultId); // no fixture change — refreshes lastBackupAt only

  const snap = await h.health.snapshot();
  const backups = snap.components.find((c) => c.component === 'backups');
  expect(backups?.status).toBe('degraded');
  expect(backups?.detail).toMatch(/verification is stale/);
});
