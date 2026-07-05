// The codex dynamic-tool surface after issue #286 phase 2: the vault
// register is the ONE tool family. No runners on the turn → no data tools;
// the pre-vault centraid_* trio is gone entirely.

import { describe, expect, it } from 'vitest';
import type { Dispatcher, ToolContext, TurnStreamEvent } from '@centraid/app-engine';
import { centraidDynamicToolSpecs, handleCentraidToolCall } from './host-tools.js';

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

describe('centraidDynamicToolSpecs', () => {
  it('declares vault_sql (and vault_invoke when wired); nothing without runners', () => {
    const readOnly = centraidDynamicToolSpecs(vaultCtx());
    expect(readOnly.map((t) => t.name)).toEqual(['vault_sql']);
    const withWrites = centraidDynamicToolSpecs(
      vaultCtx({ vaultInvoke: () => ({ status: 'executed' }) }),
    );
    expect(withWrites.map((t) => t.name)).toEqual(['vault_sql', 'vault_invoke']);
    // The trio is dead: a context without vault runners declares NO tools.
    expect(centraidDynamicToolSpecs()).toEqual([]);
    expect(centraidDynamicToolSpecs(vaultCtx({ vaultSql: undefined }))).toEqual([]);
  });

  it('gives every declared tool a description and a closed object input schema', () => {
    for (const spec of centraidDynamicToolSpecs(
      vaultCtx({ vaultInvoke: () => ({ status: 'executed' }) }),
    )) {
      expect(spec.description.length).toBeGreaterThan(0);
      const schema = spec.inputSchema as { type: string; additionalProperties: boolean };
      expect(schema.type).toBe('object');
      expect(schema.additionalProperties).toBe(false);
    }
  });
});

describe('handleCentraidToolCall', () => {
  it('dispatches vault_sql through the owner runner and surfaces the sql on tool.start', async () => {
    const out = await handleCentraidToolCall(
      1,
      { tool: 'vault_sql', callId: 'c1', arguments: { sql: 'SELECT 1' } },
      vaultCtx(),
    );
    expect(out.response).toMatchObject({ jsonrpc: '2.0', id: 1, result: { success: true } });
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

  it('an unknown (or retired centraid_*) tool name maps to success:false', async () => {
    for (const tool of ['centraid_read', 'centraid_write', 'centraid_describe', 'nope']) {
      const out = await handleCentraidToolCall(4, { tool, arguments: {} }, vaultCtx());
      expect(out.response.result.success).toBe(false);
      expect(out.response.result.contentItems[0]?.text).toContain('unknown tool');
    }
  });

  it('falls back to a synthetic callId when codex omits one', async () => {
    const out = await handleCentraidToolCall(
      7,
      { tool: 'vault_sql', arguments: { sql: 'SELECT 1' } },
      vaultCtx(),
    );
    const start = out.events[0] as Extract<TurnStreamEvent, { type: 'tool.start' }>;
    expect(start.toolCallId).toBe('tool-7');
  });

  it('vault_invoke without a runner on the turn fails closed', async () => {
    const out = await handleCentraidToolCall(
      8,
      { tool: 'vault_invoke', arguments: { command: 'x.y', input: {} } },
      vaultCtx(),
    );
    expect(out.response.result.success).toBe(false);
    expect(out.response.result.contentItems[0]?.text).toContain('not available');
  });
});
