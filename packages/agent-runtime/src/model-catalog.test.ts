import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunnerModel } from '@centraid/app-engine';
import { readCatalog, resolveRunnerModels, writeCatalogEntry } from './model-catalog.ts';

let counter = 0;
async function tmpCatalogPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-catalog-'));
  return path.join(dir, `model-catalog-${counter++}.json`);
}

const DEFAULTS: RunnerModel[] = [
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', default: true },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
];

test('default load with no file → returns defaults, never enumerates', async () => {
  const catalogPath = await tmpCatalogPath();
  let enumerated = false;
  const models = await resolveRunnerModels({
    kind: 'claude-code',
    catalogPath,
    enumerate: async () => {
      enumerated = true;
      return [{ id: 'should-not-happen' }];
    },
    defaults: DEFAULTS,
  });
  assert.equal(enumerated, false);
  assert.deepEqual(models, DEFAULTS);
});

test('warm load returns the cached entry, not defaults', async () => {
  const catalogPath = await tmpCatalogPath();
  await writeCatalogEntry(catalogPath, 'claude-code', {
    hash: 'abc',
    models: [{ id: 'claude-opus-4-8' }],
    enumeratedAt: '2026-01-01T00:00:00.000Z',
  });
  const models = await resolveRunnerModels({
    kind: 'claude-code',
    catalogPath,
    enumerate: async () => [{ id: 'nope' }],
    defaults: DEFAULTS,
  });
  assert.deepEqual(
    models.map((m) => m.id),
    ['claude-opus-4-8'],
  );
});

test('refresh enumerates and overwrites the file', async () => {
  const catalogPath = await tmpCatalogPath();
  const live = [{ id: 'claude-opus-4-8' }, { id: 'claude-haiku-4-5' }];
  const models = await resolveRunnerModels({
    kind: 'claude-code',
    catalogPath,
    enumerate: async () => live,
    defaults: DEFAULTS,
    refresh: true,
  });
  assert.deepEqual(
    models.map((m) => m.id),
    ['claude-opus-4-8', 'claude-haiku-4-5'],
  );
  const file = await readCatalog(catalogPath);
  assert.deepEqual(
    file?.runners['claude-code']?.models.map((m) => m.id),
    ['claude-opus-4-8', 'claude-haiku-4-5'],
  );
});

test('refresh failure preserves a prior good entry', async () => {
  const catalogPath = await tmpCatalogPath();
  await writeCatalogEntry(catalogPath, 'claude-code', {
    hash: 'abc',
    models: [{ id: 'claude-opus-4-8' }],
    enumeratedAt: '2026-01-01T00:00:00.000Z',
  });
  const models = await resolveRunnerModels({
    kind: 'claude-code',
    catalogPath,
    enumerate: async () => [], // failure → empty
    defaults: DEFAULTS,
    refresh: true,
  });
  assert.deepEqual(
    models.map((m) => m.id),
    ['claude-opus-4-8'],
  );
  // The prior entry must still be on disk.
  const file = await readCatalog(catalogPath);
  assert.deepEqual(
    file?.runners['claude-code']?.models.map((m) => m.id),
    ['claude-opus-4-8'],
  );
});

test('refresh failure with no prior entry falls back to defaults', async () => {
  const catalogPath = await tmpCatalogPath();
  const models = await resolveRunnerModels({
    kind: 'codex',
    catalogPath,
    enumerate: async () => {
      throw new Error('boom');
    },
    defaults: DEFAULTS,
    refresh: true,
  });
  assert.deepEqual(models, DEFAULTS);
});

test('corrupt catalog file is treated as empty → defaults', async () => {
  const catalogPath = await tmpCatalogPath();
  await fs.mkdir(path.dirname(catalogPath), { recursive: true });
  await fs.writeFile(catalogPath, '{ not valid json', 'utf8');
  const models = await resolveRunnerModels({
    kind: 'claude-code',
    catalogPath,
    enumerate: async () => [{ id: 'nope' }],
    defaults: DEFAULTS,
  });
  assert.deepEqual(models, DEFAULTS);
});

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
  assert.equal(file?.runners['claude-code']?.models[0].id, 'claude-opus-4-8');
  assert.equal(file?.runners['codex']?.models[0].id, 'gpt-5-codex');
});
