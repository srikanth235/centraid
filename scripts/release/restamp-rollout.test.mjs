import { describe, expect, it } from 'vitest';
import { restampReleaseDate } from './restamp-rollout.mjs';

describe('restampReleaseDate (I8)', () => {
  const now = Date.parse('2026-07-22T12:00:00.000Z');

  it('rewrites existing releaseDate earlier by hours (widen admit)', () => {
    const yml = "version: 0.2.0\npath: x.zip\nreleaseDate: '2026-07-22T12:00:00.000Z'\n";
    const { text, releaseDate } = restampReleaseDate(yml, 72, now);
    expect(releaseDate).toBe('2026-07-19T12:00:00.000Z');
    expect(text).toContain(`releaseDate: '${releaseDate}'`);
    expect(text).toContain('version: 0.2.0');
  });

  it('appends releaseDate when missing', () => {
    const yml = 'version: 0.2.0\npath: x.zip\n';
    const { text, releaseDate } = restampReleaseDate(yml, 0, now);
    expect(releaseDate).toBe('2026-07-22T12:00:00.000Z');
    expect(text).toMatch(/releaseDate:/);
  });

  it('rejects negative hours', () => {
    expect(() => restampReleaseDate('version: 1\n', -1, now)).toThrow(/hours/);
  });
});
