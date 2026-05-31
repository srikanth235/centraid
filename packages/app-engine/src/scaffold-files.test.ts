import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { scaffoldAppFiles, updateAppMetaFiles, type ScaffoldFile } from './scaffold-files.js';
import { cloneTemplateFiles } from './clone.js';

function byPath(files: ScaffoldFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe('scaffoldAppFiles', () => {
  it('emits the canonical file set with the id/name baked in', () => {
    const files = byPath(scaffoldAppFiles('todos', { name: 'Todos' }));
    assert.ok(files.has('package.json'));
    assert.ok(files.has('app.json'));
    assert.ok(files.has('index.html'));
    assert.ok(files.has('tokens.css'));
    assert.ok(files.has('app.css'));
    assert.ok(files.has('app.js'));
    assert.ok(files.has('automations/README.md'));
    assert.ok(files.has('README.md'));
    // No empty dirs in a file map.
    const appJson = JSON.parse(files.get('app.json')!) as {
      id: string;
      name: string;
      knobs: unknown[];
    };
    assert.equal(appJson.id, 'todos');
    assert.equal(appJson.name, 'Todos');
    assert.ok(Array.isArray(appJson.knobs) && appJson.knobs.length === 4);
    assert.match(files.get('index.html')!, /<title>Todos<\/title>/);
    assert.match(files.get('package.json')!, /"centraid-app-todos"/);
  });

  it('defaults name to the id and carries a trimmed description', () => {
    const files = byPath(scaffoldAppFiles('notes', { description: '  jot things  ' }));
    const appJson = JSON.parse(files.get('app.json')!) as { name: string; description?: string };
    assert.equal(appJson.name, 'notes');
    assert.equal(appJson.description, 'jot things');
  });

  it('rejects an invalid id', () => {
    assert.throws(() => scaffoldAppFiles('_bad'), /Invalid app id/);
  });
});

describe('updateAppMetaFiles', () => {
  const base = (): ScaffoldFile[] => scaffoldAppFiles('todos', { name: 'Todos' });

  it('rewrites app.json#name and the index.html <title> on rename', () => {
    const changed = byPath(updateAppMetaFiles(base(), 'todos', { name: 'Tasks' }));
    assert.deepEqual([...changed.keys()].sort(), ['app.json', 'index.html']);
    assert.equal((JSON.parse(changed.get('app.json')!) as { name: string }).name, 'Tasks');
    assert.match(changed.get('index.html')!, /<title>Tasks<\/title>/);
  });

  it('clears description on empty patch and only touches app.json', () => {
    const start = scaffoldAppFiles('todos', { name: 'Todos', description: 'x' });
    const changed = byPath(updateAppMetaFiles(start, 'todos', { description: '   ' }));
    assert.deepEqual([...changed.keys()], ['app.json']);
    assert.equal(
      (JSON.parse(changed.get('app.json')!) as { description?: string }).description,
      undefined,
    );
  });

  it('rejects an empty name and a duplicate display name', () => {
    assert.throws(() => updateAppMetaFiles(base(), 'todos', { name: '  ' }), /cannot be empty/);
    assert.throws(
      () => updateAppMetaFiles(base(), 'todos', { name: 'Other' }, [{ id: 'x', name: 'other' }]),
      /already exists/,
    );
  });

  it('allows renaming to the apps own current name (self excluded)', () => {
    const changed = updateAppMetaFiles(base(), 'todos', { name: 'Todos' }, [
      { id: 'todos', name: 'Todos' },
    ]);
    assert.ok(changed.some((f) => f.path === 'app.json'));
  });
});

describe('cloneTemplateFiles', () => {
  const template = (): ScaffoldFile[] => [
    {
      path: 'app.json',
      content:
        JSON.stringify(
          { id: 'hydrate', name: 'Hydrate', version: '2.0.0', description: 'drink water' },
          null,
          2,
        ) + '\n',
    },
    {
      path: 'package.json',
      content: JSON.stringify({ name: 'centraid-app-hydrate' }, null, 2) + '\n',
    },
    { path: 'index.html', content: '<!doctype html><head><title>Hydrate</title></head>' },
  ];

  it('rewrites id, name, version, package name, and title', () => {
    const out = byPath(
      cloneTemplateFiles({
        newAppId: 'hydrate-2',
        templateFiles: template(),
        newName: 'Hydrate 2',
      }),
    );
    const appJson = JSON.parse(out.get('app.json')!) as Record<string, unknown>;
    assert.equal(appJson.id, 'hydrate-2');
    assert.equal(appJson.name, 'Hydrate 2');
    assert.equal(appJson.version, '0.1.0');
    assert.equal(appJson.description, 'drink water');
    assert.match(out.get('package.json')!, /"centraid-app-hydrate-2"/);
    assert.match(out.get('index.html')!, /<title>Hydrate 2<\/title>/);
  });

  it('stamps generated + rewrites name on a bundled automation manifest', () => {
    const tmpl = [
      ...template(),
      {
        path: 'automations/wake/automation.json',
        content:
          JSON.stringify(
            { name: 'Hydrate', generated: { by: 'tmpl', at: '2020-01-01T00:00:00.000Z' } },
            null,
            2,
          ) + '\n',
      },
    ];
    const out = byPath(
      cloneTemplateFiles({ newAppId: 'hydrate-2', templateFiles: tmpl, newName: 'Hydrate 2' }),
    );
    const mf = JSON.parse(out.get('automations/wake/automation.json')!) as {
      name: string;
      generated: { by: string; at: string };
    };
    assert.equal(mf.name, 'Hydrate 2');
    assert.equal(mf.generated.by, 'centraid-builder');
    assert.notEqual(mf.generated.at, '2020-01-01T00:00:00.000Z');
    // No automations brief is seeded when a real manifest ships.
    assert.equal(out.has('automations/README.md'), false);
  });

  it('seeds an automations brief when the template has none', () => {
    const out = byPath(cloneTemplateFiles({ newAppId: 'hydrate-2', templateFiles: template() }));
    assert.ok(out.has('automations/README.md'));
  });
});
