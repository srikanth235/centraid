import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Seal-key custody CLI (issue #298 items 1+2+8): `centraid-gateway key
 * status|export|restore|rotate`. The DECIDED recovery story — the key
 * travels only through these explicit, receipted gestures; a vault
 * directory copy alone carries ciphertext only. Registry-free by design:
 * restore must work on exactly the vault the registry refuses to open.
 */

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { promises as fs, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
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

function lastReceipt(dir: string): {
  action: string;
  decision: string;
  detail: Record<string, unknown>;
} {
  const journal = new DatabaseSync(path.join(dir, 'journal.db'), { readOnly: true });
  try {
    const row = journal
      .prepare(
        'SELECT action, decision, detail_json FROM consent_receipt ORDER BY receipt_id DESC LIMIT 1',
      )
      .get() as { action: string; decision: string; detail_json: string };
    return { action: row.action, decision: row.decision, detail: JSON.parse(row.detail_json) };
  } finally {
    journal.close();
  }
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

test('key export writes a fingerprinted envelope and receipts the gesture', async () => {
  const v = await createVault();
  const outFile = path.join(dataDir, 'vault-key.json');
  const out = await capture(() =>
    commandKey(['export', '--data-dir', dataDir, '--vault', v.vaultId, '--out', outFile], fail),
  );
  const result = JSON.parse(out) as { exported: string; fingerprint: string };
  expect(result.exported).toBe(outFile);
  const envelope = JSON.parse(readFileSync(outFile, 'utf8')) as Record<string, unknown>;
  expect(envelope['kind']).toBe('centraid-seal-key');
  expect(envelope['vaultId']).toBe(v.vaultId);
  expect(Buffer.from(String(envelope['key']), 'base64').equals(readFileSync(v.keyFile))).toBe(true);
  const receipt = lastReceipt(v.dir);
  expect(receipt.action).toBe('key.export');
  expect(receipt.decision).toBe('allow');
  expect(receipt.detail['fingerprint']).toBe(result.fingerprint);
});

test('key restore puts an exported key back and receipts it', async () => {
  const v = await createVault();
  const outFile = path.join(dataDir, 'vault-key.json');
  await capture(() =>
    commandKey(['export', '--data-dir', dataDir, '--vault', v.vaultId, '--out', outFile], fail),
  );
  const original = readFileSync(v.keyFile);
  rmSync(v.keyFile); // the disaster: directory intact, key gone
  await capture(() =>
    commandKey(['restore', '--data-dir', dataDir, '--vault', v.vaultId, '--from', outFile], fail),
  );
  expect(readFileSync(v.keyFile).equals(original)).toBe(true);
  expect(lastReceipt(v.dir).action).toBe('key.restore');
});

test('key restore refuses to overwrite a DIFFERENT key already in place', async () => {
  const v = await createVault();
  const outFile = path.join(dataDir, 'vault-key.json');
  await capture(() =>
    commandKey(['export', '--data-dir', dataDir, '--vault', v.vaultId, '--out', outFile], fail),
  );
  rmSync(v.keyFile);
  // A fresh open would mint a new key here; simulate that foreign key.
  await fs.mkdir(path.dirname(v.keyFile), { recursive: true });
  await fs.writeFile(v.keyFile, crypto.randomBytes(32), { mode: 0o600 });
  await expect(
    capture(() =>
      commandKey(['restore', '--data-dir', dataDir, '--vault', v.vaultId, '--from', outFile], fail),
    ),
  ).rejects.toThrow(/refusing to overwrite/);
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
