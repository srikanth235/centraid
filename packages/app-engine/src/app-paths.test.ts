import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { readActiveCodeDir } from './app-paths.js';

function freshAppDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'centraid-app-paths-'));
}

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
