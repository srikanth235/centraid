// The prune custody latch (issue #438 decision 3). A local-only vault proves
// custody by local CAS presence; an s3-configured vault requires durable
// replica evidence AND no pending outbox obligation. Fail closed on every gap.

import { expect, test } from 'vitest';
import { openVaultDb, type VaultDb } from '../db.js';
import { bootstrapVault } from '../bootstrap.js';
import { updateBlobStoreSettings } from '../host.js';
import { blobCustodyProven } from './custody-proven.js';
import { sha256OfBytes } from './store.js';

/** A bootstrapped vault (has the core_vault row settings writes target). */
function newVault(): VaultDb {
  const db = openVaultDb({});
  bootstrapVault(db, { ownerName: 'Owner' });
  return db;
}

function setS3(db: VaultDb): void {
  updateBlobStoreSettings(db, {
    blob_store: { kind: 's3', endpoint: 'https://x', bucket: 'b', encrypt: true },
  });
}

test('local-only vault: custody proven iff the segment is in the local CAS', () => {
  const db = newVault();
  const bytes = Buffer.from('segment');
  const sha = sha256OfBytes(bytes);
  expect(blobCustodyProven(db, sha)).toBe(false); // not ingested yet
  db.blobs.ingestSync(bytes);
  expect(blobCustodyProven(db, sha)).toBe(true);
  db.close();
});

test('s3 vault: unproven until a replica row exists', () => {
  const db = newVault();
  setS3(db);
  const sha = sha256OfBytes(Buffer.from('segment'));
  db.blobs.ingestSync(Buffer.from('segment')); // local presence is NOT enough here
  expect(blobCustodyProven(db, sha)).toBe(false);
  db.vault
    .prepare(
      `INSERT INTO blob_replica (sha256, replicated_at, byte_size, store) VALUES (?, ?, 7, 'cas')`,
    )
    .run(sha, new Date().toISOString());
  expect(blobCustodyProven(db, sha)).toBe(true);
  db.close();
});

test('s3 vault: a pending outbox obligation keeps it unproven even with a replica row', () => {
  const db = newVault();
  setS3(db);
  const sha = sha256OfBytes(Buffer.from('segment'));
  db.vault
    .prepare(
      `INSERT INTO blob_replica (sha256, replicated_at, byte_size, store) VALUES (?, ?, 7, 'cas')`,
    )
    .run(sha, new Date().toISOString());
  db.vault
    .prepare(
      `INSERT INTO blob_outbox (sha256, byte_size, created_at, updated_at) VALUES (?, 7, ?, ?)`,
    )
    .run(sha, new Date().toISOString(), new Date().toISOString());
  expect(blobCustodyProven(db, sha)).toBe(false); // replacement upload still outstanding
  db.vault.prepare(`DELETE FROM blob_outbox WHERE sha256 = ?`).run(sha);
  expect(blobCustodyProven(db, sha)).toBe(true);
  db.close();
});
