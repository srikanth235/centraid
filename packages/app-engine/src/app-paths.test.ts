import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { isValidAppId, readActiveCodeDir } from './app-paths.js';

function freshAppDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'centraid-app-paths-'));
}

describe('isValidAppId', () => {
  it('accepts plain-slug app folder ids', () => {
    assert.equal(isValidAppId('crm'), true);
    assert.equal(isValidAppId('standup-bot'), true);
    assert.equal(isValidAppId('My_App-2'), true);
  });

  it('rejects dotted / path-unsafe / plugin-internal ids', () => {
    assert.equal(isValidAppId(''), false);
    assert.equal(isValidAppId('_internal'), false);
    assert.equal(isValidAppId('a/b'), false);
    assert.equal(isValidAppId('up..dir'), false);
    // Dots are no longer part of the grammar — the legacy `auto.` prefix
    // is gone; automation apps are marked by the manifest `kind` field.
    assert.equal(isValidAppId('auto.standup-bot'), false);
  });
});

describe('readActiveCodeDir', () => {
  it('returns the versioned subdir when current.json has an activeVersion', async () => {
    const appDir = freshAppDir();
    await fs.writeFile(
      path.join(appDir, 'current.json'),
      JSON.stringify({ activeVersion: 'v_2026-01-01_abc123', history: [] }),
    );
    const codeDir = await readActiveCodeDir(appDir);
    assert.equal(codeDir, path.join(appDir, 'versions', 'v_2026-01-01_abc123'));
  });

  it('falls back to appDir when current.json is missing', async () => {
    const appDir = freshAppDir();
    const codeDir = await readActiveCodeDir(appDir);
    assert.equal(codeDir, appDir);
  });

  it('falls back to appDir when current.json is unparseable', async () => {
    const appDir = freshAppDir();
    await fs.writeFile(path.join(appDir, 'current.json'), '{ not json');
    const codeDir = await readActiveCodeDir(appDir);
    assert.equal(codeDir, appDir);
  });

  it('falls back to appDir when activeVersion is missing or empty', async () => {
    const appDir = freshAppDir();
    await fs.writeFile(path.join(appDir, 'current.json'), JSON.stringify({ history: [] }));
    assert.equal(await readActiveCodeDir(appDir), appDir);

    await fs.writeFile(
      path.join(appDir, 'current.json'),
      JSON.stringify({ activeVersion: '', history: [] }),
    );
    assert.equal(await readActiveCodeDir(appDir), appDir);
  });
});
