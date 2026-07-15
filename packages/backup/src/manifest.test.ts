import { describe, expect, test } from 'vitest';
import { createKeyring } from './crypto.js';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalJson,
  isSafeEntryPath,
  openManifest,
  sealManifest,
  sha256Hex,
  verifyManifest,
  type ManifestEntry,
} from './manifest.js';

describe('canonicalJson', () => {
  test('sorts object keys recursively', () => {
    const a = canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test('preserves array order (arrays are not sorted)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  test('produces no insignificant whitespace', () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).not.toMatch(/\s/);
  });

  test('key order in the source object does not affect output', () => {
    const obj1 = { z: 1, a: 2, m: 3 };
    const obj2 = { m: 3, z: 1, a: 2 };
    expect(canonicalJson(obj1)).toBe(canonicalJson(obj2));
  });

  test('drops undefined properties (matches JSON.stringify)', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test('null and primitives', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(true)).toBe('true');
  });
});

describe('sha256Hex / verifyManifest', () => {
  test('verifyManifest matches sha256Hex of the exact bytes', () => {
    const bytes = new TextEncoder().encode('hello manifest');
    const hash = sha256Hex(bytes);
    expect(verifyManifest(bytes, hash)).toBe(true);
    expect(verifyManifest(bytes, `${hash.slice(0, -1)}0`)).toBe(false);
  });
});

describe('isSafeEntryPath', () => {
  test('accepts normal relative paths', () => {
    expect(isSafeEntryPath('vault.db')).toBe(true);
    expect(isSafeEntryPath('blobs/ab/cdef')).toBe(true);
  });

  test('rejects absolute paths', () => {
    expect(isSafeEntryPath('/etc/passwd')).toBe(false);
    expect(isSafeEntryPath('C:\\Windows\\system32')).toBe(false);
  });

  test('rejects traversal segments', () => {
    expect(isSafeEntryPath('../../etc/passwd')).toBe(false);
    expect(isSafeEntryPath('blobs/../../../etc/passwd')).toBe(false);
    expect(isSafeEntryPath('./x')).toBe(false);
  });

  test('rejects empty path', () => {
    expect(isSafeEntryPath('')).toBe(false);
  });
});

describe('sealManifest / openManifest', () => {
  async function keyringFixture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-manifest-'));
    const keyring = await createKeyring(path.join(dir, 'keyring.json'));
    return keyring;
  }

  test('seal then open roundtrips public fields and sealed entries', async () => {
    const keyring = await keyringFixture();
    const aa = 'aa'.repeat(32);
    const bb = 'bb'.repeat(32);
    const cc = 'cc'.repeat(32);
    const entries: ManifestEntry[] = [
      { path: 'vault.db', kind: 'db', size: 100, mtimeMs: 1000, chunks: [aa, bb] },
      { path: 'blobs/x', kind: 'blob', size: 50, mtimeMs: 2000, chunks: [cc] },
    ];
    const { bytes, manifestHash, manifest } = sealManifest({
      keyring,
      vaultId: 'vault-1',
      keyEpoch: 1,
      generation: 3,
      prevManifestHash: null,
      chunkIndex: [
        { id: aa, size: 10 },
        { id: bb, size: 20 },
        { id: cc, size: 50 },
      ],
      appMeta: { gatewayVersion: '0.1.0' },
      entries,
    });
    expect(sha256Hex(bytes)).toBe(manifestHash);
    expect(manifest.format).toBe('centraid-snapshot/1');

    const opened = openManifest(bytes, keyring, 'vault-1', manifestHash);
    expect(opened.public.generation).toBe(3);
    expect(opened.public.keyEpoch).toBe(1);
    expect(opened.public.chunkIndex).toEqual(manifest.chunkIndex);
    expect(opened.entries).toEqual(entries);
  });

  test('hash verification catches a modified manifest object', async () => {
    const keyring = await keyringFixture();
    const { bytes, manifestHash } = sealManifest({
      keyring,
      vaultId: 'vault-1',
      keyEpoch: 1,
      generation: 1,
      prevManifestHash: null,
      chunkIndex: [],
      appMeta: {},
      entries: [],
    });
    const tampered = new Uint8Array(bytes);
    tampered[0]! ^= 0xff;
    expect(verifyManifest(tampered, manifestHash)).toBe(false);
    expect(() => openManifest(tampered, keyring, 'vault-1', manifestHash)).toThrow(/hash mismatch/);
  });

  test('authenticated public envelope rejects a provider-rehashed metadata rewrite', async () => {
    const keyring = await keyringFixture();
    const { bytes } = sealManifest({
      keyring,
      vaultId: 'vault-1',
      keyEpoch: 1,
      generation: 1,
      prevManifestHash: null,
      chunkIndex: [],
      appMeta: { ontologyVersion: '1.2' },
      entries: [],
    });
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    parsed['format'] = 'centraid-snapshot/1';
    parsed['generation'] = 99;
    parsed['appMeta'] = { ontologyVersion: '0.1' };
    const rewritten = new TextEncoder().encode(canonicalJson(parsed));

    expect(() => openManifest(rewritten, keyring, 'vault-1', sha256Hex(rewritten))).toThrow();
  });

  test('openManifest rejects a hostile entry path even if the hash is valid', async () => {
    const keyring = await keyringFixture();
    const zz = 'dd'.repeat(32);
    const { bytes, manifestHash } = sealManifest({
      keyring,
      vaultId: 'vault-1',
      keyEpoch: 1,
      generation: 1,
      prevManifestHash: null,
      chunkIndex: [{ id: zz, size: 1 }],
      appMeta: {},
      entries: [{ path: '../../etc/passwd', kind: 'blob', size: 1, mtimeMs: 1, chunks: [zz] }],
    });
    expect(() => openManifest(bytes, keyring, 'vault-1', manifestHash)).toThrow(
      /path traversal|rejected/,
    );
  });

  test('openManifest throws on wrong vaultId (dedup/data key mismatch decrypt failure)', async () => {
    const keyring = await keyringFixture();
    const { bytes, manifestHash } = sealManifest({
      keyring,
      vaultId: 'vault-1',
      keyEpoch: 1,
      generation: 1,
      prevManifestHash: null,
      chunkIndex: [],
      appMeta: {},
      entries: [],
    });
    expect(() => openManifest(bytes, keyring, 'vault-OTHER', manifestHash)).toThrow();
  });

  test('sealed payload is not readable without opening (base64 blob, not plaintext)', async () => {
    const keyring = await keyringFixture();
    const { manifest } = sealManifest({
      keyring,
      vaultId: 'vault-1',
      keyEpoch: 1,
      generation: 1,
      prevManifestHash: null,
      chunkIndex: [],
      appMeta: {},
      entries: [{ path: 'secret-name.db', kind: 'db', size: 1, mtimeMs: 1, chunks: [] }],
    });
    expect(manifest.sealedPayload).not.toContain('secret-name.db');
  });
});
