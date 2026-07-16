import { afterEach, expect, test } from 'vitest';
import { DEFAULT_BACKUP_POLICY } from '../backup-policy.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { nowIso, uuidv7 } from '../ids.js';
import { BlobCache } from './cache.js';
import { MemoryBlobStore } from './local.js';
import { blobUriFor, sha256OfBytes } from './store.js';

let db: VaultDb | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

test('physical headroom pressure evicts a replicated preview below its logical budget', () => {
  db = openVaultDb();
  const local = new MemoryBlobStore();
  const first = Buffer.from('a'.repeat(50));
  const second = Buffer.from('b'.repeat(50));
  const firstSha = sha256OfBytes(first);
  const secondSha = sha256OfBytes(second);
  local.putSync(firstSha, first);
  local.putSync(secondSha, second);
  const used = () =>
    local.listSync().reduce((total, sha) => total + (local.statSync(sha)?.size ?? 0), 0);
  const cache = new BlobCache(db.vault, local, {
    policy: () => ({
      ...DEFAULT_BACKUP_POLICY,
      cacheBudgetBytes: 1_000,
      reservedHeadroomBytes: 100,
    }),
    // Capacity is 160 bytes: initially only 60 are free, below headroom.
    statfs: () => ({ bavail: 160 - used(), bsize: 1 }),
  });
  cache.replica.mark(firstSha, first.length);
  cache.replica.mark(secondSha, second.length);
  const contentId = uuidv7();
  db.vault
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, created_at)
       VALUES (?, 'image/jpeg', ?, ?, ?, ?)`,
    )
    .run(contentId, blobUriFor(secondSha), secondSha, second.length, nowIso());
  db.vault
    .prepare(
      `INSERT INTO core_content_derivative
         (derivative_id, content_id, variant, sha256, media_type, byte_size, created_at)
       VALUES (?, ?, 'preview', ?, 'image/jpeg', ?, ?)`,
    )
    .run(uuidv7(), contentId, firstSha, first.length, nowIso());

  expect(() => cache.admit(10)).not.toThrow();
  expect(local.listSync()).toHaveLength(1);
  expect(local.hasSync(secondSha)).toBe(true);
  expect(cache.metrics().evictedBytes).toBe(50);
  expect(cache.admissionCapacity().freeBytes).toBe(110);
});
