import { expect, test } from 'vitest';
import { sectionPhotoAssets, type PhotoAsset } from './timeline-model';

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
