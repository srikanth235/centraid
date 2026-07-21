import { tempDir } from '@centraid/test-kit/temp-dir';
import { expect, test } from 'vitest';
import path from 'node:path';
import type { RunnerModel } from '@centraid/app-engine';
import { readCatalog } from './catalog.ts';
import { CatalogWarmer, deriveStatus } from './catalog-warmer.ts';

let counter = 0;
async function tmpCatalogPath(): Promise<string> {
  const dir = await tempDir('centraid-warmer-');
  return path.join(dir, `model-catalog-${counter++}.json`);
}

const noModels = async (): Promise<RunnerModel[]> => [];

test('warm writes a non-empty model enumeration to the catalog', async () => {
  const catalogPath = await tmpCatalogPath();
  const warmer = new CatalogWarmer({
    catalogPath,
    enumerateModels: async () => [{ id: 'sonnet' }, { id: 'haiku' }],
  });
  await warmer.warm('claude-code', 'models');
  const entry = (await readCatalog(catalogPath))?.runners['claude-code'];
  expect(entry?.models?.map((m) => m.id)).toEqual(['sonnet', 'haiku']);
  expect(entry?.hash).toBeTruthy();
  expect(entry?.enumeratedAt).toBeTruthy();
});

test('concurrent warms for the same surface dedupe to one enumeration', async () => {
  const catalogPath = await tmpCatalogPath();
  let calls = 0;
  const warmer = new CatalogWarmer({
    catalogPath,
    enumerateModels: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return [{ id: 'sonnet' }];
    },
  });
  const a = warmer.warm('claude-code', 'models');
  expect(warmer.isWarming('claude-code', 'models')).toBe(true);
  const b = warmer.warm('claude-code', 'models');
  await Promise.all([a, b]);
  expect(calls).toBe(1);
  expect(warmer.isWarming('claude-code', 'models')).toBe(false);
});

test('an empty enumeration writes nothing and never clobbers a prior entry', async () => {
  const catalogPath = await tmpCatalogPath();
  const good = new CatalogWarmer({
    catalogPath,
    enumerateModels: async () => [{ id: 'sonnet' }],
  });
  await good.warm('claude-code', 'models');
  const bad = new CatalogWarmer({
    catalogPath,
    enumerateModels: noModels, // transient failure → []
  });
  await bad.warm('claude-code', 'models');
  expect(
    (await readCatalog(catalogPath))?.runners['claude-code']?.models?.map((m) => m.id),
  ).toEqual(['sonnet']);
});

test('a throwing enumerator is swallowed and writes nothing', async () => {
  const catalogPath = await tmpCatalogPath();
  const warmer = new CatalogWarmer({
    catalogPath,
    enumerateModels: async () => {
      throw new Error('boom');
    },
  });
  await warmer.warm('claude-code', 'models'); // must not reject
  expect(await readCatalog(catalogPath)).toBe(undefined);
});

test('deriveStatus: loading wins over a cache, then ready, else empty', () => {
  expect(deriveStatus(0, false)).toBe('empty');
  expect(deriveStatus(0, true)).toBe('loading');
  expect(deriveStatus(3, false)).toBe('ready');
  // A refresh over an existing list is still loading so the client polls.
  expect(deriveStatus(3, true)).toBe('loading');
});
