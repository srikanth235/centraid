/*
 * Host-agnostic persistent mock session (issue #166).
 *
 * Drives `startPersistentMockSession` with a FAKE `driveAgent` that speaks the
 * mock's Anthropic Messages wire over real HTTP: it parks on the initial
 * request until a turn is staged, executes each staged tool, posts the
 * tool_result back, and loops until the driver stages `end_turn`. This is the
 * exact shape a real host driver (a `codex exec` subprocess) takes — so this
 * proves the shared session works without a real agent binary.
 */

import { describe, expect, it } from 'vitest';
import { startPersistentMockSession, type AgentDriver } from './persistent-mock-session.js';
import type { DispatchContext } from '../handler/runner.js';

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * A fake agent driver that runs the mock's tool-execution loop over HTTP.
 * `execTool` computes the result a real integration would return. Resolves
 * when the mock returns a turn with no tool_use (end_turn) or on abort.
 */
function makeFakeDriver(opts: {
  execTool: (
    name: string,
    input: Record<string, unknown>,
  ) => { content: string; isError?: boolean };
  onStart: () => void;
}): AgentDriver {
  return async (input) => {
    opts.onStart();
    const url = `${input.mockBaseUrl}/messages`;
    const headers = {
      authorization: `Bearer ${input.mockBearerToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
    };
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: input.prompt },
    ];
    try {
      for (let i = 0; i < 100; i++) {
        if (input.abortSignal.aborted) return { ok: false, error: 'aborted' };
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ messages }),
        });
        if (res.status !== 200) return { ok: false, error: `mock returned ${res.status}` };
        const body = (await res.json()) as {
          content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
        };
        const toolUses = body.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
        if (toolUses.length === 0) return { ok: true };
        messages.push({ role: 'assistant', content: body.content });
        messages.push({
          role: 'user',
          content: toolUses.map((tu) => {
            const out = opts.execTool(tu.name, tu.input ?? {});
            return {
              type: 'tool_result',
              tool_use_id: tu.id,
              content: out.content,
              is_error: out.isError === true,
            };
          }),
        });
      }
      return { ok: false, error: 'loop guard tripped' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
}

function fakeCtx(): DispatchContext {
  return { runId: 'run-1', automationId: 'app/auto', abortSignal: new AbortController().signal };
}

describe('startPersistentMockSession (issue #166)', () => {
  it('runs many ctx.tool batches through ONE agent session', async () => {
    let starts = 0;
    const session = await startPersistentMockSession({
      workdir: '/tmp',
      automationId: 'app/auto',
      driveAgent: makeFakeDriver({
        onStart: () => starts++,
        execTool: (name, input) => {
          if (name === 'add')
            return { content: JSON.stringify((input.a as number) + (input.b as number)) };
          if (name === 'double') return { content: JSON.stringify((input.n as number) * 2) };
          return { content: 'null' };
        },
      }),
    });
    try {
      const ctx = fakeCtx();
      const r1 = await session.toolDispatcher([{ name: 'add', args: { a: 7, b: 8 } }], ctx);
      expect(r1[0]!.ok).toBe(true);
      expect(r1[0]!.result).toBe(15);

      const r2 = await session.toolDispatcher([{ name: 'double', args: { n: 15 } }], ctx);
      expect(r2[0]!.result).toBe(30);

      const r3 = await session.toolDispatcher(
        [
          { name: 'add', args: { a: 1, b: 2 } },
          { name: 'double', args: { n: 5 } },
        ],
        ctx,
      );
      expect(r3[0]!.result).toBe(3);
      expect(r3[1]!.result).toBe(10);

      // ONE session drove every batch.
      expect(starts).toBe(1);
      // Per-call timing carried through (issue #158).
      expect(typeof r1[0]!.startedAt).toBe('number');
      expect(typeof r1[0]!.endedAt).toBe('number');
    } finally {
      await session.close();
    }
  });

  it('does not start an agent session when no ctx.tool batch runs', async () => {
    let starts = 0;
    const session = await startPersistentMockSession({
      workdir: '/tmp',
      automationId: 'app/auto',
      driveAgent: makeFakeDriver({ onStart: () => starts++, execTool: () => ({ content: '{}' }) }),
    });
    await session.close();
    expect(starts).toBe(0);
  });

  it('surfaces a tool error as a failed result', async () => {
    const session = await startPersistentMockSession({
      workdir: '/tmp',
      automationId: 'app/auto',
      driveAgent: makeFakeDriver({
        onStart: () => undefined,
        execTool: () => ({ content: 'boom', isError: true }),
      }),
    });
    try {
      const r = await session.toolDispatcher([{ name: 'boom', args: {} }], fakeCtx());
      expect(r[0]!.ok).toBe(false);
      expect(r[0]!.error).toBe('boom');
    } finally {
      await session.close();
    }
  });

  // A live claude-code hang surfaced this: a host agent that receives a
  // `tool_use` it can never resolve (no built-in, no MCP server for that
  // name) can leave the mock's parked request open forever with no error and
  // no follow-up request — `driveAgent` here reproduces exactly that shape by
  // starting the session and then never touching the mock again.
  it('fails a batch fast when the host agent never returns a tool_result', async () => {
    const session = await startPersistentMockSession({
      workdir: '/tmp',
      automationId: 'app/auto',
      driveAgent: () => new Promise(() => {}),
      toolBatchTimeoutMs: 20,
    });
    try {
      const r = await session.toolDispatcher([{ name: 'example.list_items', args: {} }], fakeCtx());
      expect(r[0]!.ok).toBe(false);
      expect(r[0]!.error).toMatch(/did not return a tool_result/);
      expect(r[0]!.error).toMatch(/example\.list_items/);
    } finally {
      // `close()` waits (bounded, up to 5s) for the never-resolving
      // driveAgent promise, since the session never reported `exited`.
      await session.close();
    }
  }, 10000);

  it('poisons the session after one timeout so later batches fail immediately too', async () => {
    const session = await startPersistentMockSession({
      workdir: '/tmp',
      automationId: 'app/auto',
      driveAgent: () => new Promise(() => {}),
      toolBatchTimeoutMs: 20,
    });
    try {
      await session.toolDispatcher([{ name: 'stuck.one', args: {} }], fakeCtx());
      const t0 = Date.now();
      const r = await session.toolDispatcher([{ name: 'stuck.two', args: {} }], fakeCtx());
      // The second batch must NOT wait out its own 20ms deadline — the
      // session was already poisoned by the first timeout.
      expect(Date.now() - t0).toBeLessThan(15);
      expect(r[0]!.ok).toBe(false);
    } finally {
      await session.close();
    }
  }, 10000);
});
