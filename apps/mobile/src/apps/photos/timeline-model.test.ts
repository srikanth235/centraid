import { describe, expect, test } from 'vitest';
import {
  addDragSelection,
  mergePhotoAssets,
  onThisDay,
  sectionPhotoAssets,
  type PhotoAsset,
} from './timeline-model';

const photo = (id: string, fields: Partial<PhotoAsset> = {}): PhotoAsset => ({
  id,
  uri: id,
  previewUri: id,
  originalUri: id,
  capturedAt: '2025-07-16T10:00:00.000Z',
  kind: 'photo',
  favorite: false,
  archived: false,
  deleted: false,
  backupState: 'local-only',
  source: 'device',
  ...fields,
});

describe('native Photos timeline model', () => {
  test('sha merges device and replica identities while dHash only marks a review hint', () => {
    const remote = photo('remote', {
      sha256: 'exact',
      phash: 'similar',
      source: 'replica',
      backupState: 'remote-only',
    });
    const rows = mergePhotoAssets(
      [photo('same', { localId: 'local-1', sha256: 'exact' }), photo('hint', { phash: 'similar' })],
      [remote],
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === 'remote')).toMatchObject({
      source: 'merged',
      localId: 'local-1',
    });
    expect(rows.find((row) => row.id === 'hint')).toMatchObject({
      duplicateHint: true,
      source: 'device',
    });
  });

  test('two device copies of one sha fold onto a single row, both reachable', () => {
    const rows = mergePhotoAssets(
      [
        photo('copy-a', { localId: 'local-a', sha256: 'exact' }),
        photo('copy-b', { localId: 'local-b', sha256: 'exact' }),
      ],
      [photo('remote', { sha256: 'exact', source: 'replica', backupState: 'remote-only' })],
    );
    // The second copy must not be dropped (the old indexOf(-1) bug), and both
    // localIds must survive so free-up-space can reach every device original.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'merged', localId: 'local-a' });
    expect(rows[0]?.localIds).toEqual(['local-a', 'local-b']);
  });

  test('sections by capture-local day using tzOffsetMin, not the raw UTC slice', () => {
    // 03:00 UTC in PDT (-420 min) is the previous evening, so it files a day earlier.
    const sections = sectionPhotoAssets([
      photo('evening', { capturedAt: '2026-07-16T03:00:00.000Z', tzOffsetMin: -420 }),
    ]);
    expect(sections[0]?.day).toBe('2026-07-15');
  });

  test('archive and trash never appear in timeline sections', () => {
    expect(
      sectionPhotoAssets([
        photo('live'),
        photo('archive', { archived: true }),
        photo('trash', { deleted: true }),
      ]),
    ).toHaveLength(1);
    expect(sectionPhotoAssets([photo('live')])[0]?.assets.map((row) => row.id)).toEqual(['live']);
  });

  test('day sections carry stable month groups for the timeline rail', () => {
    const sections = sectionPhotoAssets([
      photo('july'),
      photo('june', { capturedAt: '2025-06-30T10:00:00.000Z' }),
    ]);
    expect(sections.map((section) => section.month)).toEqual(['2025-07', '2025-06']);
    expect(sections[0]?.monthTitle).toContain('2025');
  });

  test('coalesces HEIC and MOV capture companions into one logical timeline asset', () => {
    const rows = mergePhotoAssets(
      [],
      [
        photo('still', { captureGroupId: 'live:1', originalUri: 'still.heic' }),
        photo('motion', {
          captureGroupId: 'live:1',
          kind: 'video',
          originalUri: 'motion.mov',
        }),
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'still', liveVideoUri: 'motion.mov' });
  });

  test('memories are prior years on the same calendar day', () => {
    expect(
      onThisDay(
        [photo('old'), photo('today', { capturedAt: '2026-07-16T10:00:00.000Z' })],
        new Date('2026-07-16T12:00:00Z'),
      ).map((row) => row.id),
    ).toEqual(['old']);
  });

  test('drag selection accumulates every asset reached during one gesture', () => {
    const afterFirst = addDragSelection(new Set(['before']), 'first');
    const afterSecond = addDragSelection(afterFirst, 'second');
    expect([...afterSecond]).toEqual(['before', 'first', 'second']);
  });
});
