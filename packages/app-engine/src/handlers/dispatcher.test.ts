// The dispatcher after issue #286 phase 2: declared-handler routing ONLY.
// What must hold: manifest lookup + Ajv validation + worker hand-off work;
// `_sql` and every other underscore name is just an unknown handler now;
// describe returns the manifest (there is no per-app schema to read).

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Dispatcher } from './dispatcher.js';
import { Registry } from '../registry/registry.js';

let appsDir: string;
let codeDir: string;
let registry: Registry;
let dispatcher: Dispatcher;
let notified: string[];

const MANIFEST = {
  manifestVersion: 1,
  id: 'demo',
  name: 'Demo',
  version: '0.1.0',
  actions: [
    {
      name: 'add_note',
      confirmation: 'none',
      input: {
        type: 'object',
        required: ['title'],
        properties: { title: { type: 'string' } },
        additionalProperties: false,
      },
    },
  ],
  queries: [
    {
      name: 'list_notes',
      input: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
};

beforeEach(async () => {
  appsDir = await mkdtemp(path.join(tmpdir(), 'centraid-dispatch-'));
  codeDir = path.join(appsDir, 'code');
  await mkdir(path.join(codeDir, 'actions'), { recursive: true });
  await mkdir(path.join(codeDir, 'queries'), { recursive: true });
  await writeFile(path.join(codeDir, 'app.json'), JSON.stringify(MANIFEST));
  await writeFile(
    path.join(codeDir, 'actions', 'add_note.js'),
    `export default async ({ body }) => ({ status: 200, body: { added: body.title } });`,
  );
  await writeFile(
    path.join(codeDir, 'queries', 'list_notes.js'),
    `export default async () => ({ notes: [] });`,
  );
  registry = new Registry(appsDir);
  await registry.load();
  await registry.ensureUploaded('demo');
  notified = [];
  dispatcher = new Dispatcher({
    registry,
    codeDirOverride: async () => codeDir,
    onWriteFor: (appId) => () => notified.push(appId),
  });
});

describe('declared routing', () => {
  it('write runs a declared action and fires the change notification', async () => {
    const out = await dispatcher.write({ app: 'demo', action: 'add_note', input: { title: 'x' } });
    expect(out.isError).toBe(false);
    expect(out.structuredContent).toEqual({ added: 'x' });
    expect(notified).toEqual(['demo']);
  });

  it('read runs a declared query (and never notifies)', async () => {
    const out = await dispatcher.read({ app: 'demo', query: 'list_notes' });
    expect(out.isError).toBe(false);
    expect(out.structuredContent).toEqual({ notes: [] });
    expect(notified).toEqual([]);
  });

  it('input failing the declared JSON Schema is refused before the worker', async () => {
    const out = await dispatcher.write({ app: 'demo', action: 'add_note', input: { nope: 1 } });
    expect(out.isError).toBe(true);
    if (out.isError) expect(out.structuredContent.code).toBe('INVALID_INPUT');
  });

  it('a query addressed through write surfaces WRONG_KIND', async () => {
    const out = await dispatcher.write({ app: 'demo', action: 'list_notes' });
    expect(out.isError).toBe(true);
    if (out.isError) expect(out.structuredContent.code).toBe('WRONG_KIND');
  });

  it('describe returns the manifest — no schema payload, no silo', async () => {
    const out = await dispatcher.describe({ app: 'demo' });
    expect(out.isError).toBe(false);
    const value = out.structuredContent as { manifest: { id: string }; schema?: unknown };
    expect(value.manifest.id).toBe('demo');
    expect('schema' in value).toBe(false);
  });

  it('the `_sql` builtin is gone: underscore names are unknown handlers', async () => {
    const write = await dispatcher.write({ app: 'demo', action: '_sql', input: { sql: 'x' } });
    expect(write.isError).toBe(true);
    if (write.isError) expect(write.structuredContent.code).toBe('UNKNOWN_ACTION');
    const read = await dispatcher.read({ app: 'demo', query: '_sql', input: { sql: 'x' } });
    expect(read.isError).toBe(true);
    if (read.isError) expect(read.structuredContent.code).toBe('UNKNOWN_QUERY');
  });

  it('unknown app / missing code dir map to their own error codes', async () => {
    const out = await dispatcher.write({ app: 'ghost', action: 'a' });
    expect(out.isError).toBe(true);
    if (out.isError) expect(out.structuredContent.code).toBe('UNKNOWN_APP');
    const bare = new Dispatcher({ registry });
    const noCode = await bare.read({ app: 'demo', query: 'list_notes' });
    expect(noCode.isError).toBe(true);
    if (noCode.isError) expect(noCode.structuredContent.code).toBe('NO_ACTIVE_VERSION');
  });
});
