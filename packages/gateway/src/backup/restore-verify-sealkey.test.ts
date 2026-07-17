/*
 * Seal-key restore-verify (issue #439 R5) — the scheduled `runRestoreVerify`
 * now proves what FORMAT.md warns about: a restore whose sealed columns cannot
 * be opened is "a placebo". A real backup of a vault with a sealed secret is
 * restored into a scratch dir, and the standing verification asserts the
 * `seal.key` entry is present AND matches the vault's stamped fingerprint — the
 * same proof the vault's own open path enforces (`resolveSealKey`).
 *
 *   - a genuinely sealed vault verifies clean (the key unseals), and
 *   - a vault whose stamped fingerprint no longer matches the restored key FAILS
 *     verify with the placebo problem (a real regression the check now catches).
 */

import { afterEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startFakeProviderServer } from '@centraid/backup/dist/testing/fake-provider-server.js';
import { openVaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
import { HealthRegistry } from '../serve/health-registry.js';
import { BackupService } from './backup-service.js';

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

function invoke(plane: VaultPlane, command: string, input: Record<string, unknown>): void {
  const out = plane.gateway.invoke(plane.ownerCredential, { command, input });
  if (out.status !== 'executed') throw new Error(`${command} failed: ${JSON.stringify(out)}`);
}

interface Machine {
  service: BackupService;
  plane: VaultPlane;
  vaultId: string;
}

/** A real vault with a SEALED secret (mints seal.key + stamps a fingerprint),
 *  wired to a real BackupService over the fake HTTP provider. */
async function makeSealedMachine(
  server: Awaited<ReturnType<typeof startFakeProviderServer>>,
): Promise<Machine> {
  const vaultRoot = await tempDir('rv-sealkey-vault');
  const backupDir = await tempDir('rv-sealkey-backup');
  const registry = openVaultRegistry({
    rootDir: vaultRoot,
    logger: silentLogger,
    ownerName: 'Mara',
  });
  cleanups.push(() => registry.stop());
  const vaultId = registry.defaultVaultId();
  const plane = registry.get(vaultId)!;
  const service = new BackupService({
    config: {
      enabled: true,
      provider: { kind: 'remote', endpoint: server.url, apiKey: server.apiKey },
    },
    backupDir,
    vaults: registry,
    health: new HealthRegistry(),
    logger: silentLogger,
  });
  cleanups.push(() => service.stop());
  // Sealing the api_key mints the seal key and stamps the vault's fingerprint.
  invoke(plane, 'sync.configure_credential', {
    kind: 'pull.gmail',
    label: 'personal',
    cred_kind: 'api_key',
    api_key: 'sk-restore-verify',
    allowed_hosts: ['gmail.googleapis.com'],
  });
  return { service, plane, vaultId };
}

test('restore-verify passes when the restored seal key unseals the vault', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const m = await makeSealedMachine(server);
  await m.service.runBackup(m.vaultId);
  // The scratch restore carries seal.key and it matches the stamped fingerprint.
  await expect(m.service.runRestoreVerify(m.vaultId)).resolves.toBeUndefined();
});

test('restore-verify FAILS with the placebo problem when the seal key does not match', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const m = await makeSealedMachine(server);

  // Corrupt the stamped fingerprint so the (real) restored key will not match it
  // — the shape of a snapshot whose sealed columns can never be opened.
  const row = m.plane.db.vault.prepare('SELECT settings_json FROM core_vault LIMIT 1').get() as {
    settings_json: string;
  };
  const settings = JSON.parse(row.settings_json) as Record<string, unknown>;
  settings['seal_key'] = {
    fingerprint: `sha256:${'f'.repeat(32)}`,
    stamped_at: new Date().toISOString(),
  };
  m.plane.db.vault.prepare('UPDATE core_vault SET settings_json = ?').run(JSON.stringify(settings));

  await m.service.runBackup(m.vaultId);
  await expect(m.service.runRestoreVerify(m.vaultId)).rejects.toThrow(/placebo/);
}, 45_000);
