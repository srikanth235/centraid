import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, expect, test } from 'vitest';
import { promises as fs, statSync } from 'node:fs';
import path from 'node:path';
import { daemonKeyStore, headlessCredentialFile } from './key-store.js';

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

test('headless fallback wraps every data-dir key with an external 0600 credential', async () => {
  const root = await tempDir('headless-keystore-');
  const credentialRoot = await tempDir('headless-credentials-');
  roots.push(root, credentialRoot);
  const keysDir = path.join(root, 'keys');
  const env = { CENTRAID_KEYSTORE_CREDENTIAL_ROOT: credentialRoot };
  const warnings: string[] = [];
  const store = daemonKeyStore(keysDir, { env, warn: (message) => warnings.push(message) });
  const secrets = [
    ['endpoint-key.bin', Buffer.alloc(32, 0x11)],
    ['vault-a.sealkey', Buffer.alloc(32, 0x22)],
    ['connections.sealkey', Buffer.alloc(32, 0x33)],
    ['keyring.key', Buffer.alloc(32, 0x44)],
  ] as const;
  for (const [name, secret] of secrets) store.store(name, secret);

  const credential = headlessCredentialFile(keysDir, env);
  expect(credential.startsWith(`${root}${path.sep}`)).toBe(false);
  expect(statSync(credential).mode & 0o777).toBe(0o600);
  expect(warnings).toContainEqual(expect.stringMatching(/external 0600 host credential/i));
  for (const [name, secret] of secrets) {
    const raw = await fs.readFile(path.join(keysDir, name), 'utf8');
    expect(raw).toContain('"scheme":"aes-256-gcm-v1"');
    const payload = JSON.parse(raw.slice(raw.indexOf('{'))) as { payload: string };
    expect(Buffer.from(payload.payload, 'base64')).not.toEqual(secret);
    expect(store.load(name)).toEqual(secret);
  }
});

test('copying only the data dir cannot open headless sealed envelopes', async () => {
  const source = await tempDir('headless-source-');
  const copied = await tempDir('headless-copy-');
  const credentialRoot = await tempDir('headless-copy-credentials-');
  roots.push(source, copied, credentialRoot);
  const env = { CENTRAID_KEYSTORE_CREDENTIAL_ROOT: credentialRoot };
  const original = daemonKeyStore(path.join(source, 'keys'), { env });
  original.store('endpoint-key.bin', Buffer.alloc(32, 0x5a));
  await fs.cp(source, copied, { recursive: true });

  expect(() => daemonKeyStore(path.join(copied, 'keys'), { env }).load('endpoint-key.bin')).toThrow(
    /authentication failed/i,
  );
});
