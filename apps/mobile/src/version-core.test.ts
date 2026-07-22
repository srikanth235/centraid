import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { nativeBuildNumber } from './version-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mobileRoot = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const { nativeBuildNumber: nativeBuildNumberCjs } = require('./version-core.cjs') as {
  nativeBuildNumber: (version: string) => number;
};

describe('nativeBuildNumber (J6)', () => {
  it('maps semver with the deterministic formula', () => {
    expect(nativeBuildNumber('0.1.0')).toBe(1_000);
    expect(nativeBuildNumber('1.2.3')).toBe(1_002_003);
    expect(nativeBuildNumber('0.0.1')).toBe(1);
  });

  it('CJS twin (Expo app.config path) matches the TS formula', () => {
    for (const v of ['0.1.0', '1.2.3', '0.0.1', '0.2.1-beta.3'] as const) {
      expect(nativeBuildNumberCjs(v)).toBe(nativeBuildNumber(v));
    }
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
    const versions = [...pbx.matchAll(/CURRENT_PROJECT_VERSION = (\d+);/g)]
      .map((m) => m[1])
      .filter((v): v is string => v != null);
    expect(versions.length).toBeGreaterThan(0);
    for (const v of versions) {
      expect(Number(v)).toBe(expected);
    }
    // MARKETING_VERSION must be the app semver everywhere (no leftover "1.0").
    const marketing = [...pbx.matchAll(/MARKETING_VERSION = ([^;]+);/g)]
      .map((m) => m[1])
      .filter((v): v is string => v != null)
      .map((v) => v.trim());
    expect(marketing.length).toBeGreaterThan(0);
    for (const v of marketing) {
      expect(v).toBe('0.1.0');
    }

    // Info.plist CFBundleVersion must match the formula (not a stale 1000000).
    const infoPlist = readFileSync(path.join(mobileRoot, 'ios/Centraid/Info.plist'), 'utf8');
    const cfBundleVersion = infoPlist.match(
      /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/,
    )?.[1];
    expect(cfBundleVersion).toBe(String(expected));
    const shortVersion = infoPlist.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
    )?.[1];
    expect(shortVersion).toBe('0.1.0');

    const configSrc = readFileSync(path.join(mobileRoot, 'app.config.ts'), 'utf8');
    expect(configSrc).toContain('nativeBuildNumber(VERSION)');
    // Version is single-sourced from package.json (issue #501), not hardcoded.
    expect(configSrc).toContain("join(mobileRoot, 'package.json')");
    const pkgVersion = JSON.parse(readFileSync(path.join(mobileRoot, 'package.json'), 'utf8'))
      .version as string;
    expect(pkgVersion).toBe('0.1.0');
    // Expo CJS resolve — must import the .cjs twin, not extensionless TS.
    expect(configSrc).toMatch(/from ['"]\.\/src\/version-core\.cjs['"]/);
  });
});
