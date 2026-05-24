import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Registry } from './registry.js';
import { VersionStore } from './version-store.js';
import { Dispatcher, isToolName, statusForToolError } from './dispatcher.js';

const writeJson = (file: string, data: unknown) =>
  fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');

const writeFile = (file: string, body: string) => fs.writeFile(file, body, 'utf8');

async function makeTodoApp(appsDir: string): Promise<string> {
  const appId = 'todos';
  const codeDir = path.join(appsDir, appId);
  await fs.mkdir(path.join(codeDir, 'actions'), { recursive: true });
  await fs.mkdir(path.join(codeDir, 'queries'), { recursive: true });

  await writeJson(path.join(codeDir, 'app.json'), {
    manifestVersion: 1,
    id: appId,
    name: 'Todos',
    version: '0.1.0',
    actions: [
      {
        name: 'add',
        confirmation: 'none',
        input: {
          type: 'object',
          properties: { text: { type: 'string', minLength: 1 } },
          required: ['text'],
          additionalProperties: false,
        },
      },
    ],
    queries: [
      {
        name: 'list',
        input: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  });

  await writeFile(
    path.join(codeDir, 'actions', 'add.js'),
    `export default async ({ body, db }) => {
       await db.exec('CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, text TEXT)');
       const r = await db.prepare('INSERT INTO todos(text) VALUES (?)').run(String(body?.text ?? ''));
       return { status: 200, body: { id: Number(r.lastInsertRowid), text: String(body?.text ?? '') } };
     };\n`,
  );
  await writeFile(
    path.join(codeDir, 'queries', 'list.js'),
    `export default async ({ db }) => {
       await db.exec('CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, text TEXT)');
       return await db.prepare('SELECT id, text FROM todos ORDER BY id').all();
     };\n`,
  );
  return codeDir;
}

describe('Dispatcher (path-mode app)', () => {
  let workDir: string;
  let registry: Registry;
  let versions: VersionStore;
  let dispatcher: Dispatcher;

  before(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-dispatcher-'));
    const codeDir = await makeTodoApp(workDir);
    registry = new Registry(workDir);
    await registry.load();
    await registry.register({ id: 'todos', path: codeDir, mode: 'path' });
    versions = new VersionStore();
    dispatcher = new Dispatcher({ registry, versions });
  });

  after(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('describe with no filter returns a list of apps', async () => {
    const out = await dispatcher.describe({});
    assert.equal(out.isError, false);
    const body = out.structuredContent as { apps: Array<{ id: string }> };
    assert.equal(body.apps.length, 1);
    assert.equal(body.apps[0]!.id, 'todos');
  });

  it('describe with {app} returns the full manifest', async () => {
    const out = await dispatcher.describe({ app: 'todos' });
    assert.equal(out.isError, false);
    const body = out.structuredContent as { name: string; actions: Array<{ name: string }> };
    assert.equal(body.name, 'Todos');
    assert.equal(body.actions[0]!.name, 'add');
  });

  it('describe with {app, action} returns the handler entry wrapped', async () => {
    const out = await dispatcher.describe({ app: 'todos', action: 'add' });
    assert.equal(out.isError, false);
    const body = out.structuredContent as {
      app: { id: string; name: string };
      action: { name: string };
    };
    assert.equal(body.app.id, 'todos');
    assert.equal(body.action.name, 'add');
  });

  it('describe returns UNKNOWN_APP for an unknown app', async () => {
    const out = await dispatcher.describe({ app: 'missing' });
    assert.equal(out.isError, true);
    if (out.isError) {
      assert.equal(out.structuredContent.code, 'UNKNOWN_APP');
    }
  });

  it('describe returns UNKNOWN_ACTION for an unknown action', async () => {
    const out = await dispatcher.describe({ app: 'todos', action: 'nope' });
    assert.equal(out.isError, true);
    if (out.isError) {
      assert.equal(out.structuredContent.code, 'UNKNOWN_ACTION');
    }
  });

  // NB: full write/read round-trips that boot the handler-runner worker
  // are exercised by the `http-server.test.ts` end-to-end test against the
  // built artifact. The dispatcher's pre-invocation surface (manifest
  // lookup, schema validation, error mapping) is covered exhaustively
  // here without paying the worker-thread cost.

  it('write rejects when input fails the schema', async () => {
    const out = await dispatcher.write({ app: 'todos', action: 'add', input: {} });
    assert.equal(out.isError, true);
    if (out.isError) {
      assert.equal(out.structuredContent.code, 'INVALID_INPUT');
    }
  });

  it('write returns WRONG_KIND when addressing a query', async () => {
    const out = await dispatcher.write({ app: 'todos', action: 'list', input: {} });
    assert.equal(out.isError, true);
    if (out.isError) {
      assert.equal(out.structuredContent.code, 'WRONG_KIND');
    }
  });

  it('read returns WRONG_KIND when addressing an action', async () => {
    const out = await dispatcher.read({ app: 'todos', query: 'add', input: {} });
    assert.equal(out.isError, true);
    if (out.isError) {
      assert.equal(out.structuredContent.code, 'WRONG_KIND');
    }
  });

  it('write returns UNKNOWN_ACTION for a missing action', async () => {
    const out = await dispatcher.write({
      app: 'todos',
      action: 'phantom',
      input: { text: 'x' },
    });
    assert.equal(out.isError, true);
    if (out.isError) {
      assert.equal(out.structuredContent.code, 'UNKNOWN_ACTION');
    }
  });

  it('read returns UNKNOWN_QUERY for a missing query', async () => {
    const out = await dispatcher.read({ app: 'todos', query: 'phantom' });
    assert.equal(out.isError, true);
    if (out.isError) {
      assert.equal(out.structuredContent.code, 'UNKNOWN_QUERY');
    }
  });

  it('write returns UNKNOWN_APP for an unregistered app', async () => {
    const out = await dispatcher.write({
      app: 'ghost',
      action: 'add',
      input: { text: 'x' },
    });
    assert.equal(out.isError, true);
    if (out.isError) {
      assert.equal(out.structuredContent.code, 'UNKNOWN_APP');
    }
  });
});

describe('manifest validation surfaces as INVALID_MANIFEST', () => {
  let workDir: string;
  let registry: Registry;
  let dispatcher: Dispatcher;

  before(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-dispatcher-bad-'));
    const codeDir = path.join(workDir, 'broken');
    await fs.mkdir(codeDir, { recursive: true });
    await writeJson(path.join(codeDir, 'app.json'), {
      // Missing manifestVersion + actions/queries
      id: 'broken',
      name: 'Broken',
      version: '0.1.0',
    });
    registry = new Registry(workDir);
    await registry.load();
    await registry.register({ id: 'broken', path: codeDir, mode: 'path' });
    dispatcher = new Dispatcher({ registry, versions: new VersionStore() });
  });

  after(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('write surfaces INVALID_MANIFEST', async () => {
    const out = await dispatcher.write({
      app: 'broken',
      action: 'anything',
      input: {},
    });
    assert.equal(out.isError, true);
    if (out.isError) {
      assert.equal(out.structuredContent.code, 'INVALID_MANIFEST');
    }
  });
});

describe('tool naming helpers', () => {
  it('isToolName accepts only the three', () => {
    assert.equal(isToolName('centraid_write'), true);
    assert.equal(isToolName('centraid_read'), true);
    assert.equal(isToolName('centraid_describe'), true);
    assert.equal(isToolName('centraid_sql_read'), false);
    assert.equal(isToolName('whatever'), false);
  });

  it('statusForToolError maps codes to sensible statuses', () => {
    assert.equal(statusForToolError('UNKNOWN_APP'), 404);
    assert.equal(statusForToolError('UNKNOWN_ACTION'), 404);
    assert.equal(statusForToolError('UNKNOWN_QUERY'), 404);
    assert.equal(statusForToolError('WRONG_KIND'), 400);
    assert.equal(statusForToolError('INVALID_INPUT'), 400);
    assert.equal(statusForToolError('INVALID_MANIFEST'), 500);
    assert.equal(statusForToolError('NO_ACTIVE_VERSION'), 503);
    assert.equal(statusForToolError('HANDLER_ERROR'), 500);
  });
});
