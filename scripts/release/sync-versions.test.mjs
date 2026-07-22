import { describe, expect, it } from 'vitest';
import { patchAndroidVersions, patchIosPbxproj, patchInfoPlist } from './sync-versions.mjs';

describe('sync-versions native patches', () => {
  it('patches android versionCode and versionName', () => {
    const src = `defaultConfig {
        versionCode 1000
        versionName "0.1.0"
    }`;
    const r = patchAndroidVersions(src, '0.2.1', 2001);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('versionCode 2001');
    expect(r.text).toContain('versionName "0.2.1"');
  });

  it('patches ios pbxproj versions', () => {
    const src = `CURRENT_PROJECT_VERSION = 1000;
MARKETING_VERSION = 0.1.0;
CURRENT_PROJECT_VERSION = 1000;
MARKETING_VERSION = 0.1.0;`;
    const r = patchIosPbxproj(src, '1.0.0', 1_000_000);
    expect(r.text).toContain('CURRENT_PROJECT_VERSION = 1000000;');
    expect(r.text).toContain('MARKETING_VERSION = 1.0.0;');
    expect(r.text).not.toContain('0.1.0');
  });

  it('patches Info.plist bundle versions', () => {
    const src = `  <key>CFBundleVersion</key>
  <string>1000</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>`;
    const r = patchInfoPlist(src, '0.3.0', 3000);
    expect(r.ok).toBe(true);
    expect(r.text).toContain('<string>3000</string>');
    expect(r.text).toContain('<string>0.3.0</string>');
  });
});
