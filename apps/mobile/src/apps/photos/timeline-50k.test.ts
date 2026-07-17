import { expect, test } from 'vitest';
import { mergePhotoAssets, sectionPhotoAssets, type PhotoAsset } from './timeline-model';

test('50k seeded assets group inside the one-second cold-grid budget', () => {
  const rows = Array.from(
    { length: 50_000 },
    (_, index): PhotoAsset => ({
      id: `asset-${index}`,
      uri: `file:///asset-${index}.jpg`,
      previewUri: `file:///asset-${index}.jpg`,
      originalUri: `file:///asset-${index}.jpg`,
      capturedAt: new Date(Date.UTC(2026, 6, 16) - index * 60_000).toISOString(),
      kind: 'photo',
      favorite: false,
      archived: false,
      deleted: false,
      backupState: 'backed-up',
      source: 'replica',
    }),
  );
  const started = performance.now();
  const sections = sectionPhotoAssets(rows);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(sections.reduce((total, section) => total + section.assets.length, 0)).toBe(50_000);
});

test('merging 50k device copies against 50k backed-up remotes stays linear', () => {
  const make = (source: PhotoAsset['source']) =>
    Array.from({ length: 50_000 }, (_, index): PhotoAsset => {
      const shared: PhotoAsset = {
        id: `${source}-${index}`,
        uri: `file:///${source}-${index}.jpg`,
        previewUri: `file:///${source}-${index}.jpg`,
        originalUri: `file:///${source}-${index}.jpg`,
        sha256: `sha-${index}`,
        capturedAt: new Date(Date.UTC(2026, 6, 16) - index * 60_000).toISOString(),
        kind: 'photo',
        favorite: false,
        archived: false,
        deleted: false,
        backupState: source === 'replica' ? 'remote-only' : 'local-only',
        source,
      };
      return source === 'device' ? { ...shared, localId: `local-${index}` } : shared;
    });
  const device = make('device');
  const remote = make('replica');
  const started = performance.now();
  const merged = mergePhotoAssets(device, remote);
  // The old indexOf(same) scan was O(n·m); at 50k that is ~2.5B comparisons.
  // A Map keeps every device copy folded onto its remote in well under budget.
  expect(performance.now() - started).toBeLessThan(2_000);
  expect(merged).toHaveLength(50_000);
  expect(merged.every((asset) => asset.source === 'merged')).toBe(true);
});
