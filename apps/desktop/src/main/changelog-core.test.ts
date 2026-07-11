import { describe, expect, it } from 'vitest';
import { normalizeReleases } from './changelog-core.js';

describe('normalizeReleases', () => {
  it('maps the GitHub fields the modal renders', () => {
    const [r] = normalizeReleases([
      {
        tag_name: 'v0.2.0',
        name: 'Sharper sync',
        body: '### Fixed\n- a bug',
        published_at: '2026-07-09T10:00:00Z',
        html_url: 'https://github.com/x/y/releases/tag/v0.2.0',
        prerelease: false,
        draft: false,
      },
    ]);
    expect(r).toEqual({
      version: 'v0.2.0',
      title: 'Sharper sync',
      notes: '### Fixed\n- a bug',
      publishedAt: '2026-07-09T10:00:00Z',
      url: 'https://github.com/x/y/releases/tag/v0.2.0',
      prerelease: false,
    });
  });

  it('preserves GitHub newest-first order', () => {
    const out = normalizeReleases([
      { tag_name: 'v0.3.0' },
      { tag_name: 'v0.2.0' },
      { tag_name: 'v0.1.0' },
    ]);
    expect(out.map((r) => r.version)).toEqual(['v0.3.0', 'v0.2.0', 'v0.1.0']);
  });

  it('drops drafts', () => {
    const out = normalizeReleases([
      { tag_name: 'v0.2.0', draft: true },
      { tag_name: 'v0.1.0', draft: false },
    ]);
    expect(out.map((r) => r.version)).toEqual(['v0.1.0']);
  });

  it('drops entries with no usable label', () => {
    const out = normalizeReleases([{ body: 'notes but no tag or name' }, { tag_name: 'v0.1.0' }]);
    expect(out.map((r) => r.version)).toEqual(['v0.1.0']);
  });

  it('falls back tag<->name and normalizes missing fields', () => {
    const [byName, byTag] = normalizeReleases([{ name: 'Named only' }, { tag_name: 'v1.0.0' }]);
    expect(byName).toMatchObject({ version: 'Named only', title: 'Named only' });
    expect(byTag).toMatchObject({
      version: 'v1.0.0',
      title: 'v1.0.0',
      notes: '',
      publishedAt: null,
      url: '',
      prerelease: false,
    });
  });

  it('marks prereleases', () => {
    const [r] = normalizeReleases([{ tag_name: 'v0.2.0-rc.1', prerelease: true }]);
    expect(r.prerelease).toBe(true);
  });

  it('returns [] for non-array / junk input', () => {
    expect(normalizeReleases(null)).toEqual([]);
    expect(normalizeReleases({ message: 'Not Found' })).toEqual([]);
    expect(normalizeReleases('nope')).toEqual([]);
  });
});
