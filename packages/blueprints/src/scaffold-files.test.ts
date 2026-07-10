import { describe, expect, it } from 'vitest';
import { scaffoldAppFiles, updateAppMetaFiles, type ScaffoldFile } from './scaffold-files.js';
import { cloneTemplateFiles } from './clone.js';

function byPath(files: ScaffoldFile[]): Map<string, string> {
  return new Map(files.map((f) => [f.path, f.content]));
}

describe('scaffoldAppFiles', () => {
  it('emits the canonical file set with the id/name baked in', () => {
    const files = byPath(scaffoldAppFiles('todos', { name: 'Todos' }));
    expect(files.has('package.json')).toBeTruthy();
    expect(files.has('app.json')).toBeTruthy();
    expect(files.has('index.html')).toBeTruthy();
    // The design system (wall/tokens/kit css) is served shared, never copied
    // into the app — a local tokens.css would shadow the live shared layer.
    expect(files.has('tokens.css')).toBeFalsy();
    expect(files.has('app.css')).toBeTruthy();
    expect(files.has('app.jsx')).toBeTruthy();
    expect(files.has('automations/README.md')).toBeTruthy();
    expect(files.has('README.md')).toBeTruthy();
    // No empty dirs in a file map.
    const appJson = JSON.parse(files.get('app.json')!) as {
      id: string;
      name: string;
      knobs: unknown[];
    };
    expect(appJson.id).toBe('todos');
    expect(appJson.name).toBe('Todos');
    expect(Array.isArray(appJson.knobs) && appJson.knobs.length === 4).toBeTruthy();
    expect(files.get('index.html')!).toMatch(/<title>Todos<\/title>/);
    expect(files.get('package.json')!).toMatch(/"centraid-app-todos"/);
  });

  it('defaults name to the id and carries a trimmed description', () => {
    const files = byPath(scaffoldAppFiles('notes', { description: '  jot things  ' }));
    const appJson = JSON.parse(files.get('app.json')!) as { name: string; description?: string };
    expect(appJson.name).toBe('notes');
    expect(appJson.description).toBe('jot things');
  });

  it('rejects an invalid id', () => {
    expect(() => scaffoldAppFiles('_bad')).toThrow(/Invalid app id/);
  });

  it('stamps the default tile identity (Sparkle on violet) into app.json', () => {
    const files = byPath(scaffoldAppFiles('todos'));
    const appJson = JSON.parse(files.get('app.json')!) as { iconKey: string; colorKey: string };
    expect(appJson.iconKey).toBe('Sparkle');
    expect(appJson.colorKey).toBe('violet');
  });

  it('stamps an explicit tile identity into app.json', () => {
    const files = byPath(scaffoldAppFiles('todos', { iconKey: 'Todo', colorKey: 'indigo' }));
    const appJson = JSON.parse(files.get('app.json')!) as { iconKey: string; colorKey: string };
    expect(appJson.iconKey).toBe('Todo');
    expect(appJson.colorKey).toBe('indigo');
  });
});

describe('updateAppMetaFiles', () => {
  const base = (): ScaffoldFile[] => scaffoldAppFiles('todos', { name: 'Todos' });

  it('rewrites app.json#name and the index.html <title> on rename', () => {
    const changed = byPath(updateAppMetaFiles(base(), 'todos', { name: 'Tasks' }));
    expect([...changed.keys()].sort()).toEqual(['app.json', 'index.html']);
    expect((JSON.parse(changed.get('app.json')!) as { name: string }).name).toBe('Tasks');
    expect(changed.get('index.html')!).toMatch(/<title>Tasks<\/title>/);
  });

  it('clears description on empty patch and only touches app.json', () => {
    const start = scaffoldAppFiles('todos', { name: 'Todos', description: 'x' });
    const changed = byPath(updateAppMetaFiles(start, 'todos', { description: '   ' }));
    expect([...changed.keys()]).toEqual(['app.json']);
    expect((JSON.parse(changed.get('app.json')!) as { description?: string }).description).toBe(
      undefined,
    );
  });

  it('rejects an empty name and a duplicate display name', () => {
    expect(() => updateAppMetaFiles(base(), 'todos', { name: '  ' })).toThrow(/cannot be empty/);
    expect(() =>
      updateAppMetaFiles(base(), 'todos', { name: 'Other' }, [{ id: 'x', name: 'other' }]),
    ).toThrow(/already exists/);
  });

  it('allows renaming to the apps own current name (self excluded)', () => {
    const changed = updateAppMetaFiles(base(), 'todos', { name: 'Todos' }, [
      { id: 'todos', name: 'Todos' },
    ]);
    expect(changed.some((f) => f.path === 'app.json')).toBeTruthy();
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
    expect(appJson.id).toBe('hydrate-2');
    expect(appJson.name).toBe('Hydrate 2');
    expect(appJson.version).toBe('0.1.0');
    expect(appJson.description).toBe('drink water');
    expect(out.get('package.json')!).toMatch(/"centraid-app-hydrate-2"/);
    expect(out.get('index.html')!).toMatch(/<title>Hydrate 2<\/title>/);
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
    expect(mf.name).toBe('Hydrate 2');
    expect(mf.generated.by).toBe('centraid-builder');
    expect(mf.generated.at).not.toBe('2020-01-01T00:00:00.000Z');
    // No automations brief is seeded when a real manifest ships.
    expect(out.has('automations/README.md')).toBe(false);
  });

  it('seeds an automations brief when the template has none', () => {
    const out = byPath(cloneTemplateFiles({ newAppId: 'hydrate-2', templateFiles: template() }));
    expect(out.has('automations/README.md')).toBeTruthy();
  });

  it('backfills the catalog tile identity when the template app.json lacks it', () => {
    const out = byPath(
      cloneTemplateFiles({
        newAppId: 'hydrate-2',
        templateFiles: template(),
        iconKey: 'Water',
        colorKey: 'teal',
      }),
    );
    const appJson = JSON.parse(out.get('app.json')!) as { iconKey: string; colorKey: string };
    expect(appJson.iconKey).toBe('Water');
    expect(appJson.colorKey).toBe('teal');
  });

  it('keeps the template app.json tile identity over the catalog entry', () => {
    const tmpl = template();
    tmpl[0] = {
      path: 'app.json',
      content:
        JSON.stringify(
          { id: 'hydrate', name: 'Hydrate', version: '2.0.0', iconKey: 'Water', colorKey: 'teal' },
          null,
          2,
        ) + '\n',
    };
    const out = byPath(
      cloneTemplateFiles({
        newAppId: 'hydrate-2',
        templateFiles: tmpl,
        iconKey: 'Sparkle',
        colorKey: 'violet',
      }),
    );
    const appJson = JSON.parse(out.get('app.json')!) as { iconKey: string; colorKey: string };
    expect(appJson.iconKey).toBe('Water');
    expect(appJson.colorKey).toBe('teal');
  });
});
