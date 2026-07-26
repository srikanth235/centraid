import { tempDir } from '@centraid/test-kit/temp-dir';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { desktopGatewayKeyStore, getOrCreateGatewayWrappingKey } from './gateway-secrets.js';

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
