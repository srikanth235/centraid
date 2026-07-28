import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  KEY_STORE_ENVELOPE_MAGIC,
  KeyStore,
  KeyStoreError,
  aesGcmKeyProtector,
  type KeyProtector,
} from './key-store.js';

const roots: string[] = [];

describe('key-store', () => {
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function store(options: ConstructorParameters<typeof KeyStore>[1] = {}): KeyStore {
    const root = mkdtempSync(path.join(os.tmpdir(), 'centraid-key-store-'));
    roots.push(root);
    return new KeyStore(path.join(root, 'keys'), options);
  }

  test('legacy file custody writes an atomic self-describing 0600 envelope', () => {
    const keys = store();
    const secret = keys.loadOrCreate('endpoint-key.bin');
    const file = keys.file('endpoint-key.bin');

    expect(secret).toHaveLength(32);
    expect(readFileSync(file, 'utf8').startsWith(KEY_STORE_ENVELOPE_MAGIC)).toBe(true);
    expect(readFileSync(file).equals(secret)).toBe(false);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('an interrupted first mint leaves no short key and retry commits a complete envelope', () => {
    const keys = store({
      beforeCommit: () => {
        throw new Error('injected interruption before rename');
      },
    });

    expect(() => keys.loadOrCreate('endpoint-key.bin')).toThrow(/injected interruption/u);
    expect(existsSync(keys.file('endpoint-key.bin'))).toBe(false);
    expect(readdirSync(keys.dir)).toStrictEqual([]);

    const retry = new KeyStore(keys.dir);
    expect(retry.loadOrCreate('endpoint-key.bin')).toHaveLength(32);
    expect(readFileSync(retry.file('endpoint-key.bin'), 'utf8')).toMatch(/^CENTRAID-KEY-V1\n/u);
  });

  test('adopts a legacy raw key without changing its value', () => {
    const keys = store({
      protector: aesGcmKeyProtector(Buffer.alloc(32, 0x51)),
    });
    mkdirSync(keys.dir, { recursive: true });
    const legacy = Buffer.alloc(32, 7);
    writeFileSync(keys.file('vault.sealkey'), legacy, { mode: 0o600 });

    expect(keys.load('vault.sealkey')?.equals(legacy)).toBe(true);
    expect(
      readFileSync(keys.file('vault.sealkey'), 'utf8').startsWith(KEY_STORE_ENVELOPE_MAGIC),
    ).toBe(true);
    expect(readFileSync(keys.file('vault.sealkey'), 'utf8')).toContain('"scheme":"aes-256-gcm-v1"');
  });

  test('repairs permissive file modes and reports the repair', () => {
    const warnings: string[] = [];
    const keys = store({ warn: (message) => warnings.push(message) });
    keys.store('connections.sealkey', Buffer.alloc(32, 9));
    chmodSync(keys.file('connections.sealkey'), 0o644);

    expect(keys.load('connections.sealkey')).toHaveLength(32);
    expect(statSync(keys.file('connections.sealkey')).mode & 0o777).toBe(0o600);
    expect(warnings).toHaveLength(1);
  });

  test('routes payloads through a supplied OS-custody protector', () => {
    const protector: KeyProtector = {
      scheme: 'test-os-v1',
      protect: (secret) => Buffer.from(secret.map((byte) => byte ^ 0xa5)),
      unprotect: (payload) => Buffer.from(payload.map((byte) => byte ^ 0xa5)),
    };
    const keys = store({ protector });
    const secret = Buffer.alloc(32, 3);

    keys.store('keyring.key', secret);

    expect(keys.load('keyring.key')?.equals(secret)).toBe(true);
    expect(readFileSync(keys.file('keyring.key'), 'utf8')).toContain('"scheme":"test-os-v1"');
  });

  test('AES protector requires the device wrapping key and rewraps file custody', () => {
    const plain = store();
    const secret = Buffer.alloc(32, 4);
    plain.store('vault.sealkey', secret);
    const structured = Buffer.from(JSON.stringify({ version: 1, epochs: ['first'] }));
    plain.import('keyring.key', structured);

    const protectedStore = new KeyStore(plain.dir, {
      protector: aesGcmKeyProtector(Buffer.alloc(32, 8)),
    });
    expect(protectedStore.load('vault.sealkey')).toStrictEqual(secret);
    expect(protectedStore.export('keyring.key')).toStrictEqual(structured);
    expect(readFileSync(plain.file('vault.sealkey'), 'utf8')).toContain(
      '"scheme":"aes-256-gcm-v1"',
    );
    expect(readFileSync(plain.file('keyring.key'), 'utf8')).toContain('"scheme":"aes-256-gcm-v1"');
    expect(() =>
      new KeyStore(plain.dir, {
        protector: aesGcmKeyProtector(Buffer.alloc(32, 9)),
      }).load('vault.sealkey'),
    ).toThrow(/authentication failed/u);
    expect(() => new KeyStore(plain.dir).load('vault.sealkey')).toThrow(
      /unavailable custody scheme/u,
    );
  });

  test('corrupt, unsupported, and invalid names fail closed', () => {
    const keys = store();
    mkdirSync(keys.dir, { recursive: true });
    writeFileSync(keys.file('bad.key'), 'not a key', { mode: 0o600 });
    expect(() => keys.load('bad.key')).toThrow(KeyStoreError);
    expect(() => keys.load('../escape')).toThrow(/invalid key name/u);

    writeFileSync(
      keys.file('foreign.key'),
      `${KEY_STORE_ENVELOPE_MAGIC}${JSON.stringify({ scheme: 'other-v1', payload: 'AA==' })}\n`,
      { mode: 0o600 },
    );
    expect(() => keys.load('foreign.key')).toThrow(/unavailable custody scheme/u);
  });

  test('rotate, export, import, and destroy cover the named-secret lifecycle', () => {
    const keys = store();
    const first = Buffer.alloc(32, 1);
    keys.import('endpoint-key.bin', first);
    expect(keys.export('endpoint-key.bin')?.equals(first)).toBe(true);

    const rotated = keys.rotate('endpoint-key.bin');
    expect(rotated.equals(first)).toBe(false);
    expect(keys.load('endpoint-key.bin')?.equals(rotated)).toBe(true);
    keys.store('endpoint-key.bin.next', Buffer.alloc(32, 2));
    expect(keys.destroy('endpoint-key.bin')).toBe(true);
    expect(keys.destroy('endpoint-key.bin')).toBe(false);
    expect(keys.load('endpoint-key.bin.next')).toBeNull();
  });

  test('the whole data tree contains envelopes, never raw secret bytes', () => {
    const keys = store({
      protector: aesGcmKeyProtector(Buffer.alloc(32, 0x52)),
    });
    const dataDir = path.dirname(keys.dir);
    const secrets = [
      Buffer.alloc(32, 0x11),
      Buffer.alloc(32, 0x22),
      Buffer.alloc(32, 0x33),
      Buffer.alloc(32, 0x44),
    ];
    for (const [name, secret] of [
      ['endpoint-key.bin', secrets[0]!],
      ['vault-a.sealkey', secrets[1]!],
      ['connections.sealkey', secrets[2]!],
      ['keyring.key', secrets[3]!],
    ] as const) {
      keys.store(name, secret);
    }
    mkdirSync(path.join(dataDir, 'cache'), { recursive: true });
    writeFileSync(path.join(dataDir, 'gateway.db'), 'control-state');
    writeFileSync(path.join(dataDir, 'cache', 'catalog.json'), '{}');

    const files = readdirSync(dataDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name));
    expect(files).not.toHaveLength(0);
    // Every file on disk — key-store or not — must be free of raw secret bytes.
    for (const file of files) {
      for (const secret of secrets) expect(readFileSync(file)).not.toContain(secret);
    }
    // The key-store's own files carry the envelope header and are never a bare
    // 32-byte secret. Filtered up front so both assertions always run.
    const stored = files.filter((file) => file.startsWith(`${keys.dir}${path.sep}`));
    expect(stored).not.toHaveLength(0);
    for (const file of stored) {
      const bytes = readFileSync(file);
      expect(bytes.toString('utf8')).toMatch(/^CENTRAID-KEY-V1\n/u);
      expect(bytes).not.toHaveLength(32);
    }
  });
});
