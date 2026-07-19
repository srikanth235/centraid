import { describe, expect, test } from 'vitest';
import { bootstrapVault } from '../bootstrap.js';
import { openVaultDb } from '../db.js';
import { updateBlobStoreSettings } from '../host.js';
import { blobCustodyProven } from './custody-proven.js';
import { sha256OfBytes } from './store.js';

type CustodyCase = {
  remote: boolean;
  local: boolean;
  replica: boolean;
  pending: boolean;
};

const cases: CustodyCase[] = [false, true].flatMap((remote) =>
  [false, true].flatMap((local) =>
    [false, true].flatMap((replica) =>
      [false, true].map((pending) => ({ remote, local, replica, pending })),
    ),
  ),
);

describe('blob custody generated-state property', () => {
  test.each(cases)('fails closed for %o', ({ remote, local, replica, pending }) => {
    const db = openVaultDb({});
    bootstrapVault(db, { ownerName: 'Owner' });
    if (remote) {
      updateBlobStoreSettings(db, {
        blob_store: {
          kind: 's3',
          endpoint: 'https://example.invalid',
          bucket: 'test',
          encrypt: true,
        },
      });
    }

    const bytes = Buffer.from(`custody-${Number(remote)}-${Number(local)}`);
    const sha = sha256OfBytes(bytes);
    if (local) db.blobs.ingestSync(bytes);
    if (replica) {
      db.vault
        .prepare(
          `INSERT INTO blob_replica (sha256, replicated_at, byte_size, store)
           VALUES (?, ?, ?, 'cas')`,
        )
        .run(sha, new Date(0).toISOString(), bytes.byteLength);
    }
    if (pending) {
      db.vault
        .prepare(
          `INSERT INTO blob_outbox (sha256, byte_size, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(sha, bytes.byteLength, new Date(0).toISOString(), new Date(0).toISOString());
    }

    const expected = remote ? replica && !pending : local;
    expect(blobCustodyProven(db, sha)).toBe(expected);
    db.close();
  });
});
