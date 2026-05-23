import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneTemplate, suggestAppId, suggestCloneIdentity } from './clone.js';
import { scaffoldProject } from './scaffold.js';

describe('suggestCloneIdentity', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-clone-id-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns (id-2, "Name 2") on a fresh projects dir', async () => {
    const picked = await suggestCloneIdentity(dir, 'hydrate', 'Hydrate');
    assert.equal(picked.id, 'hydrate-2');
    assert.equal(picked.name, 'Hydrate 2');
  });

  it('skips past existing directory ids', async () => {
    await scaffoldProject(dir, 'hydrate-2', { name: 'Some unrelated name' });
    const picked = await suggestCloneIdentity(dir, 'hydrate', 'Hydrate');
    assert.equal(picked.id, 'hydrate-3');
    assert.equal(picked.name, 'Hydrate 3');
  });

  it('skips past existing display-name collisions even when the id slot is free', async () => {
    // The user previously renamed an unrelated app to "Hydrate 2". The
    // dir id `hydrate-2` is free, but the name is taken — bump both to
    // the next free slot so id and name stay visually paired.
    await scaffoldProject(dir, 'something', { name: 'Hydrate 2' });
    const picked = await suggestCloneIdentity(dir, 'hydrate', 'Hydrate');
    assert.equal(picked.id, 'hydrate-3');
    assert.equal(picked.name, 'Hydrate 3');
  });

  it('keeps id and name advancing together when both classes of collision interleave', async () => {
    // N=2: id taken. N=3: id free but name taken. N=4: both free.
    await scaffoldProject(dir, 'hydrate-2', { name: 'Hydrate 2' });
    await scaffoldProject(dir, 'whatever', { name: 'Hydrate 3' });
    const picked = await suggestCloneIdentity(dir, 'hydrate', 'Hydrate');
    assert.equal(picked.id, 'hydrate-4');
    assert.equal(picked.name, 'Hydrate 4');
  });

  it('does case-insensitive display-name comparison', async () => {
    await scaffoldProject(dir, 'x', { name: 'HYDRATE 2' });
    const picked = await suggestCloneIdentity(dir, 'hydrate', 'Hydrate');
    assert.equal(picked.id, 'hydrate-3');
    assert.equal(picked.name, 'Hydrate 3');
  });
});

describe('suggestAppId (sanity — coexists with suggestCloneIdentity)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-suggest-id-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns the bare id when free and alwaysSuffix is omitted', async () => {
    const id = await suggestAppId(dir, 'todos');
    assert.equal(id, 'todos');
  });

  it('always suffixes when alwaysSuffix: true', async () => {
    const id = await suggestAppId(dir, 'todos', { alwaysSuffix: true });
    assert.equal(id, 'todos-2');
  });
});

describe('cloneTemplate index.html <title> rewrite', () => {
  let projectsDir: string;
  let templateDir: string;

  beforeEach(async () => {
    projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-clone-html-'));
    templateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-clone-tmpl-'));
    // Minimal template: app.json + index.html with a hardcoded title.
    await fs.writeFile(
      path.join(templateDir, 'app.json'),
      JSON.stringify({ name: 'Hydrate', version: '0.1.0' }, null, 2),
    );
    await fs.writeFile(
      path.join(templateDir, 'index.html'),
      '<!doctype html><html><head><title>Hydrate</title></head><body></body></html>',
    );
  });
  afterEach(async () => {
    await fs.rm(projectsDir, { recursive: true, force: true });
    await fs.rm(templateDir, { recursive: true, force: true });
  });

  it('rewrites <title> to the new display name', async () => {
    await cloneTemplate({
      projectsDir,
      newAppId: 'hydrate-2',
      templateDir,
      newName: 'Hydrate 2',
    });
    const html = await fs.readFile(path.join(projectsDir, 'hydrate-2', 'index.html'), 'utf8');
    assert.match(html, /<title>Hydrate 2<\/title>/);
    assert.doesNotMatch(html, />Hydrate</);
  });

  it('HTML-escapes special characters in the new name', async () => {
    await cloneTemplate({
      projectsDir,
      newAppId: 'spicy-1',
      templateDir,
      newName: 'Foo & <Bar>',
    });
    const html = await fs.readFile(path.join(projectsDir, 'spicy-1', 'index.html'), 'utf8');
    assert.match(html, /<title>Foo &amp; &lt;Bar&gt;<\/title>/);
  });

  it('leaves index.html untouched when no <title> tag exists', async () => {
    await fs.writeFile(
      path.join(templateDir, 'index.html'),
      '<!doctype html><html><body>no head</body></html>',
    );
    await cloneTemplate({
      projectsDir,
      newAppId: 'plain-1',
      templateDir,
      newName: 'Plain',
    });
    const html = await fs.readFile(path.join(projectsDir, 'plain-1', 'index.html'), 'utf8');
    assert.equal(html, '<!doctype html><html><body>no head</body></html>');
  });

  it('skips silently when the template has no index.html', async () => {
    await fs.rm(path.join(templateDir, 'index.html'));
    // Should not throw — the clone simply doesn't have an index.html.
    await cloneTemplate({
      projectsDir,
      newAppId: 'headless-1',
      templateDir,
      newName: 'Headless',
    });
    const files = await fs.readdir(path.join(projectsDir, 'headless-1'));
    assert.ok(!files.includes('index.html'));
  });
});
