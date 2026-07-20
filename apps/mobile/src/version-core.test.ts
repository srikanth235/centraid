import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nativeBuildNumber } from './version-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');

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

  it('matches the shipped native project numbers for 0.1.0', () => {
    // Formula is the single source; app.config.ts + android/ios must track it.
    const expected = nativeBuildNumber('0.1.0');
    expect(expected).toBe(1_000);

    const gradle = readFileSync(path.join(mobileRoot, 'android/app/build.gradle'), 'utf8');
    expect(gradle).toMatch(new RegExp(`versionCode\\s+${expected}\\b`));
    expect(gradle).toMatch(/versionName\s+"0\.1\.0"/);

    const pbx = readFileSync(
      path.join(mobileRoot, 'ios/Centraid.xcodeproj/project.pbxproj'),
      'utf8',
    );
    // Every CURRENT_PROJECT_VERSION must equal the formula (no leftover "1").
    const versions = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)].map((m) => m[1]);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect(Number(v)).toBe(expected);
    }

    const configSrc = readFileSync(path.join(mobileRoot, 'app.config.ts'), 'utf8');
    expect(configSrc).toContain('nativeBuildNumber(VERSION)');
    expect(configSrc).toContain("const VERSION = '0.1.0'");
  });
});
