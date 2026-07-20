import { describe, expect, it } from 'vitest';
import { nativeBuildNumber } from './version-core.js';

describe('nativeBuildNumber (J6)', () => {
  it('maps semver with the deterministic formula', () => {
    expect(nativeBuildNumber('0.1.0')).toBe(1_000);
    expect(nativeBuildNumber('1.2.3')).toBe(1_002_003);
    expect(nativeBuildNumber('0.0.1')).toBe(1);
  });

  it('ignores prerelease suffix in the first three numbers', () => {
    expect(nativeBuildNumber('0.2.1-beta.3')).toBe(2_001);
  });

  it('rejects garbage', () => {
    expect(() => nativeBuildNumber('nope')).toThrow(/unparseable/);
  });
});
