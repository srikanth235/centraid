import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Seal-key custody CLI: status + in-place rotation only. Recovery uses the
 * password-wrapped recovery-kit path and this surface never exports raw keys.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sealKeyFileFor } from '@centraid/vault';
import { commandVault } from './vault-admin.ts';
import { commandKey } from './key-admin.ts';
import { daemonLayoutFor } from './paths.ts';

// See admin.test.ts: real vault/daemon bootstrap per test, so this file is
// fsync-bound and needs an escalation above the 30s node-project default.
// Same 60s budget as its sibling CLI suites.
vi.setConfig({ testTimeout: 60_000 });

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

let dataDir: string;

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

describe('key-admin', () => {
  beforeEach(async () => {
    dataDir = await tempDir(`key-admin-${crypto.randomUUID()}-`);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function createVault(): Promise<{ vaultId: string; dir: string; keyFile: string }> {
    const out = await capture(() =>
      commandVault(['create', '--data-dir', dataDir, '--name', 'Test'], fail),
    );
    const { vaultId } = JSON.parse(out) as { vaultId: string };
    const dir = path.join(daemonLayoutFor(dataDir).vaultDir, vaultId);
    return { vaultId, dir, keyFile: sealKeyFileFor(dir) };
  }

  test('key status reports the key file, fingerprints and health', async () => {
    const v = await createVault();
    const out = await capture(() =>
      commandKey(['status', '--data-dir', dataDir, '--vault', v.vaultId], fail),
    );
    const status = JSON.parse(out) as Record<string, unknown>;
    expect(status['keyPresent']).toBe(true);
    expect(status['stampedFingerprint']).toBeNull(); // nothing sealed yet
    expect(status['healthy']).toBe(true);
    expect(status['keyFile']).toBe(v.keyFile);
  });

  test('raw export and restore subcommands do not exist', async () => {
    const v = await createVault();
    await expect(
      commandKey(['export', '--data-dir', dataDir, '--vault', v.vaultId], fail),
    ).rejects.toThrow(/status, rotate/);
    await expect(
      commandKey(['restore', '--data-dir', dataDir, '--vault', v.vaultId], fail),
    ).rejects.toThrow(/status, rotate/);
  });

  test('key rotate swaps the key file and reports fingerprints', async () => {
    const v = await createVault();
    const before = readFileSync(v.keyFile);
    const out = await capture(() =>
      commandKey(['rotate', '--data-dir', dataDir, '--vault', v.vaultId], fail),
    );
    const result = JSON.parse(out) as { oldFingerprint: string; newFingerprint: string };
    expect(result.newFingerprint).not.toBe(result.oldFingerprint);
    expect(readFileSync(v.keyFile).equals(before)).toBe(false);
    expect(existsSync(`${v.keyFile}.next`)).toBe(false); // sidecar promoted
  });

  test('key resolves the vault by display name too, and fails on unknowns', async () => {
    const v = await createVault();
    const out = await capture(() =>
      commandKey(['status', '--data-dir', dataDir, '--vault', 'Test'], fail),
    );
    expect((JSON.parse(out) as { vaultId: string }).vaultId).toBe(v.vaultId);
    await expect(
      capture(() => commandKey(['status', '--data-dir', dataDir, '--vault', 'nope'], fail)),
    ).rejects.toThrow(/no vault matches/);
  });
});
