/*
 * `centraid-gateway recover` (issue #439 R6) — the CLI shell over `recover()`.
 * Exercised against the real in-process fake provider server (real HTTP, real
 * grant + snapshot flow), which advertises `metered-egress`, so the `--yes`
 * gate is real. Machine A backs up a vault against it and exports a kit FILE;
 * the CLI then recovers it into a blank data dir with nothing but that file and
 * the api-key.
 */

import { afterEach, expect, test } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startFakeProviderServer } from '@centraid/backup/dist/testing/fake-provider-server.js';
import { openVaultRegistry } from '../serve/vault-registry.js';
import { HealthRegistry } from '../serve/health-registry.js';
import { BackupService } from '../backup/backup-service.js';
import { daemonLayoutFor } from './paths.js';
import { commandRecover } from './recover-admin.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

class CliFailError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'CliFailError';
  }
}
const fail = (message: string, code = 1): never => {
  throw new CliFailError(message, code);
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Capture stdout + stderr around one call. */
async function capture(fn: () => Promise<void> | void): Promise<{ out: string; err: string }> {
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const out: string[] = [];
  const err: string[] = [];
  process.stdout.write = ((chunk: unknown): boolean => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown): boolean => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { out: out.join(''), err: err.join('') };
}

/** Machine A: a real vault backed up against the fake HTTP provider, with its
 *  recovery kit exported to `kitFile`. Returns the kit file + api-key + vaultId. */
async function seedAndExportKit(
  server: Awaited<ReturnType<typeof startFakeProviderServer>>,
): Promise<{ kitFile: string; apiKey: string; vaultId: string }> {
  const vaultRoot = await tempDir('recover-cli-a');
  const backupDir = await tempDir('recover-cli-a-backup');
  const registry = openVaultRegistry({
    rootDir: vaultRoot,
    logger: silentLogger,
    ownerName: 'Mara',
  });
  cleanups.push(() => registry.stop());
  const vaultId = registry.defaultVaultId();
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
  await service.runBackup(vaultId);
  const kitFile = path.join(await tempDir('recover-cli-kit'), 'kit.json');
  await service.writeKit(kitFile);
  return { kitFile, apiKey: server.apiKey, vaultId };
}

test('recover prints the found-your-vault facts, then a metered home gates without --yes and proceeds with it', async () => {
  const server = await startFakeProviderServer();
  cleanups.push(() => server.close());
  const { kitFile, apiKey, vaultId } = await seedAndExportKit(server);
  const dataDir = await tempDir('recover-cli-blank');

  // Without --yes: the fake home is metered-egress, so the gate refuses after
  // printing the facts, and nothing is written.
  const refused = await capture(() =>
    expect(
      commandRecover(['--kit', kitFile, '--api-key', apiKey, '--data-dir', dataDir], fail),
    ).rejects.toThrow(/metered-egress/),
  );
  expect(refused.err).toMatch(/found your vault/);
  expect(existsSync(path.join(daemonLayoutFor(dataDir).vaultDir, vaultId))).toBe(false);

  // With --yes: the recovery runs to completion; the JSON report lands on
  // stdout and the phase progress + fence reminder on stderr.
  const done = await capture(() =>
    commandRecover(['--kit', kitFile, '--api-key', apiKey, '--data-dir', dataDir, '--yes'], fail),
  );
  const report = JSON.parse(done.out.trim()) as {
    vaultId: string;
    seq: number;
    generation: number;
    previews: { warmed: boolean };
  };
  expect(report.vaultId).toBe(vaultId);
  expect(report.seq).toBe(1);
  expect(report.generation).toBe(2); // old generation 1 + 1 (fenced)
  expect(report.previews.warmed).toBe(false); // headless CLI ⇒ previews on demand
  expect(done.err).toMatch(/fetching your vault/);
  expect(done.err).toMatch(/Generation fenced at 2/);
  expect(existsSync(path.join(daemonLayoutFor(dataDir).vaultDir, vaultId, 'vault.db'))).toBe(true);
}, 45_000);

test('recover refuses missing required flags', async () => {
  await expect(capture(() => commandRecover(['--data-dir', '/tmp/x'], fail))).rejects.toThrow(
    /usage: recover/,
  );
});
