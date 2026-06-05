import { expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RunnerModel } from '@centraid/app-engine';
import type { HostTool } from '../host-tools.ts';
import {
  readCatalog,
  resolveRunnerModels,
  resolveRunnerTools,
  writeCatalogEntry,
} from './catalog.ts';

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
  expect(enumerated).toBe(false);
  expect(models).toEqual(DEFAULTS);
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
  expect(models.map((m) => m.id)).toEqual(['claude-opus-4-8']);
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
  expect(models.map((m) => m.id)).toEqual(['claude-opus-4-8', 'claude-haiku-4-5']);
  const file = await readCatalog(catalogPath);
  expect(file?.runners['claude-code']?.models?.map((m) => m.id)).toEqual([
    'claude-opus-4-8',
    'claude-haiku-4-5',
  ]);
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
  expect(models.map((m) => m.id)).toEqual(['claude-opus-4-8']);
  // The prior entry must still be on disk.
  const file = await readCatalog(catalogPath);
  expect(file?.runners['claude-code']?.models?.map((m) => m.id)).toEqual(['claude-opus-4-8']);
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
  expect(models).toEqual(DEFAULTS);
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
  expect(models).toEqual(DEFAULTS);
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
  expect(file?.runners['claude-code']?.models?.[0]?.id).toBe('claude-opus-4-8');
  expect(file?.runners['codex']?.models?.[0]?.id).toBe('gpt-5-codex');
});

// ---- tools (resolveRunnerTools) — mirrors models, no seed ----

const TOOLS: HostTool[] = [
  { name: 'Read', source: 'native' },
  { name: 'github.list_pull_requests', source: 'mcp', server: 'github' },
];

test('tools default load with no file → [] and never enumerates', async () => {
  const catalogPath = await tmpCatalogPath();
  let enumerated = false;
  const tools = await resolveRunnerTools({
    kind: 'claude-code',
    catalogPath,
    enumerate: async () => {
      enumerated = true;
      return TOOLS;
    },
  });
  expect(enumerated).toBe(false);
  expect(tools).toEqual([]);
});

test('tools refresh enumerates, returns, and persists', async () => {
  const catalogPath = await tmpCatalogPath();
  const tools = await resolveRunnerTools({
    kind: 'claude-code',
    catalogPath,
    enumerate: async () => TOOLS,
    refresh: true,
  });
  expect(tools.map((t) => t.name)).toEqual(['Read', 'github.list_pull_requests']);
  const file = await readCatalog(catalogPath);
  expect(file?.runners['claude-code']?.tools?.map((t) => t.name)).toEqual([
    'Read',
    'github.list_pull_requests',
  ]);
  expect(file?.runners['claude-code']?.toolsEnumeratedAt).toBeTruthy();
});

test('tools warm load returns cached, not a re-probe', async () => {
  const catalogPath = await tmpCatalogPath();
  await writeCatalogEntry(catalogPath, 'claude-code', {
    tools: [{ name: 'Cached', source: 'native' }],
    toolsEnumeratedAt: '2026-01-01T00:00:00.000Z',
  });
  const tools = await resolveRunnerTools({
    kind: 'claude-code',
    catalogPath,
    enumerate: async () => TOOLS,
  });
  expect(tools.map((t) => t.name)).toEqual(['Cached']);
});

test('tools refresh failure preserves the prior tool list', async () => {
  const catalogPath = await tmpCatalogPath();
  await writeCatalogEntry(catalogPath, 'claude-code', {
    tools: [{ name: 'Cached', source: 'native' }],
    toolsEnumeratedAt: '2026-01-01T00:00:00.000Z',
  });
  const tools = await resolveRunnerTools({
    kind: 'claude-code',
    catalogPath,
    enumerate: async () => [], // probe failure → empty
    refresh: true,
  });
  expect(tools.map((t) => t.name)).toEqual(['Cached']);
});

test('a tools write and a models write merge into one entry', async () => {
  const catalogPath = await tmpCatalogPath();
  // Models refresh first…
  await resolveRunnerModels({
    kind: 'claude-code',
    catalogPath,
    enumerate: async () => [{ id: 'sonnet' }],
    defaults: DEFAULTS,
    refresh: true,
  });
  // …then a tools refresh must NOT clobber the models field, and vice versa.
  await resolveRunnerTools({
    kind: 'claude-code',
    catalogPath,
    enumerate: async () => TOOLS,
    refresh: true,
  });
  const entry = (await readCatalog(catalogPath))?.runners['claude-code'];
  expect(entry?.models?.map((m) => m.id)).toEqual(['sonnet']);
  expect(entry?.tools?.map((t) => t.name)).toEqual(['Read', 'github.list_pull_requests']);
});
