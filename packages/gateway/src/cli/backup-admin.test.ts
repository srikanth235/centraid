/*
 * `centraid-gateway backup …` (PROTOCOL.md/FORMAT.md CLI surface): status,
 * run, list, verify, restore, kit — constructed from the same `--config`
 * resolution `serve` uses. Exercises the real `LocalBackupProvider` and a
 * real vault dir (the registry auto-bootstraps a default vault on first
 * open, same as `serve` would), so this is closer to an integration test
 * than the unit-level `backup-service.test.ts`.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SNAPSHOT_FORMAT } from '@centraid/backup';
import { openVaultRegistry } from '../serve/vault-registry.js';
import { commandBackup } from './backup-admin.js';
import { daemonLayoutFor } from './paths.js';

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

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let dataDir: string;
let providerDir: string;
let configPath: string;
let vaultId: string;

async function capture(fn: () => Promise<void> | void): Promise<string> {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

function lines(out: string): unknown[] {
  return out
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as unknown);
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `backup-admin-${crypto.randomUUID()}-`));
  providerDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `backup-admin-provider-${crypto.randomUUID()}-`),
  );
  configPath = path.join(dataDir, 'config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      dataDir,
      backup: {
        enabled: true,
        provider: { kind: 'local', dir: providerDir },
      },
    }),
  );
  // Discover the auto-bootstrapped default vault the same way `serve`
  // would (opening the registry mints one on a fresh root), then close it
  // so `commandBackup` (which opens its own) doesn't collide.
  const registry = openVaultRegistry({
    rootDir: daemonLayoutFor(dataDir).vaultDir,
    logger: silentLogger,
  });
  vaultId = registry.defaultVaultId();
  registry.stop();
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.rm(providerDir, { recursive: true, force: true });
});

test('run backs up every vault, status reports it, list shows the registry row', async () => {
  const runOut = await capture(() => commandBackup(['run', '--config', configPath], fail));
  const [ran] = lines(runOut) as [Record<string, unknown>];
  expect(ran['vaultId']).toBe(vaultId);
  expect(ran['lastSeq']).toBe(1);

  const statusOut = await capture(() => commandBackup(['status', '--config', configPath], fail));
  const [status] = lines(statusOut) as [Record<string, unknown>];
  expect(status['vaultId']).toBe(vaultId);
  expect(status['generation']).toBe(1);

  const listOut = await capture(() => commandBackup(['list', '--config', configPath], fail));
  const [row] = lines(listOut) as [Record<string, unknown>];
  expect(row['vaultId']).toBe(vaultId);
  expect(row['seq']).toBe(1);
  expect(row['format']).toBe(SNAPSHOT_FORMAT);
});

test('verify reports a clean snapshot', async () => {
  await capture(() => commandBackup(['run', '--config', configPath], fail));
  const out = await capture(() =>
    commandBackup(['verify', '--config', configPath, '--vault', vaultId], fail),
  );
  const [{ result }] = lines(out) as [{ result: { missing: string[]; corrupt: string[] } }];
  expect(result.missing).toHaveLength(0);
  expect(result.corrupt).toHaveLength(0);
});

test('restore materializes into a fresh --dest with a quarantine marker, never touching the live vault', async () => {
  await capture(() => commandBackup(['run', '--config', configPath], fail));
  const destDir = path.join(dataDir, 'restored');
  const out = await capture(() =>
    commandBackup(['restore', '--config', configPath, '--vault', vaultId, '--dest', destDir], fail),
  );
  const [result] = lines(out) as [{ seq: number; entries: string[] }];
  expect(result.seq).toBe(1);
  expect(result.entries).toContain('vault.db');
  expect(existsSync(path.join(destDir, 'vault.db'))).toBe(true);
  expect(existsSync(path.join(destDir, 'RESTORE_QUARANTINE.json'))).toBe(true);
  // The live vault dir is untouched — restore only ever writes to --dest.
  const liveVaultDb = path.join(daemonLayoutFor(dataDir).vaultDir, vaultId, 'vault.db');
  expect(existsSync(liveVaultDb)).toBe(true);
});

test('kit emits the recovery keyring with a store-offline warning on stderr', async () => {
  await capture(() => commandBackup(['run', '--config', configPath], fail));
  const kitFile = path.join(dataDir, 'kit.json');
  const originalErr = process.stderr.write.bind(process.stderr);
  const errChunks: string[] = [];
  process.stderr.write = ((chunk: unknown): boolean => {
    errChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await commandBackup(['kit', '--config', configPath, '--out', kitFile], fail);
  } finally {
    process.stderr.write = originalErr;
  }
  expect(existsSync(kitFile)).toBe(true);
  const kit = JSON.parse(await fs.readFile(kitFile, 'utf8')) as {
    kind: string;
    keyring: { epochs: unknown[] };
    targets: { vaultId: string }[];
  };
  expect(kit.kind).toBe('centraid-recovery-kit');
  expect(kit.keyring.epochs.length).toBeGreaterThan(0);
  expect(kit.targets.some((t) => t.vaultId === vaultId)).toBe(true);
  expect(errChunks.join('')).toMatch(/store it offline/);
});

test('backup CLI refuses when the config has no "backup" block', async () => {
  const bareConfig = path.join(dataDir, 'bare.json');
  await fs.writeFile(bareConfig, JSON.stringify({ dataDir }));
  await expect(
    capture(() => commandBackup(['status', '--config', bareConfig], fail)),
  ).rejects.toThrow(/not configured/);
});
