import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Dispatcher, Registry, type ToolContext, type TurnStreamEvent } from '@centraid/app-engine';
import { centraidDynamicToolSpecs, handleCentraidToolCall } from './host-tools.js';

// A minimal real app on disk so the dispatcher resolves real handlers against a
// real sqlite db (TESTING.md: real deps, fake only at the edges). The tool layer
// under test is exercised end-to-end, not against a stubbed dispatcher.
async function makeTodoApp(codeRoot: string, appId = 'todos'): Promise<void> {
  const dir = path.join(codeRoot, appId);
  await fs.mkdir(path.join(dir, 'actions'), { recursive: true });
  await fs.mkdir(path.join(dir, 'queries'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'app.json'),
    JSON.stringify({
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
        { name: 'list', input: { type: 'object', properties: {}, additionalProperties: false } },
      ],
    }),
  );
  await fs.writeFile(
    path.join(dir, 'actions', 'add.js'),
    `export default async ({ body, db }) => {
       await db.exec('CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, text TEXT)');
       const r = await db.prepare('INSERT INTO todos(text) VALUES (?)').run(String(body?.text ?? ''));
       return { status: 200, body: { id: Number(r.lastInsertRowid), text: String(body?.text ?? '') } };
     };\n`,
  );
  await fs.writeFile(
    path.join(dir, 'queries', 'list.js'),
    `export default async ({ db }) => {
       await db.exec('CREATE TABLE IF NOT EXISTS todos(id INTEGER PRIMARY KEY, text TEXT)');
       return await db.prepare('SELECT id, text FROM todos ORDER BY id').all();
     };\n`,
  );
}

describe('centraidDynamicToolSpecs', () => {
  it('declares exactly the three first-class centraid tools', () => {
    expect(centraidDynamicToolSpecs().map((s) => s.name)).toEqual([
      'centraid_describe',
      'centraid_read',
      'centraid_write',
    ]);
  });

  it('gives every tool a description and a closed object input schema', () => {
    for (const spec of centraidDynamicToolSpecs()) {
      expect(spec.description.length).toBeGreaterThan(0);
      const schema = spec.inputSchema as { type: string; additionalProperties: boolean };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it('marks the right required field on read and write', () => {
    const byName = Object.fromEntries(
      centraidDynamicToolSpecs().map((s) => [s.name, s.inputSchema]),
    );
    expect((byName.centraid_read as { required: string[] }).required).toEqual(['query']);
    expect((byName.centraid_write as { required: string[] }).required).toEqual(['action']);
    expect((byName.centraid_describe as { required?: string[] }).required).toBeUndefined();
  });
});

describe('handleCentraidToolCall', () => {
  let workDir: string;
  let codeRoot: string;
  let ctx: ToolContext;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-codex-tools-'));
    codeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-codex-tools-code-'));
    await makeTodoApp(codeRoot, 'todos');
    const registry = new Registry(workDir);
    await registry.load();
    await registry.ensureUploaded('todos');
    const dispatcher = new Dispatcher({
      registry,
      codeDirOverride: async (appId) => path.join(codeRoot, appId),
    });
    ctx = { appId: 'todos', dispatcher, turnId: 't1' };
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(codeRoot, { recursive: true, force: true });
  });

  const events = (o: { events: TurnStreamEvent[] }): TurnStreamEvent['type'][] =>
    o.events.map((e) => e.type);

  it('describes the app and echoes a JSON-RPC success with the dispatcher payload', async () => {
    const out = await handleCentraidToolCall(1, { tool: 'centraid_describe', arguments: {} }, ctx);
    expect(out.response).toMatchObject({ jsonrpc: '2.0', id: 1, result: { success: true } });
    expect(events(out)).toEqual(['tool.start', 'tool.result']);
    const text = out.response.result.contentItems[0]!.text;
    expect(text).toContain('todos');
  });

  it('routes a write through the real action and persists, then a read sees it', async () => {
    const w = await handleCentraidToolCall(
      2,
      {
        tool: 'centraid_write',
        callId: 'c2',
        arguments: { action: 'add', input: { text: 'milk' } },
      },
      ctx,
    );
    expect(w.response.result.success).toBe(true);
    const start = w.events[0]!;
    expect(start).toMatchObject({
      type: 'tool.start',
      toolCallId: 'c2',
      toolName: 'centraid_write',
    });

    const r = await handleCentraidToolCall(
      3,
      { tool: 'centraid_read', arguments: { query: 'list' } },
      ctx,
    );
    expect(r.response.result.success).toBe(true);
    expect(r.response.result.contentItems[0]!.text).toContain('milk');
  });

  it('surfaces the SQL on the tool.start event for an ad-hoc _sql read', async () => {
    const out = await handleCentraidToolCall(
      4,
      { tool: 'centraid_read', arguments: { query: '_sql', input: { sql: 'SELECT 1 AS one' } } },
      ctx,
    );
    expect(out.response.result.success).toBe(true);
    expect(out.events[0]).toMatchObject({ type: 'tool.start', sql: 'SELECT 1 AS one' });
  });

  it('falls back to a synthetic callId when codex omits one', async () => {
    const out = await handleCentraidToolCall(7, { tool: 'centraid_describe', arguments: {} }, ctx);
    expect(out.events[0]).toMatchObject({ toolCallId: 'tool-7' });
  });

  it('maps a dispatcher error to success:false with the coded message', async () => {
    const out = await handleCentraidToolCall(
      5,
      { tool: 'centraid_read', arguments: { query: 'does_not_exist' } },
      ctx,
    );
    expect(out.response.result.success).toBe(false);
    const result = out.events[1]!;
    expect(result).toMatchObject({ type: 'tool.result', ok: false });
    expect(out.response.result.contentItems[0]!.text).toMatch(/^\[\w+\]/); // [code] message
  });

  it('rejects an unknown tool name without touching the dispatcher', async () => {
    const out = await handleCentraidToolCall(6, { tool: 'centraid_nope', arguments: {} }, ctx);
    expect(out.response.result.success).toBe(false);
    expect(out.response.result.contentItems[0]!.text).toContain('unknown tool');
  });

  it('requires a query for read and an action for write', async () => {
    const noQuery = await handleCentraidToolCall(8, { tool: 'centraid_read', arguments: {} }, ctx);
    expect(noQuery.response.result.contentItems[0]!.text).toContain('query argument required');

    const noAction = await handleCentraidToolCall(
      9,
      { tool: 'centraid_write', arguments: {} },
      ctx,
    );
    expect(noAction.response.result.contentItems[0]!.text).toContain('action argument required');
  });
});

describe('the vault register (issue #286)', () => {
  const vaultCtx = (over: Partial<ToolContext> = {}): ToolContext =>
    ({
      appId: '_assistant',
      dispatcher: null as unknown as Dispatcher,
      turnId: 't',
      vaultSql: (sql: string) => ({
        columns: ['n'],
        rows: [{ n: 1, sql }],
        totalRows: 1,
        truncated: false,
        durationMs: 1,
      }),
      ...over,
    }) as ToolContext;

  it('swaps the trio for vault_sql (and vault_invoke when wired)', () => {
    const readOnly = centraidDynamicToolSpecs(vaultCtx());
    expect(readOnly.map((t) => t.name)).toEqual(['vault_sql']);
    const withWrites = centraidDynamicToolSpecs(
      vaultCtx({ vaultInvoke: () => ({ status: 'executed' }) }),
    );
    expect(withWrites.map((t) => t.name)).toEqual(['vault_sql', 'vault_invoke']);
    // No vault register → the app-scoped trio, unchanged.
    expect(centraidDynamicToolSpecs().map((t) => t.name)).toEqual([
      'centraid_describe',
      'centraid_read',
      'centraid_write',
    ]);
  });

  it('dispatches vault_sql through the owner runner and surfaces the sql on tool.start', async () => {
    const out = await handleCentraidToolCall(
      1,
      { tool: 'vault_sql', callId: 'c1', arguments: { sql: 'SELECT 1' } },
      vaultCtx(),
    );
    expect(out.response.result.success).toBe(true);
    const start = out.events[0] as Extract<TurnStreamEvent, { type: 'tool.start' }>;
    expect(start.sql).toBe('SELECT 1');
    const result = out.events[1] as Extract<TurnStreamEvent, { type: 'tool.result' }>;
    expect(result.ok).toBe(true);
  });

  it('dispatches vault_invoke and hands the outcome back verbatim', async () => {
    const calls: unknown[] = [];
    const ctx = vaultCtx({
      vaultInvoke: (call) => {
        calls.push(call);
        return { status: 'parked', invocationId: 'i1', reason: 'risk high exceeds ceiling' };
      },
    });
    const out = await handleCentraidToolCall(
      2,
      {
        tool: 'vault_invoke',
        callId: 'c2',
        arguments: { command: 'social.send_message', input: { message_id: 'm1' } },
      },
      ctx,
    );
    expect(calls).toEqual([{ command: 'social.send_message', input: { message_id: 'm1' } }]);
    expect(out.response.result.success).toBe(true);
    expect(out.response.result.contentItems[0]?.text).toContain('"parked"');
  });

  it('a runner throw comes back as a tool error, not an exception', async () => {
    const ctx = vaultCtx({
      vaultSql: () => {
        throw new Error('sql failed: no such table nope');
      },
    });
    const out = await handleCentraidToolCall(
      3,
      { tool: 'vault_sql', callId: 'c3', arguments: { sql: 'SELECT * FROM nope' } },
      ctx,
    );
    expect(out.response.result.success).toBe(false);
    expect(out.response.result.contentItems[0]?.text).toContain('no such table');
  });
});
