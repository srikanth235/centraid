import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  readAppSettings,
  readAppSetting,
  writeAppSetting,
  deleteAppSetting,
  automationEnabledKey,
  APP_SETTINGS_TABLE,
} from './app-settings.js';

function newDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-app-settings-'));
  return join(dir, 'data.sqlite');
}

describe('readAppSettings', () => {
  it('returns {} when the file does not exist', () => {
    assert.deepEqual(readAppSettings('/nonexistent/path/to/db.sqlite'), {});
  });

  it('returns {} when the table is missing', () => {
    const file = newDbPath();
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE other (id INTEGER PRIMARY KEY)`);
    db.close();
    assert.deepEqual(readAppSettings(file), {});
  });

  it('reads and JSON-decodes rows', () => {
    const file = newDbPath();
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE ${APP_SETTINGS_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ${APP_SETTINGS_TABLE} VALUES (?, ?)`).run(
      'theme',
      JSON.stringify('light'),
    );
    db.prepare(`INSERT INTO ${APP_SETTINGS_TABLE} VALUES (?, ?)`).run('bgL', JSON.stringify(12));
    db.close();
    const out = readAppSettings(file);
    assert.equal(out.theme, 'light');
    assert.equal(out.bgL, 12);
  });

  it('skips rows with malformed JSON', () => {
    const file = newDbPath();
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE ${APP_SETTINGS_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(`INSERT INTO ${APP_SETTINGS_TABLE} VALUES (?, ?)`).run('good', JSON.stringify(1));
    db.prepare(`INSERT INTO ${APP_SETTINGS_TABLE} VALUES (?, ?)`).run('bad', 'not json{');
    db.close();
    const out = readAppSettings(file);
    assert.equal(out.good, 1);
    assert.equal(out.bad, undefined);
  });
});

describe('readAppSetting / writeAppSetting / deleteAppSetting', () => {
  it('round-trips a scalar through write → read', () => {
    const file = newDbPath();
    writeAppSetting(file, 'theme', 'dark');
    assert.equal(readAppSetting(file, 'theme'), 'dark');
  });

  it('round-trips an object', () => {
    const file = newDbPath();
    writeAppSetting(file, 'pref', { a: 1, b: 'two' });
    assert.deepEqual(readAppSetting(file, 'pref'), { a: 1, b: 'two' });
  });

  it('write creates the table on demand', () => {
    const file = newDbPath();
    // No table beforehand — write must succeed and create it.
    writeAppSetting(file, 'first', true);
    assert.equal(readAppSetting(file, 'first'), true);
  });

  it('overwrites on second write to the same key', () => {
    const file = newDbPath();
    writeAppSetting(file, 'k', 1);
    writeAppSetting(file, 'k', 2);
    assert.equal(readAppSetting(file, 'k'), 2);
  });

  it('returns undefined for missing key / file / table', () => {
    assert.equal(readAppSetting('/nonexistent/db.sqlite', 'k'), undefined);
    const file = newDbPath();
    assert.equal(readAppSetting(file, 'k'), undefined); // no DB yet
    writeAppSetting(file, 'other', 1); // creates the table
    assert.equal(readAppSetting(file, 'missing'), undefined); // table exists, key doesn't
  });

  it('delete removes the row; subsequent read is undefined', () => {
    const file = newDbPath();
    writeAppSetting(file, 'k', 'v');
    assert.equal(readAppSetting(file, 'k'), 'v');
    deleteAppSetting(file, 'k');
    assert.equal(readAppSetting(file, 'k'), undefined);
  });

  it('delete is a no-op when DB / table / key is missing', () => {
    // None of these should throw.
    deleteAppSetting('/nonexistent/db.sqlite', 'k');
    const file = newDbPath();
    deleteAppSetting(file, 'k'); // no DB yet
    writeAppSetting(file, 'other', 1);
    deleteAppSetting(file, 'k'); // table exists, key doesn't
  });

  it('automationEnabledKey builds the reserved key shape', () => {
    assert.equal(automationEnabledKey('weekly-recap'), '__automation.weekly-recap.enabled');
  });

  it('automation toggle round-trips through the helpers', () => {
    const file = newDbPath();
    writeAppSetting(file, automationEnabledKey('weekly-recap'), false);
    assert.equal(readAppSetting(file, automationEnabledKey('weekly-recap')), false);
    writeAppSetting(file, automationEnabledKey('weekly-recap'), true);
    assert.equal(readAppSetting(file, automationEnabledKey('weekly-recap')), true);
  });
});
