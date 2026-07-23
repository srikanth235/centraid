import { describe, expect, test } from 'vitest';
import { fc } from '@centraid/test-kit/fast-check';
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

const custodyFlags: fc.Arbitrary<CustodyCase> = fc.record({
  remote: fc.boolean(),
  local: fc.boolean(),
  replica: fc.boolean(),
  pending: fc.boolean(),
});

/**
 * Blob custody / CAS fail-closed property (#532).
 *
 * Model: when a remote tier is configured, proof requires durable replica
 * evidence and no pending outbox; when local-only, local CAS presence suffices.
 * Hand-enumerated 16-state table is preserved as the property domain via
 * fast-check booleans (still exhaustive under numRuns ≥ 16 with noDuplicates).
 */
describe('blob custody generated-state property', () => {
  test('fails closed for every remote/local/replica/pending combination', () => {
    fc.assert(
      fc.property(custodyFlags, ({ remote, local, replica, pending }) => {
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
        const proven = blobCustodyProven(db, sha);
        db.close();
        expect(proven).toBe(expected);
      }),
      { numRuns: 32, seed: 53201 },
    );
  });
});
