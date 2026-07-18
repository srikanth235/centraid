import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  cloneTemplate,
  suggestAppId,
  suggestCloneIdentity,
  suggestCloneIdentityFrom,
} from './clone.js';
import { scaffoldApp } from './scaffold.js';

describe('suggestCloneIdentity', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tempDir('centraid-clone-id-');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns the bare (id, name) on a fresh apps dir', async () => {
    const picked = await suggestCloneIdentity(dir, 'hydrate', 'Hydrate');
    expect(picked.id).toBe('hydrate');
    expect(picked.name).toBe('Hydrate');
  });

  it('returns (id-2, "Name 2") when the bare slot is taken', async () => {
    await scaffoldApp(dir, 'hydrate', { name: 'Hydrate' });
    const picked = await suggestCloneIdentity(dir, 'hydrate', 'Hydrate');
    expect(picked.id).toBe('hydrate-2');
    expect(picked.name).toBe('Hydrate 2');
  });

  it('skips past existing directory ids', async () => {
    await scaffoldApp(dir, 'hydrate', { name: 'Hydrate' });
    await scaffoldApp(dir, 'hydrate-2', { name: 'Some unrelated name' });
    const picked = await suggestCloneIdentity(dir, 'hydrate', 'Hydrate');
    expect(picked.id).toBe('hydrate-3');
    expect(picked.name).toBe('Hydrate 3');
  });

  it('skips past existing display-name collisions even when the id slot is free', async () => {
    // Bare "Hydrate" is taken by an unrelated app. The dir id `hydrate`
    // is also taken by that same scaffold. Then `hydrate-2` is free as a
    // dir but the user renamed yet another app to "Hydrate 2" — bump
    // both to N=3.
    await scaffoldApp(dir, 'hydrate', { name: 'Hydrate' });
    await scaffoldApp(dir, 'something', { name: 'Hydrate 2' });
    const picked = await suggestCloneIdentity(dir, 'hydrate', 'Hydrate');
    expect(picked.id).toBe('hydrate-3');
    expect(picked.name).toBe('Hydrate 3');
  });

  it('keeps id and name advancing together when both classes of collision interleave', async () => {
    // N=1: id+name taken (bare). N=2: id taken. N=3: id free but name
    // taken. N=4: both free.
    await scaffoldApp(dir, 'hydrate', { name: 'Hydrate' });
    await scaffoldApp(dir, 'hydrate-2', { name: 'Hydrate 2' });
    await scaffoldApp(dir, 'whatever', { name: 'Hydrate 3' });
    const picked = await suggestCloneIdentity(dir, 'hydrate', 'Hydrate');
    expect(picked.id).toBe('hydrate-4');
    expect(picked.name).toBe('Hydrate 4');
  });

  it('does case-insensitive display-name comparison', async () => {
    await scaffoldApp(dir, 'x', { name: 'HYDRATE' });
    const picked = await suggestCloneIdentity(dir, 'hydrate', 'Hydrate');
    // Bare name "Hydrate" collides with "HYDRATE" case-insensitively → bump.
    expect(picked.id).toBe('hydrate-2');
    expect(picked.name).toBe('Hydrate 2');
  });
});

describe('suggestCloneIdentityFrom (git-store backend — no filesystem)', () => {
  it('returns the bare (id, name) against an empty set', () => {
    const picked = suggestCloneIdentityFrom([], 'hydrate', 'Hydrate');
    expect(picked).toEqual({ id: 'hydrate', name: 'Hydrate' });
  });

  it('bumps to (id-2, "Name 2") when the bare id is taken', () => {
    const picked = suggestCloneIdentityFrom(
      [{ id: 'hydrate', name: 'Hydrate' }],
      'hydrate',
      'Hydrate',
    );
    expect(picked).toEqual({ id: 'hydrate-2', name: 'Hydrate 2' });
  });

  it('skips a display-name collision even when the id slot is free', () => {
    const picked = suggestCloneIdentityFrom(
      [
        { id: 'hydrate', name: 'Hydrate' },
        { id: 'something', name: 'Hydrate 2' },
      ],
      'hydrate',
      'Hydrate',
    );
    expect(picked).toEqual({ id: 'hydrate-3', name: 'Hydrate 3' });
  });

  it('does case-insensitive display-name comparison', () => {
    const picked = suggestCloneIdentityFrom([{ id: 'x', name: 'HYDRATE' }], 'hydrate', 'Hydrate');
    expect(picked).toEqual({ id: 'hydrate-2', name: 'Hydrate 2' });
  });

  it('falls back to the id for apps with no display name', () => {
    // An app published with no `name` still blocks its own id.
    const picked = suggestCloneIdentityFrom([{ id: 'hydrate' }], 'hydrate', 'Hydrate');
    expect(picked).toEqual({ id: 'hydrate-2', name: 'Hydrate 2' });
  });
});

describe('suggestAppId (sanity — coexists with suggestCloneIdentity)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir('centraid-suggest-id-');
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns the bare id when free and alwaysSuffix is omitted', async () => {
    const id = await suggestAppId(dir, 'todos');
    expect(id).toBe('todos');
  });

  it('always suffixes when alwaysSuffix: true', async () => {
    const id = await suggestAppId(dir, 'todos', { alwaysSuffix: true });
    expect(id).toBe('todos-2');
  });
});

describe('cloneTemplate index.html <title> rewrite', () => {
  let appsDir: string;
  let templateDir: string;

  beforeEach(async () => {
    appsDir = await tempDir('centraid-clone-html-');
    templateDir = await tempDir('centraid-clone-tmpl-');
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
    await fs.rm(appsDir, { recursive: true, force: true });
    await fs.rm(templateDir, { recursive: true, force: true });
  });

  it('rewrites <title> to the new display name', async () => {
    await cloneTemplate({
      appsDir,
      newAppId: 'hydrate-2',
      templateDir,
      newName: 'Hydrate 2',
    });
    const html = await fs.readFile(path.join(appsDir, 'hydrate-2', 'index.html'), 'utf8');
    expect(html).toMatch(/<title>Hydrate 2<\/title>/);
    expect(html).not.toMatch(/>Hydrate</);
  });

  it('HTML-escapes special characters in the new name', async () => {
    await cloneTemplate({
      appsDir,
      newAppId: 'spicy-1',
      templateDir,
      newName: 'Foo & <Bar>',
    });
    const html = await fs.readFile(path.join(appsDir, 'spicy-1', 'index.html'), 'utf8');
    expect(html).toMatch(/<title>Foo &amp; &lt;Bar&gt;<\/title>/);
  });

  it('backfills the catalog tile identity into app.json (template copy predates the keys)', async () => {
    await cloneTemplate({
      appsDir,
      newAppId: 'hydrate-2',
      templateDir,
      newName: 'Hydrate 2',
      iconKey: 'Water',
      colorKey: 'teal',
    });
    const appJson = JSON.parse(
      await fs.readFile(path.join(appsDir, 'hydrate-2', 'app.json'), 'utf8'),
    ) as { iconKey: string; colorKey: string };
    expect(appJson.iconKey).toBe('Water');
    expect(appJson.colorKey).toBe('teal');
  });

  it('keeps the template app.json tile identity over the catalog entry', async () => {
    await fs.writeFile(
      path.join(templateDir, 'app.json'),
      JSON.stringify({ name: 'Hydrate', version: '0.1.0', iconKey: 'Todo', colorKey: 'indigo' }),
    );
    await cloneTemplate({
      appsDir,
      newAppId: 'hydrate-3',
      templateDir,
      newName: 'Hydrate 3',
      iconKey: 'Water',
      colorKey: 'teal',
    });
    const appJson = JSON.parse(
      await fs.readFile(path.join(appsDir, 'hydrate-3', 'app.json'), 'utf8'),
    ) as { iconKey: string; colorKey: string };
    expect(appJson.iconKey).toBe('Todo');
    expect(appJson.colorKey).toBe('indigo');
  });

  it('leaves index.html untouched when no <title> tag exists', async () => {
    await fs.writeFile(
      path.join(templateDir, 'index.html'),
      '<!doctype html><html><body>no head</body></html>',
    );
    await cloneTemplate({
      appsDir,
      newAppId: 'plain-1',
      templateDir,
      newName: 'Plain',
    });
    const html = await fs.readFile(path.join(appsDir, 'plain-1', 'index.html'), 'utf8');
    expect(html).toBe('<!doctype html><html><body>no head</body></html>');
  });

  it('rewrites automation.json#name + stamps generated for automation templates', async () => {
    // Lay down an automation-template-shaped source: app.json + automations/<id>/...
    const templateDir = await tempDir('centraid-auto-tmpl-');
    await fs.writeFile(
      path.join(templateDir, 'app.json'),
      JSON.stringify({ name: 'Briefing', version: '0.1.0' }, null, 2),
    );
    await fs.mkdir(path.join(templateDir, 'automations', 'briefing'), { recursive: true });
    await fs.writeFile(
      path.join(templateDir, 'automations', 'briefing', 'automation.json'),
      JSON.stringify(
        {
          name: 'Briefing',
          version: '0.1.0',
          enabled: false,
          prompt: 'do the thing',
          triggers: [{ kind: 'cron', expr: '0 18 * * 1-5' }],
          requires: {},
          history: { keep: { count: 100 } },
          generated: { by: 'centraid-template', at: '2026-01-01T00:00:00.000Z' },
        },
        null,
        2,
      ),
    );
    await fs.writeFile(
      path.join(templateDir, 'automations', 'briefing', 'handler.js'),
      'export default async () => ({ summary: "ok" });',
    );

    await cloneTemplate({
      appsDir,
      newAppId: 'briefing-2',
      templateDir,
      newName: 'Briefing 2',
    });

    const mf = JSON.parse(
      await fs.readFile(
        path.join(appsDir, 'briefing-2', 'automations', 'briefing', 'automation.json'),
        'utf8',
      ),
    );
    expect(mf.name).toBe('Briefing 2');
    expect(mf.generated.by).toBe('centraid-builder');
    expect(mf.generated.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Other fields carry through unchanged.
    expect(mf.prompt).toBe('do the thing');
    expect(mf.triggers).toEqual([{ kind: 'cron', expr: '0 18 * * 1-5' }]);

    await fs.rm(templateDir, { recursive: true, force: true });
  });

  it('skips silently when the template has no index.html', async () => {
    await fs.rm(path.join(templateDir, 'index.html'));
    // Should not throw — the clone simply doesn't have an index.html.
    await cloneTemplate({
      appsDir,
      newAppId: 'headless-1',
      templateDir,
      newName: 'Headless',
    });
    const files = await fs.readdir(path.join(appsDir, 'headless-1'));
    expect(!files.includes('index.html')).toBeTruthy();
  });
});
