/*
 * Every bundled blueprint must be deployable as-is: its app.json parses
 * under the runtime's real manifest validator (including the vault block),
 * every declared action/query has a handler file on disk, and the gallery
 * index and the template dirs agree. This is the gate that keeps a
 * template from cloning into an app the dispatcher immediately rejects.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateAppManifest, type AppManifest } from '@centraid/app-engine';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function templateDirs(kind: 'apps' | 'automations'): string[] {
  return readdirSync(path.join(PACKAGE_ROOT, kind), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .toSorted();
}

function readManifest(kind: 'apps' | 'automations', id: string): AppManifest {
  const raw = readFileSync(path.join(PACKAGE_ROOT, kind, id, 'app.json'), 'utf8');
  return validateAppManifest(JSON.parse(raw));
}

describe('bundled blueprint manifests', () => {
  const apps = templateDirs('apps');
  const automations = templateDirs('automations');

  it.each(apps.map((id) => [id] as const))('apps/%s has a valid app.json', (id) => {
    const manifest = readManifest('apps', id);
    expect(manifest.id).toBe(id);
  });

  it.each(automations.map((id) => [id] as const))('automations/%s has a valid app.json', (id) => {
    const manifest = readManifest('automations', id);
    expect(manifest.id).toBe(id);
  });

  it.each(apps.map((id) => [id] as const))(
    'apps/%s declares only handlers that exist on disk',
    (id) => {
      // Handlers may be authored as `.ts` (post TS conversion) or `.js` — the
      // dispatcher probes `.ts` first, then `.js`. Accept whichever is present.
      const handlerExists = (kind: 'actions' | 'queries', name: string): boolean =>
        existsSync(path.join(PACKAGE_ROOT, 'apps', id, kind, `${name}.ts`)) ||
        existsSync(path.join(PACKAGE_ROOT, 'apps', id, kind, `${name}.js`));
      const manifest = readManifest('apps', id);
      for (const action of manifest.actions) {
        expect(handlerExists('actions', action.name), `missing actions/${action.name}.(ts|js) in ${id}`).toBe(
          true,
        );
      }
      for (const query of manifest.queries) {
        expect(handlerExists('queries', query.name), `missing queries/${query.name}.(ts|js) in ${id}`).toBe(
          true,
        );
      }
    },
  );

  it('vault projections declare a vault block and no ext band of their own', () => {
    const projections = apps.filter((id) => {
      const manifest = readManifest('apps', id);
      return manifest.vault !== undefined;
    });
    // The §01 projection band, as blueprints.
    expect(projections).toEqual(
      ['agenda', 'docs', 'locker', 'notes', 'people', 'photos', 'tally', 'tasks'].toSorted(),
    );
    for (const id of projections) {
      const manifest = readManifest('apps', id);
      expect(
        manifest.ext,
        `${id} must not declare ext tables — it is a pure projection`,
      ).toBeUndefined();
      expect(manifest.vault?.scopes.length, `${id} needs at least one scope`).toBeGreaterThan(0);
    }
  });

  it.each([
    ...apps.map((id) => ['apps', id] as const),
    ...automations.map((id) => ['automations', id] as const),
  ])('%s/%s ships no migrations folder — the vault is the only store', (kind, id) => {
    expect(
      existsSync(path.join(PACKAGE_ROOT, kind, id, 'migrations')),
      `${kind}/${id} must not ship migrations — the migrations mechanism is gone (#286)`,
    ).toBe(false);
  });

  it('the gallery index and the template dirs agree', () => {
    const index = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'index.json'), 'utf8')) as {
      templates: Array<{ id: string; kind?: string }>;
    };
    const indexed = index.templates
      .map((t) => `${t.kind === 'automation' ? 'automations' : 'apps'}/${t.id}`)
      .toSorted();
    const onDisk = [
      ...templateDirs('apps').map((id) => `apps/${id}`),
      ...templateDirs('automations').map((id) => `automations/${id}`),
    ].toSorted();
    expect(indexed).toEqual(onDisk);
  });
});
