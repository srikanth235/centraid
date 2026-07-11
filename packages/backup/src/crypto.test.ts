import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  activeMasterKey,
  chunkId,
  createKeyring,
  decrypt,
  deriveDataKey,
  deriveDedupKey,
  encrypt,
  loadKeyring,
  masterKeyForEpoch,
  rotateKeyring,
  saveKeyring,
  type Keyring,
} from './crypto.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-crypto-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('encrypt/decrypt', () => {
  test('roundtrips', () => {
    const key = new Uint8Array(32).fill(7);
    const plain = new TextEncoder().encode('the quick brown fox');
    const blob = encrypt(key, plain);
    expect(blob.length).toBe(12 + plain.length + 16);
    const back = decrypt(key, blob);
    expect(new TextDecoder().decode(back)).toBe('the quick brown fox');
  });

  test('random IV means two encryptions of the same plaintext differ', () => {
    const key = new Uint8Array(32).fill(3);
    const plain = new TextEncoder().encode('same plaintext');
    const a = encrypt(key, plain);
    const b = encrypt(key, plain);
    expect([...a]).not.toEqual([...b]);
    expect(new TextDecoder().decode(decrypt(key, a))).toBe('same plaintext');
    expect(new TextDecoder().decode(decrypt(key, b))).toBe('same plaintext');
  });

  test('tamper (flip a ciphertext byte) throws', () => {
    const key = new Uint8Array(32).fill(1);
    const blob = encrypt(key, new TextEncoder().encode('secret'));
    const tampered = new Uint8Array(blob);
    const midpoint = Math.floor(tampered.length / 2);
    tampered[midpoint] = (tampered[midpoint]! ^ 0xff) & 0xff;
    expect(() => decrypt(key, tampered)).toThrow();
  });

  test('tamper (flip a tag byte) throws', () => {
    const key = new Uint8Array(32).fill(1);
    const blob = encrypt(key, new TextEncoder().encode('secret'));
    const tampered = new Uint8Array(blob);
    const lastByte = tampered.length - 1;
    tampered[lastByte] = (tampered[lastByte]! ^ 0xff) & 0xff;
    expect(() => decrypt(key, tampered)).toThrow();
  });

  test('wrong key throws', () => {
    const key = new Uint8Array(32).fill(1);
    const wrongKey = new Uint8Array(32).fill(2);
    const blob = encrypt(key, new TextEncoder().encode('secret'));
    expect(() => decrypt(wrongKey, blob)).toThrow();
  });

  test('truncated blob throws', () => {
    const key = new Uint8Array(32).fill(1);
    expect(() => decrypt(key, new Uint8Array(10))).toThrow();
  });
});

describe('HKDF derivation', () => {
  test('deriveDataKey and deriveDedupKey are stable and distinct for the same input', () => {
    const master = new Uint8Array(32).fill(9);
    const dataKey1 = deriveDataKey(master, 'vault-a');
    const dataKey2 = deriveDataKey(master, 'vault-a');
    const dedupKey = deriveDedupKey(master, 'vault-a');
    expect([...dataKey1]).toEqual([...dataKey2]);
    expect([...dataKey1]).not.toEqual([...dedupKey]);
    expect(dataKey1.length).toBe(32);
  });

  test('different vaultId produces a different key (no cross-vault reuse)', () => {
    const master = new Uint8Array(32).fill(9);
    const keyA = deriveDataKey(master, 'vault-a');
    const keyB = deriveDataKey(master, 'vault-b');
    expect([...keyA]).not.toEqual([...keyB]);
  });

  test('frozen HKDF vector — pins the exact info-string derivation', () => {
    const master = new Uint8Array(32).fill(0x42);
    const dataKey = deriveDataKey(master, 'vault-frozen');
    const dedupKey = deriveDedupKey(master, 'vault-frozen');
    // Recorded once from this implementation's own output — any future
    // change to the info-string format or the HKDF call shape breaks this.
    expect(Buffer.from(dataKey).toString('hex')).toBe(
      '2c4b05ea97c0bc7191ad311e32c9902f17e8b1615ee69f7cc59acb997640e442',
    );
    expect(Buffer.from(dedupKey).toString('hex')).toBe(
      'e12bcf5846425642b5c02db8e746e129a98631a4b1666a34c4afb3b88119809e',
    );
  });

  test('chunkId is a deterministic keyed HMAC', () => {
    const dedupKey = new Uint8Array(32).fill(5);
    const plain = new TextEncoder().encode('chunk contents');
    const id1 = chunkId(dedupKey, plain);
    const id2 = chunkId(dedupKey, plain);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{64}$/);
    const otherKey = new Uint8Array(32).fill(6);
    expect(chunkId(otherKey, plain)).not.toBe(id1);
  });
});

describe('keyring', () => {
  test('createKeyring mints a single-epoch keyring, mode 0600', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'keyring.json');
    const keyring = await createKeyring(file);
    expect(keyring.version).toBe(1);
    expect(keyring.active).toBe(1);
    expect(keyring.epochs).toHaveLength(1);
    const st = await fs.stat(file);
    expect(st.mode & 0o777).toBe(0o600);
  });

  test('createKeyring refuses to overwrite an existing file', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'keyring.json');
    await createKeyring(file);
    await expect(createKeyring(file)).rejects.toThrow(/already exists/);
  });

  test('load/save roundtrip', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'keyring.json');
    const created = await createKeyring(file);
    const loaded = await loadKeyring(file);
    expect(loaded).toEqual(created);
  });

  test('saveKeyring is atomic and mode 0600', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'keyring.json');
    const keyring: Keyring = {
      version: 1,
      active: 1,
      epochs: [
        {
          epoch: 1,
          key: Buffer.alloc(32, 1).toString('base64'),
          createdAt: new Date().toISOString(),
        },
      ],
    };
    await saveKeyring(file, keyring);
    const st = await fs.stat(file);
    expect(st.mode & 0o777).toBe(0o600);
    expect(await loadKeyring(file)).toEqual(keyring);
  });

  test('rotateKeyring adds a new epoch and makes it active, retaining the old one', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'keyring.json');
    const original = await createKeyring(file);
    const rotated = await rotateKeyring(file);
    expect(rotated.active).toBe(2);
    expect(rotated.epochs).toHaveLength(2);
    expect(rotated.epochs[0]).toEqual(original.epochs[0]);
    expect(rotated.epochs[1]!.epoch).toBe(2);

    // Old epoch's key is unchanged and still resolvable.
    const oldKey = masterKeyForEpoch(rotated, 1);
    expect(Buffer.from(oldKey).toString('base64')).toBe(original.epochs[0]!.key);

    const active = activeMasterKey(rotated);
    expect(active.epoch).toBe(2);
  });

  test('rotating twice keeps all three epochs, active = newest', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'keyring.json');
    await createKeyring(file);
    await rotateKeyring(file);
    const twiceRotated = await rotateKeyring(file);
    expect(twiceRotated.active).toBe(3);
    expect(twiceRotated.epochs.map((e) => e.epoch)).toEqual([1, 2, 3]);
  });

  test('masterKeyForEpoch throws for an unknown epoch', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'keyring.json');
    const keyring = await createKeyring(file);
    expect(() => masterKeyForEpoch(keyring, 999)).toThrow();
  });

  test('loadKeyring rejects a malformed file', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'keyring.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, active: 1, epochs: [] }));
    await expect(loadKeyring(file)).rejects.toThrow();
  });
});
