/*
 * Host-agnostic persistent mock session (issue #166).
 *
 * Drives `startPersistentMockSession` with a FAKE `driveAgent` that speaks the
 * mock's Anthropic Messages wire over real HTTP: it parks on the initial
 * request until a turn is staged, executes each staged tool, posts the
 * tool_result back, and loops until the driver stages `end_turn`. This is the
 * exact shape a real host driver (a `codex exec` subprocess, or OpenClaw's
 * `runEmbeddedAgent`) takes — so this proves the shared session works for ANY
 * host without a real agent binary.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startPersistentMockSession, type AgentDriver } from './persistent-mock-session.js';
import type { DispatchContext } from '../handler/handler-runner.js';

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
      assert.equal(r1[0]!.ok, true);
      assert.equal(r1[0]!.result, 15);

      const r2 = await session.toolDispatcher([{ name: 'double', args: { n: 15 } }], ctx);
      assert.equal(r2[0]!.result, 30);

      const r3 = await session.toolDispatcher(
        [
          { name: 'add', args: { a: 1, b: 2 } },
          { name: 'double', args: { n: 5 } },
        ],
        ctx,
      );
      assert.equal(r3[0]!.result, 3);
      assert.equal(r3[1]!.result, 10);

      // ONE session drove every batch.
      assert.equal(starts, 1);
      // Per-call timing carried through (issue #158).
      assert.equal(typeof r1[0]!.startedAt, 'number');
      assert.equal(typeof r1[0]!.endedAt, 'number');
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
    assert.equal(starts, 0);
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
      assert.equal(r[0]!.ok, false);
      assert.equal(r[0]!.error, 'boom');
    } finally {
      await session.close();
    }
  });
});
