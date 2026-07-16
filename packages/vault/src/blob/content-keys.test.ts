import { afterEach, expect, test } from 'vitest';
import { bootstrapVault } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { BlobContentKeyRegistry } from './content-keys.js';
import { MemoryBlobStore } from './local.js';
import { sealBlob } from './seal.js';
import { sha256OfBytes } from './store.js';

const opened: VaultDb[] = [];
afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
});

test('device revocation and vault-key rewrap preserve content keys without mutating CAS bytes', () => {
  const db = openVaultDb();
  opened.push(db);
  const boot = bootstrapVault(db, { ownerName: 'Priya' });
  const oldRoot = Buffer.alloc(32, 0x11);
  const nextRoot = Buffer.alloc(32, 0x22);
  const keys = new BlobContentKeyRegistry(db.vault, oldRoot);
  const deviceId = keys.enrollPairedDevice({
    identity: 'paired-endpoint-key',
    ownerPartyId: boot.ownerPartyId,
    name: 'Phone',
    trust: 'full',
  });
  const remainingId = keys.enrollPairedDevice({
    identity: 'remaining-endpoint-key',
    ownerPartyId: boot.ownerPartyId,
    name: 'Laptop',
    trust: 'full',
  });
  const plain = Buffer.from('content-key rotation never rewrites this provider object');
  const sha = sha256OfBytes(plain);
  const contentKey = keys.getOrCreate(sha);
  const cas = new MemoryBlobStore();
  cas.putSync(sha, sealBlob(contentKey, sha, plain, 16));
  const before = cas.getSync(sha)!;
  const revokedGrant = keys.grantToDevice(sha, 'paired-endpoint-key');
  const remainingGrant = keys.grantToDevice(sha, 'remaining-endpoint-key');
  expect(revokedGrant.keyEpoch).toBe(1);
  expect(remainingGrant.keyEpoch).toBe(1);

  expect(keys.rewrapAll(nextRoot)).toBe(1);
  expect(keys.getOrCreate(sha).equals(contentKey)).toBe(true);
  expect(new BlobContentKeyRegistry(db.vault, nextRoot).getOrCreate(sha).equals(contentKey)).toBe(
    true,
  );
  expect(keys.grantToDevice(sha, deviceId).contentKeyEpoch).toBe(2);
  expect(cas.getSync(sha)!.equals(before)).toBe(true);

  expect(keys.revokeDevice('paired-endpoint-key')).toBe(1);
  expect(() => keys.grantToDevice(sha, deviceId)).toThrow(/unknown or revoked paired device/);
  const rotated = keys.grantToDevice(sha, remainingId);
  expect(rotated.keyEpoch).toBe(2);
  expect(rotated.wrapSaltBase64).not.toBe(remainingGrant.wrapSaltBase64);
  expect(rotated.wrappedKeyBase64).not.toBe(remainingGrant.wrappedKeyBase64);
  expect(cas.getSync(sha)!.equals(before)).toBe(true);
});
