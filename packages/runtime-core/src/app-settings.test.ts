import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readAppSettings, APP_SETTINGS_TABLE } from './app-settings.js';

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
