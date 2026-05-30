import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffoldApp, updateAppMeta } from './scaffold.js';
import { HarnessError } from './types.js';

describe('updateAppMeta', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-updatemeta-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('renames an app in place when the name is free', async () => {
    await scaffoldApp(dir, 'todos', { name: 'Todos' });
    await updateAppMeta(dir, 'todos', { name: 'My Todos' });
    const appJson = JSON.parse(await fs.readFile(path.join(dir, 'todos', 'app.json'), 'utf8')) as {
      name: string;
    };
    assert.equal(appJson.name, 'My Todos');
  });

  it("rejects a rename that collides with another app's display name", async () => {
    await scaffoldApp(dir, 'hydrate', { name: 'Hydrate' });
    await scaffoldApp(dir, 'hydrate-2', { name: 'Hydrate 2' });
    await assert.rejects(
      () => updateAppMeta(dir, 'hydrate-2', { name: 'Hydrate' }),
      (err) => err instanceof HarnessError && err.code === 'already_exists',
    );
  });

  it('treats display-name comparison as case-insensitive and trimmed', async () => {
    await scaffoldApp(dir, 'hydrate', { name: 'Hydrate' });
    await scaffoldApp(dir, 'hydrate-2', { name: 'Hydrate 2' });
    await assert.rejects(
      () => updateAppMeta(dir, 'hydrate-2', { name: '  HYDRATE  ' }),
      (err) => err instanceof HarnessError && err.code === 'already_exists',
    );
  });

  it('allows renaming an app to the name it already has', async () => {
    await scaffoldApp(dir, 'hydrate', { name: 'Hydrate' });
    await updateAppMeta(dir, 'hydrate', { name: 'Hydrate' });
    const appJson = JSON.parse(
      await fs.readFile(path.join(dir, 'hydrate', 'app.json'), 'utf8'),
    ) as { name: string };
    assert.equal(appJson.name, 'Hydrate');
  });

  it('rejects an empty / whitespace-only name', async () => {
    await scaffoldApp(dir, 'todos', { name: 'Todos' });
    await assert.rejects(
      () => updateAppMeta(dir, 'todos', { name: '   ' }),
      (err) => err instanceof HarnessError && err.code === 'invalid_id',
    );
  });

  it('description-only updates skip the duplicate-name check', async () => {
    await scaffoldApp(dir, 'a', { name: 'Same' });
    await scaffoldApp(dir, 'b', { name: 'Same' });
    // Pre-existing duplicates shouldn't block a description-only patch
    // on either side.
    await updateAppMeta(dir, 'a', { description: 'updated' });
    const appJson = JSON.parse(await fs.readFile(path.join(dir, 'a', 'app.json'), 'utf8')) as {
      name: string;
      description?: string;
    };
    assert.equal(appJson.name, 'Same');
    assert.equal(appJson.description, 'updated');
  });

  it("propagates rename to index.html's <title> tag", async () => {
    // scaffoldApp lays down an index.html with `<title>Todos</title>`
    // (the seeded display name). Renaming should sync the title.
    await scaffoldApp(dir, 'todos', { name: 'Todos' });
    const before = await fs.readFile(path.join(dir, 'todos', 'index.html'), 'utf8');
    assert.match(before, /<title>Todos<\/title>/);

    await updateAppMeta(dir, 'todos', { name: 'My Cups' });

    const after = await fs.readFile(path.join(dir, 'todos', 'index.html'), 'utf8');
    assert.match(after, /<title>My Cups<\/title>/);
    assert.doesNotMatch(after, /<title>Todos<\/title>/);
  });

  it('propagates rename to automations/<sub>/automation.json#name', async () => {
    // An automation-app-shaped app: app.json + an automation
    // manifest sitting under automations/<sub>/automation.json. Both
    // names start at "Briefing"; rename should sync both.
    const appId = 'briefing';
    await fs.mkdir(path.join(dir, appId, 'automations', 'briefing'), { recursive: true });
    await fs.writeFile(
      path.join(dir, appId, 'app.json'),
      JSON.stringify({ name: 'Briefing', version: '0.1.0' }, null, 2),
    );
    const originalGenerated = { by: 'centraid-template', at: '2026-01-01T00:00:00.000Z' };
    await fs.writeFile(
      path.join(dir, appId, 'automations', 'briefing', 'automation.json'),
      JSON.stringify({ name: 'Briefing', prompt: 'do', generated: originalGenerated }, null, 2),
    );

    await updateAppMeta(dir, appId, { name: 'Morning Briefing' });

    const appJson = JSON.parse(await fs.readFile(path.join(dir, appId, 'app.json'), 'utf8')) as {
      name: string;
    };
    assert.equal(appJson.name, 'Morning Briefing');

    const manifest = JSON.parse(
      await fs.readFile(
        path.join(dir, appId, 'automations', 'briefing', 'automation.json'),
        'utf8',
      ),
    ) as { name: string; prompt: string; generated: { by: string; at: string } };
    assert.equal(manifest.name, 'Morning Briefing');
    // Rename must NOT re-stamp `generated`: that's clone-time metadata,
    // not "last rename time".
    assert.deepEqual(manifest.generated, originalGenerated);
    // Unrelated fields carry through.
    assert.equal(manifest.prompt, 'do');
  });

  it("rename is a no-op on subordinate files that don't exist", async () => {
    // A bare app with only app.json — no index.html, no
    // automations/. Rename must not throw, and must not create either.
    const appId = 'bare';
    await fs.mkdir(path.join(dir, appId));
    await fs.writeFile(
      path.join(dir, appId, 'app.json'),
      JSON.stringify({ name: 'Bare', version: '0.1.0' }, null, 2),
    );
    await updateAppMeta(dir, appId, { name: 'Renamed' });
    const entries = await fs.readdir(path.join(dir, appId));
    assert.deepEqual(entries.sort(), ['app.json']);
  });
});
