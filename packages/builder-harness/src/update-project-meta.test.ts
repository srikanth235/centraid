import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaffoldProject, updateProjectMeta } from './scaffold.js';
import { HarnessError } from './types.js';

describe('updateProjectMeta', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-updatemeta-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('renames an app in place when the name is free', async () => {
    await scaffoldProject(dir, 'todos', { name: 'Todos' });
    await updateProjectMeta(dir, 'todos', { name: 'My Todos' });
    const appJson = JSON.parse(await fs.readFile(path.join(dir, 'todos', 'app.json'), 'utf8')) as {
      name: string;
    };
    assert.equal(appJson.name, 'My Todos');
  });

  it("rejects a rename that collides with another app's display name", async () => {
    await scaffoldProject(dir, 'hydrate', { name: 'Hydrate' });
    await scaffoldProject(dir, 'hydrate-2', { name: 'Hydrate 2' });
    await assert.rejects(
      () => updateProjectMeta(dir, 'hydrate-2', { name: 'Hydrate' }),
      (err) => err instanceof HarnessError && err.code === 'already_exists',
    );
  });

  it('treats display-name comparison as case-insensitive and trimmed', async () => {
    await scaffoldProject(dir, 'hydrate', { name: 'Hydrate' });
    await scaffoldProject(dir, 'hydrate-2', { name: 'Hydrate 2' });
    await assert.rejects(
      () => updateProjectMeta(dir, 'hydrate-2', { name: '  HYDRATE  ' }),
      (err) => err instanceof HarnessError && err.code === 'already_exists',
    );
  });

  it('allows renaming an app to the name it already has', async () => {
    await scaffoldProject(dir, 'hydrate', { name: 'Hydrate' });
    await updateProjectMeta(dir, 'hydrate', { name: 'Hydrate' });
    const appJson = JSON.parse(
      await fs.readFile(path.join(dir, 'hydrate', 'app.json'), 'utf8'),
    ) as { name: string };
    assert.equal(appJson.name, 'Hydrate');
  });

  it('rejects an empty / whitespace-only name', async () => {
    await scaffoldProject(dir, 'todos', { name: 'Todos' });
    await assert.rejects(
      () => updateProjectMeta(dir, 'todos', { name: '   ' }),
      (err) => err instanceof HarnessError && err.code === 'invalid_id',
    );
  });

  it('description-only updates skip the duplicate-name check', async () => {
    await scaffoldProject(dir, 'a', { name: 'Same' });
    await scaffoldProject(dir, 'b', { name: 'Same' });
    // Pre-existing duplicates shouldn't block a description-only patch
    // on either side.
    await updateProjectMeta(dir, 'a', { description: 'updated' });
    const appJson = JSON.parse(await fs.readFile(path.join(dir, 'a', 'app.json'), 'utf8')) as {
      name: string;
      description?: string;
    };
    assert.equal(appJson.name, 'Same');
    assert.equal(appJson.description, 'updated');
  });
});
