import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  runAutomationHandler,
  type AutomationToolDispatcher,
  type AutomationAgentDispatcher,
  type AutomationInvokeDispatcher,
} from './automation-handler-runner.js';
import { AutomationRunsStore } from './automation-runs-store.js';
import { automationsDbPath } from './automation-runs-schema.js';

interface Harness {
  appDir: string;
  store: AutomationRunsStore;
  writeHandler(filename: string, source: string): string;
}

function makeHarness(): Harness {
  const appDir = mkdtempSync(path.join(tmpdir(), 'centraid-handler-runner-'));
  const actionsDir = path.join(appDir, 'actions');
  mkdirSync(actionsDir, { recursive: true });
  const store = new AutomationRunsStore(automationsDbPath(appDir));
  return {
    appDir,
    store,
    writeHandler(filename, source) {
      const file = path.join(actionsDir, filename);
      writeFileSync(file, source, 'utf8');
      return file;
    },
  };
}

function makeRunId(name: string): string {
  return `${name}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

const okDispatcher: AutomationToolDispatcher = async (calls) =>
  calls.map((c) => ({ ok: true, result: { ack: c.name } }));

const okAgentDispatcher: AutomationAgentDispatcher = async () => 'agent-result';

describe('runAutomationHandler audit (issue #80)', () => {
  it('writes one runs row plus one run_nodes row per ctx.tool / ctx.agent call', async () => {
    const h = makeHarness();
    const handlerFile = h.writeHandler(
      'single.js',
      `export default async ({ ctx }) => {
        await ctx.tool('mcp.foo', { x: 1 });
        await ctx.agent({ prompt: 'hi' });
        return { summary: 'done' };
      };`,
    );
    const runId = makeRunId('single');
    const outcome = await runAutomationHandler({
      app: { id: 'todos', dir: h.appDir },
      handlerFile,
      automationName: 'single',
      runId,
      toolDispatcher: okDispatcher,
      agentDispatcher: okAgentDispatcher,
      runsStore: h.store,
    });
    assert.equal(outcome.ok, true);
    const row = h.store.getRun(runId);
    assert.ok(row);
    assert.equal(row.ok, true);
    assert.equal(row.summary, 'done');
    const nodes = h.store.listNodes(runId);
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0]?.kind, 'tool');
    assert.equal(nodes[0]?.name, 'mcp.foo');
    assert.equal(nodes[0]?.batchId, undefined); // solo call
    assert.equal(nodes[1]?.kind, 'agent');
    assert.equal(nodes[1]?.ok, true);
    h.store.close();
  });

  it('shares a batch_id across Promise.all batched ctx.tool calls', async () => {
    const h = makeHarness();
    const handlerFile = h.writeHandler(
      'parallel.js',
      `export default async ({ ctx }) => {
        await Promise.all([
          ctx.tool('mcp.a', {}),
          ctx.tool('mcp.b', {}),
          ctx.tool('mcp.c', {}),
        ]);
      };`,
    );
    const runId = makeRunId('parallel');
    const outcome = await runAutomationHandler({
      app: { id: 'todos', dir: h.appDir },
      handlerFile,
      automationName: 'parallel',
      runId,
      toolDispatcher: okDispatcher,
      agentDispatcher: okAgentDispatcher,
      runsStore: h.store,
    });
    assert.equal(outcome.ok, true);
    const nodes = h.store.listNodes(runId);
    assert.equal(nodes.length, 3);
    const batchIds = new Set(nodes.map((n) => n.batchId));
    assert.equal(batchIds.size, 1);
    assert.notEqual([...batchIds][0], undefined);
    h.store.close();
  });

  it('a failed ctx.tool rejects the handler Promise; handler-side try/catch owns retry', async () => {
    const h = makeHarness();
    // The handler retries itself via try/catch — the runtime does no
    // retrying. Each attempt is a distinct ctx.tool call → distinct node.
    const handlerFile = h.writeHandler(
      'retry.js',
      `export default async ({ ctx }) => {
        let lastErr;
        for (let i = 0; i < 3; i++) {
          try {
            const r = await ctx.tool('flaky.tool', { attempt: i });
            return { summary: 'ok after ' + i };
          } catch (e) {
            lastErr = e;
          }
        }
        throw lastErr;
      };`,
    );
    let calls = 0;
    const transientFail: AutomationToolDispatcher = async (cs) =>
      cs.map(() => {
        calls++;
        return calls < 3 ? { ok: false, error: 'transient' } : { ok: true, result: 'finally' };
      });
    const runId = makeRunId('retry');
    const outcome = await runAutomationHandler({
      app: { id: 'todos', dir: h.appDir },
      handlerFile,
      automationName: 'retry',
      runId,
      toolDispatcher: transientFail,
      agentDispatcher: okAgentDispatcher,
      runsStore: h.store,
    });
    assert.equal(outcome.ok, true);
    // Three distinct ctx.tool calls → three nodes with ascending ordinal.
    const nodes = h.store.listNodes(runId);
    assert.equal(nodes.length, 3);
    assert.deepEqual(
      nodes.map((n) => [n.ordinal, n.ok]),
      [
        [0, false],
        [1, false],
        [2, true],
      ],
    );
    h.store.close();
  });

  it('a failed ctx.tool the handler does not catch fails the run', async () => {
    const h = makeHarness();
    const handlerFile = h.writeHandler(
      'uncaught.js',
      `export default async ({ ctx }) => {
        await ctx.tool('always.fails', {});
        return { summary: 'unreachable' };
      };`,
    );
    const failing: AutomationToolDispatcher = async (cs) =>
      cs.map(() => ({ ok: false, error: 'nope' }));
    const runId = makeRunId('uncaught');
    const outcome = await runAutomationHandler({
      app: { id: 'todos', dir: h.appDir },
      handlerFile,
      automationName: 'uncaught',
      runId,
      toolDispatcher: failing,
      agentDispatcher: okAgentDispatcher,
      runsStore: h.store,
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /nope/);
    const nodes = h.store.listNodes(runId);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0]?.ok, false);
    assert.equal(nodes[0]?.error, 'nope');
    h.store.close();
  });

  it('ctx.state.set in run 1 surfaces via ctx.state.get in run 2', async () => {
    const h = makeHarness();
    const setHandler = h.writeHandler(
      'set.js',
      `export default async ({ ctx }) => {
        await ctx.state.set('cursor', { since: 42, etag: 'abc' });
      };`,
    );
    const getHandler = h.writeHandler(
      'get.js',
      `export default async ({ ctx }) => {
        const v = await ctx.state.get('cursor');
        return { summary: 'got', output: v };
      };`,
    );
    const r1 = await runAutomationHandler({
      app: { id: 'todos', dir: h.appDir },
      handlerFile: setHandler,
      automationName: 'set-cursor',
      runId: makeRunId('set'),
      toolDispatcher: okDispatcher,
      agentDispatcher: okAgentDispatcher,
      runsStore: h.store,
    });
    assert.equal(r1.ok, true);
    const r2 = await runAutomationHandler({
      app: { id: 'todos', dir: h.appDir },
      handlerFile: getHandler,
      automationName: 'set-cursor', // same automation_name = same state scope
      runId: makeRunId('get'),
      toolDispatcher: okDispatcher,
      agentDispatcher: okAgentDispatcher,
      runsStore: h.store,
    });
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.output, { since: 42, etag: 'abc' });
    h.store.close();
  });

  it('ctx.runs.last returns the previous run record', async () => {
    const h = makeHarness();
    const recHandler = h.writeHandler(
      'rec.js',
      `export default async ({ ctx }) => {
        return { summary: 'first run done' };
      };`,
    );
    const seeHandler = h.writeHandler(
      'see.js',
      `export default async ({ ctx }) => {
        const last = await ctx.runs.last();
        return { summary: 'observed', output: { lastSummary: last && last.summary } };
      };`,
    );
    await runAutomationHandler({
      app: { id: 'todos', dir: h.appDir },
      handlerFile: recHandler,
      automationName: 'foo',
      runId: makeRunId('rec'),
      toolDispatcher: okDispatcher,
      agentDispatcher: okAgentDispatcher,
      runsStore: h.store,
    });
    const r2 = await runAutomationHandler({
      app: { id: 'todos', dir: h.appDir },
      handlerFile: seeHandler,
      automationName: 'foo',
      runId: makeRunId('see'),
      toolDispatcher: okDispatcher,
      agentDispatcher: okAgentDispatcher,
      runsStore: h.store,
    });
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.output, { lastSummary: 'first run done' });
    h.store.close();
  });

  it('outputSchema rejection turns ok=true into ok=false with error', async () => {
    const h = makeHarness();
    const handler = h.writeHandler(
      'bad-shape.js',
      `export default async () => ({ summary: 's', output: { count: 'not-a-number' } });`,
    );
    const runId = makeRunId('shape');
    const outcome = await runAutomationHandler({
      app: { id: 'todos', dir: h.appDir },
      handlerFile: handler,
      automationName: 'shape',
      runId,
      toolDispatcher: okDispatcher,
      agentDispatcher: okAgentDispatcher,
      runsStore: h.store,
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'number' } },
        required: ['count'],
      },
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /outputSchema validation failed/);
    const row = h.store.getRun(runId);
    assert.equal(row?.ok, false);
    h.store.close();
  });

  it('history.keep prunes older runs at end-of-run', async () => {
    const h = makeHarness();
    const handler = h.writeHandler('noop.js', `export default async () => ({ summary: 'n' });`);
    for (let i = 0; i < 5; i++) {
      await runAutomationHandler({
        app: { id: 'todos', dir: h.appDir },
        handlerFile: handler,
        automationName: 'noop',
        runId: makeRunId(`n${i}`),
        toolDispatcher: okDispatcher,
        agentDispatcher: okAgentDispatcher,
        runsStore: h.store,
        history: { keep: { count: 2 } },
      });
    }
    assert.equal(h.store.countRuns('noop'), 2);
    h.store.close();
  });

  it('ctx.invoke routes through the invokeDispatcher and propagates child output', async () => {
    const h = makeHarness();
    const childHandler = h.writeHandler('child.js', `export default async () => ({ output: 42 });`);
    const parentHandler = h.writeHandler(
      'parent.js',
      `export default async ({ ctx }) => {
        const r = await ctx.invoke('child', { input: { x: 1 } });
        return { summary: 'invoked', output: { childResult: r } };
      };`,
    );
    const invokeDispatcher: AutomationInvokeDispatcher = async (name, args, dispatchCtx) => {
      assert.equal(name, 'child');
      assert.deepEqual(args.input, { x: 1 });
      assert.equal(args.parentRunId, dispatchCtx.runId);
      const childRunId = makeRunId('child');
      const childOutcome = await runAutomationHandler({
        app: { id: dispatchCtx.appId, dir: h.appDir },
        handlerFile: childHandler,
        automationName: name,
        runId: childRunId,
        toolDispatcher: okDispatcher,
        agentDispatcher: okAgentDispatcher,
        runsStore: h.store,
        triggerKind: 'manual',
        parentRunId: args.parentRunId,
        input: args.input,
      });
      return childOutcome.output;
    };
    const parentRunId = makeRunId('parent');
    const out = await runAutomationHandler({
      app: { id: 'todos', dir: h.appDir },
      handlerFile: parentHandler,
      automationName: 'parent',
      runId: parentRunId,
      toolDispatcher: okDispatcher,
      agentDispatcher: okAgentDispatcher,
      invokeDispatcher,
      runsStore: h.store,
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.output, { childResult: 42 });
    // Child run is linked back to the parent run.
    const childRows = h.store.listRuns({ name: 'child' });
    assert.equal(childRows.length, 1);
    assert.equal(childRows[0]?.parentRunId, parentRunId);
    h.store.close();
  });

  it('truncates oversize args_json with a {_truncated, bytes, head} envelope', async () => {
    const h = makeHarness();
    const handler = h.writeHandler(
      'big.js',
      `export default async ({ ctx }) => {
        const big = 'x'.repeat(100000);
        await ctx.tool('mcp.echo', { big });
      };`,
    );
    const runId = makeRunId('big');
    await runAutomationHandler({
      app: { id: 'todos', dir: h.appDir },
      handlerFile: handler,
      automationName: 'big',
      runId,
      toolDispatcher: okDispatcher,
      agentDispatcher: okAgentDispatcher,
      runsStore: h.store,
    });
    const nodes = h.store.listNodes(runId);
    assert.equal(nodes.length, 1);
    const parsed = JSON.parse(nodes[0]!.argsJson!) as { _truncated?: boolean; bytes?: number };
    assert.equal(parsed._truncated, true);
    assert.ok((parsed.bytes ?? 0) > 64 * 1024);
    h.store.close();
  });
});
