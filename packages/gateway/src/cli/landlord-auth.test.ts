import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, describe, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { aesGcmKeyProtector, KeyStore } from '@centraid/vault';
import { landlordBearerForDataDir, landlordBearerForEndpointSecret } from './landlord-auth.js';
import { daemonKeyStore } from './key-store.js';
import { daemonLayoutFor } from './paths.js';

const roots: string[] = [];

describe('landlord-auth', () => {
  afterEach(async () => {
    while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
  });

  test('the derived bearer is stable for an endpoint secret and unique to it', () => {
    const secret = Buffer.alloc(32, 0x7a);
    const bearer = landlordBearerForEndpointSecret(secret);

    expect(bearer).toBe(landlordBearerForEndpointSecret(Buffer.alloc(32, 0x7a)));
    expect(bearer).toMatch(/^[0-9a-f]{64}$/);
    // A different identity must not derive the same loopback admin bearer.
    expect(landlordBearerForEndpointSecret(Buffer.alloc(32, 0x7b))).not.toBe(bearer);
    // The bearer must not simply be the key material in another encoding.
    expect(bearer).not.toBe(secret.toString('hex'));
  });

  test('a data dir derives the bearer of the endpoint key already under its custody', async () => {
    const dataDir = await tempDir('landlord-derive-');
    const credentialRoot = await tempDir('landlord-derive-credentials-');
    roots.push(dataDir, credentialRoot);
    const env = { CENTRAID_KEYSTORE_CREDENTIAL_ROOT: credentialRoot };
    const keysDir = daemonLayoutFor(dataDir).keysDir;
    const secret = daemonKeyStore(keysDir, { env }).create('endpoint-key.bin');

    // `landlordBearerForDataDir` reads process.env for custody, so point the
    // fallback credential root at this test's directory for the duration.
    const previous = process.env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT;
    process.env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT = credentialRoot;
    try {
      expect(landlordBearerForDataDir(dataDir)).toBe(landlordBearerForEndpointSecret(secret));
    } finally {
      if (previous === undefined) delete process.env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT;
      else process.env.CENTRAID_KEYSTORE_CREDENTIAL_ROOT = previous;
    }
  });

  test('an explicit master key derives the same bearer the daemon serves with', async () => {
    const dataDir = await tempDir('landlord-master-key-');
    roots.push(dataDir);
    const masterKey = Buffer.alloc(32, 0x31);
    const keysDir = daemonLayoutFor(dataDir).keysDir;
    const secret = new KeyStore(keysDir, { protector: aesGcmKeyProtector(masterKey) }).create(
      'endpoint-key.bin',
    );

    expect(landlordBearerForDataDir(dataDir, { masterKey })).toBe(
      landlordBearerForEndpointSecret(secret),
    );
  });

  test('deriving never mints the endpoint identity and never throws on unreadable custody', async () => {
    const dataDir = await tempDir('landlord-absent-');
    roots.push(dataDir);
    const keysDir = daemonLayoutFor(dataDir).keysDir;
    const masterKey = Buffer.alloc(32, 0x41);

    // No keys yet: a first-run desktop must get "cannot derive", not a new
    // permanent EndpointId as a side effect of asking.
    expect(landlordBearerForDataDir(dataDir, { masterKey })).toBeUndefined();
    await expect(fs.readdir(keysDir).catch(() => [])).resolves.not.toContain('endpoint-key.bin');

    // Custody this process cannot open is also a "cannot derive" answer, so the
    // caller falls back to spawning its own daemon instead of hard-failing.
    new KeyStore(keysDir, { protector: aesGcmKeyProtector(masterKey) }).create('endpoint-key.bin');
    expect(
      landlordBearerForDataDir(dataDir, { masterKey: Buffer.alloc(32, 0x42) }),
    ).toBeUndefined();
    expect(landlordBearerForDataDir(dataDir, { masterKey })).toMatch(/^[0-9a-f]{64}$/);

    // A copied data directory yields a DIFFERENT identity's bearer only if it
    // carries that identity's key; it can never derive one it does not hold.
    const copied = await tempDir('landlord-copied-');
    roots.push(copied);
    await fs.cp(dataDir, copied, { recursive: true });
    expect(landlordBearerForDataDir(copied, { masterKey })).toBe(
      landlordBearerForDataDir(dataDir, { masterKey }),
    );
  });

  test('an endpoint key stored outside the layout is not mistaken for this data dir', async () => {
    const dataDir = await tempDir('landlord-wrong-dir-');
    roots.push(dataDir);
    const masterKey = Buffer.alloc(32, 0x51);
    new KeyStore(path.join(dataDir, 'not-keys'), {
      protector: aesGcmKeyProtector(masterKey),
    }).create('endpoint-key.bin');

    expect(landlordBearerForDataDir(dataDir, { masterKey })).toBeUndefined();
  });
});
