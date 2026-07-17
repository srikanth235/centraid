import { describe, expect, test } from 'vitest';
import {
  revalidateBackedUp,
  selectFreeUpCandidates,
  type DeviceByteProbe,
  type FreeUpCandidate,
} from './free-up-space';
import type { PhotoAsset } from './timeline-model';

const backedUp = (id: string, fields: Partial<PhotoAsset> = {}): PhotoAsset => ({
  id,
  assetId: `asset-${id}`,
  uri: id,
  previewUri: id,
  originalUri: id,
  localId: `local-${id}`,
  localIds: [`local-${id}`],
  sha256: `sha-${id}`,
  capturedAt: '2025-07-16T10:00:00.000Z',
  kind: 'photo',
  fileSize: 1_000,
  favorite: false,
  archived: false,
  deleted: false,
  backupState: 'backed-up',
  verifiedCasAck: true,
  source: 'merged',
  ...fields,
});

describe('free-up-space eligibility', () => {
  test('selects only verifiably backed-up, unprotected copies', () => {
    const candidates = selectFreeUpCandidates(
      [
        backedUp('ok'),
        backedUp('unverified', { verifiedCasAck: false }),
        backedUp('remoteOnly', { source: 'replica', localId: undefined, localIds: [] }),
        backedUp('queued', { backupState: 'queued' }),
        backedUp('pinned'),
      ],
      new Set(['asset-pinned']),
    );
    expect(candidates.map((candidate) => candidate.assetId)).toEqual(['asset-ok']);
  });

  test('collects every device copy of one backed-up sha', () => {
    const [candidate] = selectFreeUpCandidates(
      [backedUp('dup', { localIds: ['local-a', 'local-b'] })],
      new Set(),
    );
    expect(candidate?.localIds).toEqual(['local-a', 'local-b']);
  });

  test('revalidation keeps matches and excludes bytes that changed since backup', async () => {
    const candidates: FreeUpCandidate[] = [
      { assetId: 'a', localIds: ['stable', 'edited', 'gone'], sha256: 'sha-a', fileSize: 10 },
    ];
    const probe: DeviceByteProbe = async (localId) =>
      localId === 'stable'
        ? { sha256: 'sha-a', size: 42 }
        : localId === 'edited'
          ? { sha256: 'sha-DIFFERENT', size: 99 } // edited in place after backup
          : null; // OS no longer has the copy
    const result = await revalidateBackedUp(candidates, probe);
    expect(result.deletableLocalIds).toEqual(['stable']);
    expect(result.eligibleBytes).toBe(42);
    expect(result.changedCount).toBe(1);
    expect(result.missingCount).toBe(1);
  });

  test('a probe failure is treated as missing, never as deletable', async () => {
    const result = await revalidateBackedUp(
      [{ assetId: 'a', localIds: ['boom'], sha256: 'sha-a', fileSize: 5 }],
      async () => {
        throw new Error('read failed');
      },
    );
    expect(result.deletableLocalIds).toEqual([]);
    expect(result.missingCount).toBe(1);
  });
});
