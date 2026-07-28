import { promises as fs } from 'node:fs';
import path from 'node:path';

import { tempDir } from '@centraid/test-kit/temp-dir';
import { aesGcmKeyProtector, KeyStore } from '@centraid/vault';
import { afterEach, describe, expect, test } from 'vitest';

import { hostCredentialKey } from './key-store.js';
import { adoptKeyStoreCredential, type ServiceKeyCredential } from './service-credential.js';

const roots: string[] = [];

describe('service-credential', () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  const failing = (): ((message: string, code?: number) => never) => {
    return (message: string) => {
      throw new Error(message);
    };
  };

  const credentialFor = (keysDir: string, encoded: string): ServiceKeyCredential => ({
    kind: 'keychain',
    service: 'dev.centraid.test',
    account: 'test-account',
    encoded,
    keysDir,
  });

  test('adoption reads every key already wrapped under the host credential', async () => {
    const root = await tempDir('adopt-host-credential-');
    const credentialRoot = await tempDir('adopt-host-credential-store-');
    roots.push(root, credentialRoot);
    const keysDir = path.join(root, 'keys');
    const env = { CENTRAID_KEYSTORE_CREDENTIAL_ROOT: credentialRoot };

    // A headless `serve` has already wrapped these under the 0600 host
    // credential; `service install` hands the daemon that same credential.
    const encoded = hostCredentialKey(keysDir, env);
    const store = new KeyStore(keysDir, {
      protector: aesGcmKeyProtector(Buffer.from(encoded, 'base64')),
    });
    const secrets = ['endpoint-key.bin', 'vault-a.sealkey', 'keyring.key'].map(
      (name) => [name, store.create(name)] as const,
    );

    await expect(
      adoptKeyStoreCredential(failing(), credentialFor(keysDir, encoded)),
    ).resolves.toBeUndefined();
    for (const [name, secret] of secrets) expect(store.load(name)).toStrictEqual(secret);
  });

  test('a credential that cannot decrypt the existing keys aborts before anything is committed', async () => {
    const root = await tempDir('adopt-wrong-credential-');
    roots.push(root);
    const keysDir = path.join(root, 'keys');
    const store = new KeyStore(keysDir, {
      protector: aesGcmKeyProtector(Buffer.alloc(32, 0x11)),
    });
    store.create('endpoint-key.bin');
    const before = await fs.readFile(path.join(keysDir, 'endpoint-key.bin'), 'utf8');

    // This is the failure that must happen BEFORE `security add-generic-password
    // -U` overwrites custody in place — a poisoned credential makes every key in
    // the data dir undecryptable on every subsequent darwin boot.
    await expect(
      adoptKeyStoreCredential(
        failing(),
        credentialFor(keysDir, Buffer.alloc(32, 0x22).toString('base64')),
      ),
    ).rejects.toThrow(/authentication|decrypt|unsupported state/iu);
    await expect(fs.readFile(path.join(keysDir, 'endpoint-key.bin'), 'utf8')).resolves.toBe(before);
  });

  test('a malformed wrapping key is rejected as a bad install argument', async () => {
    const root = await tempDir('adopt-malformed-credential-');
    roots.push(root);
    const keysDir = path.join(root, 'keys');

    await expect(
      adoptKeyStoreCredential(
        failing(),
        credentialFor(keysDir, Buffer.alloc(4).toString('base64')),
      ),
    ).rejects.toThrow(/one base64-encoded 32-byte key/u);
  });

  test('adoption rewraps an unprotected envelope and skips partial temp files', async () => {
    const root = await tempDir('adopt-rewrap-');
    roots.push(root);
    const keysDir = path.join(root, 'keys');
    const bare = new KeyStore(keysDir);
    const secret = bare.create('endpoint-key.bin');
    await fs.writeFile(path.join(keysDir, 'endpoint-key.bin.tmp1234'), 'partial write');
    await fs.mkdir(path.join(keysDir, 'nested'), { recursive: true });

    const encoded = Buffer.alloc(32, 0x33).toString('base64');
    await adoptKeyStoreCredential(failing(), credentialFor(keysDir, encoded));

    // The install may now commit the credential: the key reads under it.
    const raw = await fs.readFile(path.join(keysDir, 'endpoint-key.bin'), 'utf8');
    expect(raw).toContain('"scheme":"aes-256-gcm-v1"');
    expect(
      new KeyStore(keysDir, {
        protector: aesGcmKeyProtector(Buffer.from(encoded, 'base64')),
      }).load('endpoint-key.bin'),
    ).toStrictEqual(secret);
    // A crashed writer's leftovers are not keys and must not fail the install.
    await expect(fs.readFile(path.join(keysDir, 'endpoint-key.bin.tmp1234'), 'utf8')).resolves.toBe(
      'partial write',
    );
  });

  test('an empty or absent keys directory adopts cleanly', async () => {
    const root = await tempDir('adopt-empty-');
    roots.push(root);
    const encoded = Buffer.alloc(32, 0x44).toString('base64');

    await expect(
      adoptKeyStoreCredential(failing(), credentialFor(path.join(root, 'absent'), encoded)),
    ).resolves.toBeUndefined();

    const keysDir = path.join(root, 'keys');
    await fs.mkdir(keysDir, { recursive: true });
    await expect(
      adoptKeyStoreCredential(failing(), credentialFor(keysDir, encoded)),
    ).resolves.toBeUndefined();
  });
});
