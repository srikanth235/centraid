import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readAppSettings,
  readAppSetting,
  writeAppSetting,
  deleteAppSetting,
  automationEnabledKey,
  APP_SETTINGS_FILE,
} from './app-settings.js';

function newAppDir(): string {
  return tempDirSync('centraid-app-settings-');
}

describe('readAppSettings', () => {
  it('returns {} when the app dir has no settings.json', () => {
    expect(readAppSettings('/nonexistent/app/dir')).toEqual({});
    expect(readAppSettings(newAppDir())).toEqual({});
  });

  it('reads the JSON object', () => {
    const dir = newAppDir();
    writeFileSync(join(dir, APP_SETTINGS_FILE), JSON.stringify({ theme: 'light', bgL: 12 }));
    const out = readAppSettings(dir);
    expect(out.theme).toBe('light');
    expect(out.bgL).toBe(12);
  });

  it('treats malformed or non-object JSON as empty (never throws)', () => {
    const dir = newAppDir();
    writeFileSync(join(dir, APP_SETTINGS_FILE), 'not json{');
    expect(readAppSettings(dir)).toEqual({});
    writeFileSync(join(dir, APP_SETTINGS_FILE), JSON.stringify([1, 2]));
    expect(readAppSettings(dir)).toEqual({});
  });
});

describe('readAppSetting / writeAppSetting / deleteAppSetting', () => {
  it('round-trips a scalar through write → read', () => {
    const dir = newAppDir();
    writeAppSetting(dir, 'theme', 'dark');
    expect(readAppSetting(dir, 'theme')).toBe('dark');
  });

  it('round-trips an object', () => {
    const dir = newAppDir();
    writeAppSetting(dir, 'pref', { a: 1, b: 'two' });
    expect(readAppSetting(dir, 'pref')).toEqual({ a: 1, b: 'two' });
  });

  it('write creates settings.json on demand and keeps other keys', () => {
    const dir = newAppDir();
    writeAppSetting(dir, 'first', true);
    writeAppSetting(dir, 'second', 2);
    expect(readAppSetting(dir, 'first')).toBe(true);
    const raw = JSON.parse(readFileSync(join(dir, APP_SETTINGS_FILE), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(raw).toEqual({ first: true, second: 2 });
  });

  it('overwrites on second write to the same key', () => {
    const dir = newAppDir();
    writeAppSetting(dir, 'k', 1);
    writeAppSetting(dir, 'k', 2);
    expect(readAppSetting(dir, 'k')).toBe(2);
  });

  it('returns undefined for missing key / file', () => {
    expect(readAppSetting('/nonexistent/app/dir', 'k')).toBe(undefined);
    const dir = newAppDir();
    expect(readAppSetting(dir, 'k')).toBe(undefined); // no file yet
    writeAppSetting(dir, 'other', 1);
    expect(readAppSetting(dir, 'missing')).toBe(undefined); // file exists, key doesn't
  });

  it('delete removes the key; subsequent read is undefined', () => {
    const dir = newAppDir();
    writeAppSetting(dir, 'k', 'v');
    expect(readAppSetting(dir, 'k')).toBe('v');
    deleteAppSetting(dir, 'k');
    expect(readAppSetting(dir, 'k')).toBe(undefined);
  });

  it('delete is a no-op when file / key is missing', () => {
    // None of these should throw; missing path/key leaves state unchanged.
    expect(() => deleteAppSetting('/nonexistent/app/dir', 'k')).not.toThrow();
    const dir = newAppDir();
    expect(() => deleteAppSetting(dir, 'k')).not.toThrow(); // no file yet
    writeAppSetting(dir, 'other', 1);
    expect(() => deleteAppSetting(dir, 'k')).not.toThrow(); // file exists, key doesn't
    expect(readAppSetting(dir, 'other')).toBe(1);
    expect(readAppSetting(dir, 'k')).toBeUndefined();
  });

  it('automationEnabledKey builds the reserved key shape', () => {
    expect(automationEnabledKey('weekly-recap')).toBe('__automation.weekly-recap.enabled');
  });

  it('automation toggle round-trips through the helpers', () => {
    const dir = newAppDir();
    writeAppSetting(dir, automationEnabledKey('weekly-recap'), false);
    expect(readAppSetting(dir, automationEnabledKey('weekly-recap'))).toBe(false);
    writeAppSetting(dir, automationEnabledKey('weekly-recap'), true);
    expect(readAppSetting(dir, automationEnabledKey('weekly-recap'))).toBe(true);
  });
});
