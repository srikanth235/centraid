import { tempDir } from '@centraid/test-kit/temp-dir';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import {
  clearGatewayCredentials,
  desktopGatewayKeyStore,
  deviceIrohKeyPersistence,
  getOrCreateGatewayWrappingKey,
  readLocalLoopbackToken,
  storeLocalLoopbackToken,
} from './gateway-secrets.js';

const mocked = vi.hoisted(() => ({
  encryptionAvailable: false,
  secretsFile: '',
}));

vi.mock('electron', () => ({
  safeStorage: {
    decryptString: (value: Buffer) => value.toString('utf8'),
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    isEncryptionAvailable: () => mocked.encryptionAvailable,
  },
}));

vi.mock('./gateway-paths.js', () => ({
  connectionSecretsFile: () => mocked.secretsFile,
}));

afterEach(() => {
  vi.restoreAllMocks();
  mocked.encryptionAvailable = false;
});

test('Linux without libsecret warns and falls back to a 0600 device-local file', async () => {
  const root = await tempDir('gateway-secrets-linux-');
  mocked.secretsFile = path.join(root, 'connection-secrets.bin');
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  const key = getOrCreateGatewayWrappingKey('local');

  expect(key).toHaveLength(32);
  expect(readFileSync(mocked.secretsFile, 'utf8')).toMatch(/^CENTRAID-DEVICE-SECRETS-V1\n/);
  expect(statSync(mocked.secretsFile).mode & 0o777).toBe(0o600);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/libsecret.*0600/i));
  expect(getOrCreateGatewayWrappingKey('local')).toEqual(key);
});

test('embedded gateway envelopes require the originating desktop custody key', async () => {
  mocked.encryptionAvailable = true;
  const sourceDeviceDir = await tempDir('gateway-secrets-source-');
  const copiedDeviceDir = await tempDir('gateway-secrets-copy-');
  const dataDir = await tempDir('gateway-secrets-data-');

  mocked.secretsFile = path.join(sourceDeviceDir, 'connection-secrets.bin');
  desktopGatewayKeyStore(dataDir, 'local').store('vault.sealkey', Buffer.alloc(32, 7));

  mocked.secretsFile = path.join(copiedDeviceDir, 'connection-secrets.bin');
  expect(() => desktopGatewayKeyStore(dataDir, 'local').load('vault.sealkey')).toThrow(
    /authentication failed/i,
  );
});

test('one encrypted device store owns iroh keys, loopback tokens, and fallback adoption', async () => {
  const root = await tempDir('gateway-secrets-all-credentials-');
  mocked.secretsFile = path.join(root, 'connection-secrets.bin');
  mocked.encryptionAvailable = true;
  const persistence = deviceIrohKeyPersistence('remote');

  expect(persistence.load()).toBeNull();
  persistence.store(Uint8Array.from([1, 2, 3, 4]));
  expect(persistence.load()).toEqual(Uint8Array.from([1, 2, 3, 4]));
  expect(readLocalLoopbackToken('local')).toBeUndefined();
  storeLocalLoopbackToken('local', 'ephemeral-loopback-token');
  expect(readLocalLoopbackToken('local')).toBe('ephemeral-loopback-token');
  clearGatewayCredentials('remote');
  expect(persistence.load()).toBeNull();
  clearGatewayCredentials('remote');

  mocked.secretsFile = path.join(root, 'fallback-secrets.bin');
  mocked.encryptionAvailable = false;
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  const fallbackKey = getOrCreateGatewayWrappingKey('fallback');
  expect(readFileSync(mocked.secretsFile, 'utf8')).toMatch(/^CENTRAID-DEVICE-SECRETS-V1\n/);
  mocked.encryptionAvailable = true;
  expect(getOrCreateGatewayWrappingKey('fallback')).toEqual(fallbackKey);
  expect(readFileSync(mocked.secretsFile, 'utf8')).not.toMatch(/^CENTRAID-DEVICE-SECRETS-V1\n/);
});

test('device credential parsing rejects unavailable custody and unsupported stores', async () => {
  const root = await tempDir('gateway-secrets-errors-');
  mocked.secretsFile = path.join(root, 'connection-secrets.bin');
  writeFileSync(mocked.secretsFile, JSON.stringify({ version: 2 }), { mode: 0o600 });
  mocked.encryptionAvailable = true;
  expect(() => readLocalLoopbackToken('local')).toThrow(/unsupported format/);

  writeFileSync(mocked.secretsFile, 'encrypted-device-secrets', { mode: 0o600 });
  mocked.encryptionAvailable = false;
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  expect(() => readLocalLoopbackToken('local')).toThrow(/encrypted.*libsecret is unavailable/);

  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  expect(() => storeLocalLoopbackToken('local', 'token')).toThrow(/keychain is unavailable/);
});
