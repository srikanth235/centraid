/*
 * Persistent-session dispatch (issue #166).
 *
 * Drives `startLiveDispatch` with a FAKE persistent CLI that speaks the
 * mock's Anthropic Messages wire over real HTTP: it parks on the initial
 * request until a turn is staged, executes each staged tool, posts the
 * tool_result back, and loops until the driver stages `end_turn`. This
 * exercises the whole Phase 1 flow — one session across many `ctx.tool`
 * batches, no per-batch spawn — without a real codex/claude binary.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { startLiveDispatch } from './run-automation-live-dispatch.js';
import type { SpawnCli, SpawnCliInput, SpawnCliResult } from './run-automation-cli-spawn.js';

interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * A fake CLI that runs the mock's tool-execution loop over HTTP. `execTool`
 * computes the result a real integration would return. Resolves when the
 * mock returns a turn with no tool_use (end_turn) or the run is aborted.
 */
function makeFakePersistentCli(opts: {
  execTool: (name: string, input: Record<string, unknown>) => string;
  /** Counts spawns so the test can assert exactly one session. */
  onSpawn: () => void;
}): SpawnCli {
  return async (input: SpawnCliInput): Promise<SpawnCliResult> => {
    opts.onSpawn();
    const url = `${input.mockBaseUrl}/messages`;
    const headers = {
      authorization: `Bearer ${input.mockBearerToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
    };
    // Anthropic-style running transcript. Starts with the session prompt.
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'user', content: input.prompt },
    ];

    try {
      // Bounded loop guard — a healthy run ends on end_turn well before this.
      for (let i = 0; i < 100; i++) {
        if (input.abortSignal.aborted) return { exitCode: null, ok: false, stderr: 'aborted' };
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ messages }),
        });
        if (res.status !== 200) {
          return { exitCode: 1, ok: false, stderr: `mock returned ${res.status}` };
        }
        const body = (await res.json()) as {
          content: Array<{ type: string; id?: string; name?: string; input?: unknown }>;
          stop_reason: string;
        };
        const toolUses = body.content.filter((b): b is ToolUseBlock => b.type === 'tool_use');
        if (toolUses.length === 0) {
          // end_turn — session complete.
          return { exitCode: 0, ok: true, stderr: '' };
        }
        // The assistant turn (the tool_use blocks), then the user turn with
        // tool_result blocks — exactly what a CLI sends on the back-half.
        messages.push({ role: 'assistant', content: body.content });
        messages.push({
          role: 'user',
          content: toolUses.map((tu) => ({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: opts.execTool(tu.name, tu.input ?? {}),
            is_error: false,
          })),
        });
      }
      return { exitCode: 1, ok: false, stderr: 'loop guard tripped' };
    } catch (err) {
      return { exitCode: 1, ok: false, stderr: err instanceof Error ? err.message : String(err) };
    }
  };
}

function fakeCtx(): { runId: string; automationId: string; abortSignal: AbortSignal } {
  return { runId: 'run-1', automationId: 'app/auto', abortSignal: new AbortController().signal };
}

async function withWorkdir<T>(fn: (workdir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-live-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

describe('startLiveDispatch — persistent session (issue #166)', () => {
  it('runs many ctx.tool batches through ONE CLI session', async () => {
    await withWorkdir(async (workdir) => {
      let spawns = 0;
      const spawnCli = makeFakePersistentCli({
        onSpawn: () => spawns++,
        // `add` sums its operands; `double` doubles; results are JSON.
        execTool: (name, input) => {
          if (name === 'add') return JSON.stringify((input.a as number) + (input.b as number));
          if (name === 'double') return JSON.stringify((input.n as number) * 2);
          return JSON.stringify(null);
        },
      });
      const live = await startLiveDispatch({
        workdir,
        automationId: 'app/auto',
        runId: 'run-1',
        runner: 'claude-code',
        spawnCli,
        toolsAllow: [],
        onLog: () => undefined,
      });
      try {
        const ctx = fakeCtx();
        // Batch 1 → add(7, 8) = 15.
        const r1 = await live.toolDispatcher([{ name: 'add', args: { a: 7, b: 8 } }], ctx);
        assert.equal(r1.length, 1);
        assert.equal(r1[0]!.ok, true);
        assert.equal(r1[0]!.result, 15);

        // Batch 2 → double(15) = 30, depending on batch 1's result.
        const r2 = await live.toolDispatcher([{ name: 'double', args: { n: 15 } }], ctx);
        assert.equal(r2[0]!.ok, true);
        assert.equal(r2[0]!.result, 30);

        // Batch 3 → two calls in one batch.
        const r3 = await live.toolDispatcher(
          [
            { name: 'add', args: { a: 1, b: 2 } },
            { name: 'double', args: { n: 5 } },
          ],
          ctx,
        );
        assert.equal(r3[0]!.result, 3);
        assert.equal(r3[1]!.result, 10);

        // The whole run used exactly ONE CLI session.
        assert.equal(spawns, 1);

        // Per-call timing was captured (issue #158 carries through).
        assert.equal(typeof r1[0]!.startedAt, 'number');
        assert.equal(typeof r1[0]!.endedAt, 'number');
      } finally {
        await live.close();
      }
    });
  });

  it('does not spawn a CLI when no ctx.tool batch is dispatched', async () => {
    await withWorkdir(async (workdir) => {
      let spawns = 0;
      const live = await startLiveDispatch({
        workdir,
        automationId: 'app/auto',
        runId: 'run-2',
        runner: 'claude-code',
        spawnCli: makeFakePersistentCli({ onSpawn: () => spawns++, execTool: () => '{}' }),
        toolsAllow: [],
        onLog: () => undefined,
      });
      await live.close();
      assert.equal(spawns, 0);
    });
  });

  it('surfaces a tool error as a failed result', async () => {
    await withWorkdir(async (workdir) => {
      // A CLI that reports the tool errored.
      const spawnCli: SpawnCli = async (input) => {
        const url = `${input.mockBaseUrl}/messages`;
        const headers = {
          authorization: `Bearer ${input.mockBearerToken}`,
          accept: 'application/json',
          'content-type': 'application/json',
        };
        const messages: Array<{ role: string; content: unknown }> = [
          { role: 'user', content: input.prompt },
        ];
        for (let i = 0; i < 10; i++) {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ messages }),
          });
          const body = (await res.json()) as {
            content: Array<{ type: string; id?: string }>;
            stop_reason: string;
          };
          const toolUses = body.content.filter((b) => b.type === 'tool_use') as ToolUseBlock[];
          if (toolUses.length === 0) return { exitCode: 0, ok: true, stderr: '' };
          messages.push({ role: 'assistant', content: body.content });
          messages.push({
            role: 'user',
            content: toolUses.map((tu) => ({
              type: 'tool_result',
              tool_use_id: tu.id,
              content: 'boom',
              is_error: true,
            })),
          });
        }
        return { exitCode: 0, ok: true, stderr: '' };
      };
      const live = await startLiveDispatch({
        workdir,
        automationId: 'app/auto',
        runId: 'run-3',
        runner: 'claude-code',
        spawnCli,
        toolsAllow: [],
        onLog: () => undefined,
      });
      try {
        const r = await live.toolDispatcher([{ name: 'boom', args: {} }], fakeCtx());
        assert.equal(r[0]!.ok, false);
        assert.equal(r[0]!.error, 'boom');
      } finally {
        await live.close();
      }
    });
  });
});
