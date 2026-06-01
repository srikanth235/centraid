import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { Registry } from './registry.js';
import { Dispatcher, isToolName, statusForToolError } from './dispatcher.js';
import { runQuery } from './run-query.js';

const writeJson = (file: string, data: unknown) =>
  fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');

const writeFile = (file: string, body: string) => fs.writeFile(file, body, 'utf8');

/**
 * Build an app's CODE on disk under a git-store-style code root: the
 * dispatcher resolves it via `codeDirOverride` (issue #137). DATA lives
 * separately, under the registry's per-app dir.
 *
 *   <codeRoot>/<id>/
 *     app.json
 *     actions/<...>.js
 *     queries/<...>.js
 */
async function makeTodoApp(codeRoot: string, appId = 'todos'): Promise<void> {
  const versionDir = path.join(codeRoot, appId);
  await fs.mkdir(path.join(versionDir, 'actions'), { recursive: true });
  await fs.mkdir(path.join(versionDir, 'queries'), { recursive: true });

  await writeJson(path.join(versionDir, 'app.json'), {
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
    path.join(versionDir, 'actions', 'add.js'),
    `export default async ({ body, db }) => {
       await db.exec('CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, text TEXT)');
       const r = await db.prepare('INSERT INTO todos(text) VALUES (?)').run(String(body?.text ?? ''));
       return { status: 200, body: { id: Number(r.lastInsertRowid), text: String(body?.text ?? '') } };
     };\n`,
  );
  await writeFile(
    path.join(versionDir, 'queries', 'list.js'),
    `export default async ({ db }) => {
       await db.exec('CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, text TEXT)');
       return await db.prepare('SELECT id, text FROM todos ORDER BY id').all();
     };\n`,
  );
}

describe('Dispatcher', () => {
  let workDir: string;
  let codeRoot: string;
  let registry: Registry;
  let dispatcher: Dispatcher;

  before(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-dispatcher-'));
    codeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-dispatcher-code-'));
    await makeTodoApp(codeRoot, 'todos');
    registry = new Registry(workDir);
    await registry.load();
    await registry.ensureUploaded('todos');
    dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async (appId) => path.join(codeRoot, appId),
    });
  });

  after(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(codeRoot, { recursive: true, force: true });
  });

  it('describe with no filter returns a list of apps', async () => {
    const out = await dispatcher.describe({});
    assert.equal(out.isError, false);
    const body = out.structuredContent as { apps: Array<{ id: string }> };
    assert.equal(body.apps.length, 1);
    assert.equal(body.apps[0]!.id, 'todos');
  });

  it('describe with {app} returns the full manifest plus live schema', async () => {
    const out = await dispatcher.describe({ app: 'todos' });
    assert.equal(out.isError, false);
    const body = out.structuredContent as {
      manifest: { name: string; actions: Array<{ name: string }> };
      schema: { tables: unknown[] };
    };
    assert.equal(body.manifest.name, 'Todos');
    assert.equal(body.manifest.actions[0]!.name, 'add');
    assert.ok(Array.isArray(body.schema.tables));
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

  it('_sql query runs a SELECT and returns rows', async () => {
    // Seed the app's data.sqlite directly — the worker-thread handler
    // path isn't available to unit tests (no built `.js` worker bundle).
    const entry = registry.get('todos')!;
    runQuery(
      path.join(entry.path, 'data.sqlite'),
      'CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, text TEXT)',
    );
    runQuery(path.join(entry.path, 'data.sqlite'), "INSERT INTO todos (text) VALUES ('hello')");
    const out = await dispatcher.read({
      app: 'todos',
      query: '_sql',
      input: { sql: 'SELECT id, text FROM todos' },
    });
    assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
    const body = out.structuredContent as { columns: string[]; rows: unknown[] };
    assert.deepEqual(body.columns, ['id', 'text']);
    assert.equal(body.rows.length >= 1, true);
  });

  it('_sql query refuses INSERT', async () => {
    const out = await dispatcher.read({
      app: 'todos',
      query: '_sql',
      input: { sql: "INSERT INTO todos(text) VALUES ('x')" },
    });
    assert.equal(out.isError, true);
    if (out.isError) {
      assert.equal(out.structuredContent.code, 'INVALID_INPUT');
    }
  });

  it('_sql action runs an INSERT and returns rowsAffected', async () => {
    const entry = registry.get('todos')!;
    runQuery(
      path.join(entry.path, 'data.sqlite'),
      'CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY, text TEXT)',
    );
    const out = await dispatcher.write({
      app: 'todos',
      action: '_sql',
      input: { sql: "INSERT INTO todos(text) VALUES ('via-sql')" },
    });
    assert.equal(out.isError, false, JSON.stringify(out.structuredContent));
    const body = out.structuredContent as { rowsAffected: number };
    assert.equal(body.rowsAffected, 1);
  });

  it('_sql action refuses DDL', async () => {
    const out = await dispatcher.write({
      app: 'todos',
      action: '_sql',
      input: { sql: 'CREATE TABLE evil (id INTEGER)' },
    });
    assert.equal(out.isError, true);
    if (out.isError) {
      assert.equal(out.structuredContent.code, 'INVALID_INPUT');
    }
  });

  it('_sql without { sql } returns INVALID_INPUT', async () => {
    const out = await dispatcher.read({ app: 'todos', query: '_sql', input: {} });
    assert.equal(out.isError, true);
    if (out.isError) {
      assert.equal(out.structuredContent.code, 'INVALID_INPUT');
    }
  });

  it('_unknown built-in returns UNKNOWN_QUERY / UNKNOWN_ACTION', async () => {
    const r = await dispatcher.read({ app: 'todos', query: '_nope' });
    assert.equal(r.isError, true);
    if (r.isError) assert.equal(r.structuredContent.code, 'UNKNOWN_QUERY');
    const w = await dispatcher.write({ app: 'todos', action: '_nope' });
    assert.equal(w.isError, true);
    if (w.isError) assert.equal(w.structuredContent.code, 'UNKNOWN_ACTION');
  });
});

describe('manifest validation surfaces as INVALID_MANIFEST', () => {
  let workDir: string;
  let registry: Registry;
  let dispatcher: Dispatcher;

  let codeRoot: string;

  before(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-dispatcher-bad-'));
    codeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-dispatcher-bad-code-'));
    const codeDir = path.join(codeRoot, 'broken');
    await fs.mkdir(codeDir, { recursive: true });
    await writeJson(path.join(codeDir, 'app.json'), {
      // Missing manifestVersion + actions/queries
      id: 'broken',
      name: 'Broken',
      version: '0.1.0',
    });
    registry = new Registry(workDir);
    await registry.load();
    await registry.ensureUploaded('broken');
    dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async (appId) => path.join(codeRoot, appId),
    });
  });

  after(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(codeRoot, { recursive: true, force: true });
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

// Draft data branching (#144): with an `overrideCodeDir` (the session
// worktree), the dispatcher resolves data dir = code dir, so handler/`_sql`
// data ops and the describe schema read hit the worktree's branched
// `data.sqlite`, never the app's live rows.
describe('Dispatcher draft data dir = code dir (#144)', () => {
  let workDir: string;
  let codeRoot: string;
  let registry: Registry;
  let dispatcher: Dispatcher;
  let draftDir: string;

  before(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-dispatch-draft-'));
    codeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-dispatch-draft-code-'));
    await makeTodoApp(codeRoot, 'todos');
    registry = new Registry(workDir);
    await registry.load();
    await registry.ensureUploaded('todos');
    dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async (appId) => path.join(codeRoot, appId),
    });

    // Draft worktree dir: a valid code dir (app.json) holding its own
    // branched data.sqlite. Both live and draft start with a `notes` table
    // (so `_sql`, which refuses DDL, has somewhere to write); the draft also
    // gets a `draft_only` table to prove the describe schema is branched.
    draftDir = path.join(workDir, 'draft');
    await fs.mkdir(draftDir, { recursive: true });
    await fs.writeFile(
      path.join(draftDir, 'app.json'),
      JSON.stringify({ manifestVersion: 1, id: 'todos', name: 'Todos', version: '0.1.0' }),
    );
    for (const dir of [path.join(workDir, 'todos'), draftDir]) {
      const db = new DatabaseSync(path.join(dir, 'data.sqlite'));
      db.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)');
      db.close();
    }
    const ddb = new DatabaseSync(path.join(draftDir, 'data.sqlite'));
    ddb.exec('CREATE TABLE draft_only(x INTEGER)');
    ddb.close();
  });

  after(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(codeRoot, { recursive: true, force: true });
  });

  it('a draft _sql write lands in the worktree data.sqlite, never live', async () => {
    const w = await dispatcher.write(
      { app: 'todos', action: '_sql', input: { sql: "INSERT INTO notes(body) VALUES ('draft')" } },
      draftDir,
    );
    assert.equal(w.isError, false, JSON.stringify(w.structuredContent));

    // The draft read sees its own row… (SQLite returns null-prototype rows,
    // so compare by value rather than deep-equal against a plain literal)
    const draftResult = await dispatcher.read(
      { app: 'todos', query: '_sql', input: { sql: 'SELECT body FROM notes' } },
      draftDir,
    );
    const dRows = (draftResult.structuredContent as { rows: Array<{ body: string }> }).rows;
    assert.equal(dRows.length, 1);
    assert.equal(dRows[0]!.body, 'draft');

    // …while live data has no rows — isolation held.
    const liveRead = await dispatcher.read({
      app: 'todos',
      query: '_sql',
      input: { sql: 'SELECT body FROM notes' },
    });
    assert.equal((liveRead.structuredContent as { rows: unknown[] }).rows.length, 0);
  });

  it('describe reads the branched schema from the worktree in draft mode', async () => {
    const draftDesc = await dispatcher.describe({ app: 'todos' }, draftDir);
    const draftTables = (
      draftDesc.structuredContent as { schema: { tables: Array<{ name: string }> } }
    ).schema.tables.map((t) => t.name);
    assert.ok(draftTables.includes('draft_only'), `draft schema should branch: ${draftTables}`);

    const liveDesc = await dispatcher.describe({ app: 'todos' });
    const liveTables = (
      liveDesc.structuredContent as { schema: { tables: Array<{ name: string }> } }
    ).schema.tables.map((t) => t.name);
    assert.ok(!liveTables.includes('draft_only'), `live schema must not see the draft table`);
  });
});
