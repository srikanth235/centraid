// CAS inventory diff primitive unit tests (issue #545 B7).

import { describe, expect, test } from 'vitest';
import { baseStore, reconcileCasInventory } from './backup-cas-diff.js';
import type { CollectedInventory } from './backup-provider-observability.js';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);

function collection(
  objects: CollectedInventory['objects'],
  over: Partial<CollectedInventory> = {},
): CollectedInventory {
  return {
    source: 'provider',
    providerAttested: true,
    objects,
    ...over,
  };
}

describe('backup-cas-diff', () => {
  test('baseStore aggregates live vs soft-deleted object counts and bytes', () => {
    const state = baseStore(
      collection([
        {
          key: `blobs/sha256/${SHA_A}`,
          sizeBytes: 10,
          etagOrHash: SHA_A,
          storedAt: 1,
          state: 'live',
        },
        {
          key: `blobs/sha256/${SHA_B}`,
          sizeBytes: 5,
          etagOrHash: SHA_B,
          storedAt: 1,
          state: 'soft-deleted',
        },
      ]),
      [SHA_C],
      ['orphan-key'],
    );
    expect(state).toMatchObject({
      configured: true,
      source: 'provider',
      providerAttested: true,
      objectCount: 2,
      bytes: 15,
      liveObjectCount: 1,
      softDeletedCount: 1,
      softDeletedBytes: 5,
      missing: { count: 1, sample: [SHA_C] },
      orphans: { count: 1, sample: ['orphan-key'] },
    });
  });

  test('reconcileCasInventory unmarks missing indexed shas and reports orphans', () => {
    const unmarked: string[] = [];
    const state = reconcileCasInventory({
      collection: collection([
        {
          key: `blobs/sha256/${SHA_A}`,
          sizeBytes: 1,
          etagOrHash: SHA_A,
          storedAt: 1,
          state: 'live',
        },
        {
          key: `blobs/sha256/${SHA_B}`,
          sizeBytes: 1,
          etagOrHash: SHA_B,
          storedAt: 1,
          state: 'live',
        },
        {
          key: 'not-a-cas-key',
          sizeBytes: 3,
          etagOrHash: 'x',
          storedAt: 1,
          state: 'live',
        },
      ]),
      live: new Set([SHA_A]),
      indexed: new Set([SHA_A, SHA_C]),
      unmark: (sha) => unmarked.push(sha),
    });
    expect(unmarked).toStrictEqual([SHA_C]);
    expect(state.missing).toStrictEqual({ count: 1, sample: [SHA_C] });
    // SHA_B is remote but not live → orphan; unknown key also folds in.
    expect(state.orphans.count).toBe(2);
    expect(state.orphans.sample.sort()).toStrictEqual([SHA_B, 'not-a-cas-key'].sort());
  });

  test('reconcileCasInventory ignores recently indexed shas and pins snapshot roots', () => {
    const unmarked: string[] = [];
    const state = reconcileCasInventory({
      collection: collection([]),
      live: new Set(),
      indexed: new Set([SHA_A, SHA_B]),
      recentlyIndexed: new Set([SHA_A]),
      snapshotReferenced: new Set([SHA_C]),
      unmark: (sha) => unmarked.push(sha),
    });
    expect(unmarked).toStrictEqual([SHA_B]);
    expect(state.missing.sample.sort()).toStrictEqual([SHA_B, SHA_C].sort());
    expect(state.orphans.count).toBe(0);
  });
});
