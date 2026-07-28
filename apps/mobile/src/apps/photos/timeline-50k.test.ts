import { describe, expect, test } from 'vitest';

import { mergePhotoAssets, sectionPhotoAssets, type PhotoAsset } from './timeline-model';

function measureCpuMs<T>(run: () => T): { value: T; elapsedMs: number } {
  // This package runs alongside several other affected packages in PR checks.
  // CPU time preserves the checked algorithm budget without counting time the
  // OS deschedules this worker under concurrent CI load.
  const started = process.cpuUsage();
  const value = run();
  const elapsed = process.cpuUsage(started);
  return { value, elapsedMs: (elapsed.user + elapsed.system) / 1_000 };
}

describe('timeline-50k', () => {
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
    const { value: sections, elapsedMs } = measureCpuMs(() => sectionPhotoAssets(rows));
    expect(elapsedMs).toBeLessThan(1_000);
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
    const { value: merged, elapsedMs } = measureCpuMs(() => mergePhotoAssets(device, remote));
    // The old indexOf(same) scan was O(n·m); at 50k that is ~2.5B comparisons.
    // A Map keeps every device copy folded onto its remote in well under budget.
    expect(elapsedMs).toBeLessThan(2_000);
    expect(merged).toHaveLength(50_000);
    expect(merged.every((asset) => asset.source === 'merged')).toBe(true);
  });
});
