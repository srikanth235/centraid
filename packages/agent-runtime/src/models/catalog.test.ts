import { expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readCatalog, readRunnerModels, readRunnerTools, writeCatalogEntry } from './catalog.ts';

let counter = 0;
async function tmpCatalogPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-catalog-'));
  return path.join(dir, `model-catalog-${counter++}.json`);
}

// ---- reads (no seed, no enumeration) ----

test('readRunnerModels returns [] when the catalog file is absent', async () => {
  const catalogPath = await tmpCatalogPath();
  expect(await readRunnerModels(catalogPath, 'claude-code')).toEqual([]);
});

test('readRunnerModels returns the cached list when present', async () => {
  const catalogPath = await tmpCatalogPath();
  await writeCatalogEntry(catalogPath, 'claude-code', {
    hash: 'abc',
    models: [{ id: 'claude-opus-4-8' }, { id: 'claude-haiku-4-5' }],
    enumeratedAt: '2026-01-01T00:00:00.000Z',
  });
  expect((await readRunnerModels(catalogPath, 'claude-code')).map((m) => m.id)).toEqual([
    'claude-opus-4-8',
    'claude-haiku-4-5',
  ]);
});

test('readRunnerModels treats a corrupt catalog as empty', async () => {
  const catalogPath = await tmpCatalogPath();
  await fs.mkdir(path.dirname(catalogPath), { recursive: true });
  await fs.writeFile(catalogPath, '{ not valid json', 'utf8');
  expect(await readRunnerModels(catalogPath, 'claude-code')).toEqual([]);
});

test('readRunnerTools returns [] cold and the cached list when present', async () => {
  const catalogPath = await tmpCatalogPath();
  expect(await readRunnerTools(catalogPath, 'claude-code')).toEqual([]);
  await writeCatalogEntry(catalogPath, 'claude-code', {
    tools: [{ name: 'Read', source: 'native' }],
    toolsEnumeratedAt: '2026-01-01T00:00:00.000Z',
  });
  expect((await readRunnerTools(catalogPath, 'claude-code')).map((t) => t.name)).toEqual(['Read']);
});

// ---- merge-write (models and tools never clobber each other) ----

test('writeCatalogEntry preserves other runners', async () => {
  const catalogPath = await tmpCatalogPath();
  await writeCatalogEntry(catalogPath, 'claude-code', {
    hash: 'a',
    models: [{ id: 'claude-opus-4-8' }],
    enumeratedAt: '2026-01-01T00:00:00.000Z',
  });
  await writeCatalogEntry(catalogPath, 'codex', {
    hash: 'b',
    models: [{ id: 'gpt-5-codex' }],
    enumeratedAt: '2026-01-01T00:00:00.000Z',
  });
  const file = await readCatalog(catalogPath);
  expect(file?.runners['claude-code']?.models?.[0]?.id).toBe('claude-opus-4-8');
  expect(file?.runners['codex']?.models?.[0]?.id).toBe('gpt-5-codex');
});

test('a models write and a tools write merge into one runner entry', async () => {
  const catalogPath = await tmpCatalogPath();
  await writeCatalogEntry(catalogPath, 'claude-code', {
    hash: 'h',
    models: [{ id: 'sonnet' }],
    enumeratedAt: '2026-01-01T00:00:00.000Z',
  });
  // A later tools write must NOT clobber the models field, and vice versa.
  await writeCatalogEntry(catalogPath, 'claude-code', {
    tools: [{ name: 'Read', source: 'native' }],
    toolsEnumeratedAt: '2026-01-01T00:00:00.000Z',
  });
  const entry = (await readCatalog(catalogPath))?.runners['claude-code'];
  expect(entry?.models?.map((m) => m.id)).toEqual(['sonnet']);
  expect(entry?.tools?.map((t) => t.name)).toEqual(['Read']);
});
