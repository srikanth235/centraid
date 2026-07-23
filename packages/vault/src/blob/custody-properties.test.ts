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

const payloadBytes: fc.Arbitrary<Buffer> = fc
  .uint8Array({ minLength: 1, maxLength: 64 })
  .map((arr) => Buffer.from(arr));

function openBootstrappedDb(remote: boolean) {
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
  return db;
}

function applyCustodyState(
  db: ReturnType<typeof openVaultDb>,
  bytes: Buffer,
  { local, replica, pending }: Omit<CustodyCase, 'remote'>,
): string {
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
  return sha;
}

/**
 * Blob custody / CAS fail-closed properties (#532).
 *
 * Model: remote tier ⇒ durable replica and no pending outbox; local-only ⇒
 * local CAS presence. Generative suites + corner properties keep the latch
 * under-constrained only if a mutant survives every case.
 */
describe('blob custody generated-state property', () => {
  test('fails closed for every remote/local/replica/pending combination', () => {
    fc.assert(
      fc.property(custodyFlags, payloadBytes, ({ remote, local, replica, pending }, bytes) => {
        const db = openBootstrappedDb(remote);
        const sha = applyCustodyState(db, bytes, { local, replica, pending });
        const expected = remote ? replica && !pending : local;
        const proven = blobCustodyProven(db, sha);
        db.close();
        expect(proven).toBe(expected);
      }),
      { numRuns: 48, seed: 53201 },
    );
  });

  test('exhaustive 16-state table matches the model', () => {
    const all: CustodyCase[] = [false, true].flatMap((remote) =>
      [false, true].flatMap((local) =>
        [false, true].flatMap((replica) =>
          [false, true].map((pending) => ({ remote, local, replica, pending })),
        ),
      ),
    );
    expect(all).toHaveLength(16);
    for (const c of all) {
      const db = openBootstrappedDb(c.remote);
      const sha = applyCustodyState(db, Buffer.from(`ex-${JSON.stringify(c)}`), c);
      const expected = c.remote ? c.replica && !c.pending : c.local;
      expect(blobCustodyProven(db, sha)).toBe(expected);
      db.close();
    }
  });

  test('unknown sha is never proven on a local-only vault', () => {
    fc.assert(
      fc.property(payloadBytes, (bytes) => {
        const db = openBootstrappedDb(false);
        const sha = sha256OfBytes(bytes);
        // never ingest
        expect(blobCustodyProven(db, sha)).toBe(false);
        db.close();
      }),
      { numRuns: 24, seed: 53212 },
    );
  });

  test('remote tier without replica never proves (even if local CAS has bytes)', () => {
    fc.assert(
      fc.property(payloadBytes, (bytes) => {
        const db = openBootstrappedDb(true);
        const sha = applyCustodyState(db, bytes, { local: true, replica: false, pending: false });
        expect(blobCustodyProven(db, sha)).toBe(false);
        db.close();
      }),
      { numRuns: 24, seed: 53213 },
    );
  });

  test('remote replica with pending outbox never proves', () => {
    fc.assert(
      fc.property(payloadBytes, (bytes) => {
        const db = openBootstrappedDb(true);
        const sha = applyCustodyState(db, bytes, { local: false, replica: true, pending: true });
        expect(blobCustodyProven(db, sha)).toBe(false);
        db.close();
      }),
      { numRuns: 24, seed: 53214 },
    );
  });

  test('remote replica without pending always proves', () => {
    fc.assert(
      fc.property(payloadBytes, (bytes) => {
        const db = openBootstrappedDb(true);
        const sha = applyCustodyState(db, bytes, { local: false, replica: true, pending: false });
        expect(blobCustodyProven(db, sha)).toBe(true);
        db.close();
      }),
      { numRuns: 24, seed: 53215 },
    );
  });

  test('local-only with local CAS always proves', () => {
    fc.assert(
      fc.property(payloadBytes, (bytes) => {
        const db = openBootstrappedDb(false);
        const sha = applyCustodyState(db, bytes, { local: true, replica: false, pending: false });
        expect(blobCustodyProven(db, sha)).toBe(true);
        db.close();
      }),
      { numRuns: 24, seed: 53216 },
    );
  });

  test('local-only ignores remote replica/outbox tables for proof', () => {
    fc.assert(
      fc.property(payloadBytes, fc.boolean(), fc.boolean(), (bytes, replica, pending) => {
        const db = openBootstrappedDb(false);
        const sha = applyCustodyState(db, bytes, { local: true, replica, pending });
        // local tier: only local CAS matters
        expect(blobCustodyProven(db, sha)).toBe(true);
        db.close();
      }),
      { numRuns: 24, seed: 53217 },
    );
  });

  test('proof is deterministic for a fixed custody state', () => {
    fc.assert(
      fc.property(custodyFlags, payloadBytes, (flags, bytes) => {
        const db = openBootstrappedDb(flags.remote);
        const sha = applyCustodyState(db, bytes, flags);
        const a = blobCustodyProven(db, sha);
        const b = blobCustodyProven(db, sha);
        expect(a).toBe(b);
        db.close();
      }),
      { numRuns: 24, seed: 53218 },
    );
  });

  test('clearing pending after replica enables proof under remote tier', () => {
    fc.assert(
      fc.property(payloadBytes, (bytes) => {
        const db = openBootstrappedDb(true);
        const sha = applyCustodyState(db, bytes, { local: false, replica: true, pending: true });
        expect(blobCustodyProven(db, sha)).toBe(false);
        db.vault.prepare('DELETE FROM blob_outbox WHERE sha256 = ?').run(sha);
        expect(blobCustodyProven(db, sha)).toBe(true);
        db.close();
      }),
      { numRuns: 16, seed: 53219 },
    );
  });

  test('removing replica after it was proven drops proof under remote tier', () => {
    fc.assert(
      fc.property(payloadBytes, (bytes) => {
        const db = openBootstrappedDb(true);
        const sha = applyCustodyState(db, bytes, { local: false, replica: true, pending: false });
        expect(blobCustodyProven(db, sha)).toBe(true);
        db.vault.prepare('DELETE FROM blob_replica WHERE sha256 = ?').run(sha);
        expect(blobCustodyProven(db, sha)).toBe(false);
        db.close();
      }),
      { numRuns: 16, seed: 53220 },
    );
  });

  test('local-only proof requires the exact sha (different payload does not prove)', () => {
    fc.assert(
      fc.property(payloadBytes, payloadBytes, (a, b) => {
        fc.pre(!a.equals(b));
        const db = openBootstrappedDb(false);
        const shaA = applyCustodyState(db, a, { local: true, replica: false, pending: false });
        const shaB = sha256OfBytes(b);
        expect(blobCustodyProven(db, shaA)).toBe(true);
        expect(blobCustodyProven(db, shaB)).toBe(false);
        db.close();
      }),
      { numRuns: 24, seed: 53221 },
    );
  });
});
