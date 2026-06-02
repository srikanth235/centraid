/*
 * Automation fire spine (issue #147, Concern 2). The per-fire orchestration
 * lives here in app-engine; the live `ctx.tool` / `ctx.agent` dispatch
 * surface is injected by the host via `openDispatch`. These tests run a real
 * (trivial) `handler.js` through `runAutomationFire` with a STUB dispatch
 * surface, proving the spine resolves the automation, opens its ledger, runs
 * the handler, and cascades `onFailure` — all without any agent-runtime
 * mock-LLM / CLI machinery.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunsStore, makeRuntimeDbProvider, type RunStreamEvent } from '@centraid/app-engine';
import {
  runAutomationFire,
  type AutomationDispatchSurface,
  type OpenAutomationDispatchArgs,
} from './automation-fire.js';
import type { AutomationManifest } from './automation-manifest.js';

function manifest(over: Partial<AutomationManifest> = {}): AutomationManifest {
  return {
    name: 'Digest',
    version: '0.1.0',
    enabled: true,
    prompt: 'do the thing',
    triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
    requires: {},
    history: { keep: { count: 100 } },
    generated: { by: 'test', at: '2026-05-22' },
    ...over,
  };
}

async function writeAutomation(
  appsDir: string,
  appId: string,
  id: string,
  m: AutomationManifest,
  handler = 'export default async () => ({ ok: true });',
): Promise<void> {
  const dir = path.join(appsDir, appId, 'automations', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'automation.json'), JSON.stringify(m, null, 2));
  await fs.writeFile(path.join(dir, 'handler.js'), handler);
}

/** A stub dispatch surface that records that it was opened + closed. The
 *  trivial handlers below never call `ctx.tool` / `ctx.agent`, so the
 *  dispatchers themselves are never invoked. */
function stubDispatch(opened: OpenAutomationDispatchArgs[], closes: { n: number }) {
  return (args: OpenAutomationDispatchArgs): Promise<AutomationDispatchSurface> => {
    opened.push(args);
    return Promise.resolve({
      toolDispatcher: async () => [],
      agentDispatcher: async () => '',
      async close() {
        closes.n += 1;
      },
    });
  };
}

describe('runAutomationFire', () => {
  let appsDir: string;

  beforeEach(async () => {
    appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-fire-'));
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  it('resolves the automation, opens an injected dispatch surface, and closes it', async () => {
    await writeAutomation(
      appsDir,
      'notes',
      'digest',
      manifest({ requires: { tools: ['mailer'] } }),
    );
    const opened: OpenAutomationDispatchArgs[] = [];
    const closes = { n: 0 };

    const { outcome, record } = await runAutomationFire(
      { automationRef: 'notes/digest', appsDir },
      { openDispatch: stubDispatch(opened, closes) },
    );

    assert.equal(outcome.ok, true);
    assert.equal(record.automationRef, 'notes/digest');
    assert.equal(record.automationName, 'Digest');

    // The spine opened exactly one dispatch surface, with the resolved app
    // dir as workdir and the manifest's tool allowlist forwarded.
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.automationRef, 'notes/digest');
    assert.deepEqual(opened[0]!.toolsAllow, ['mailer']);
    assert.match(opened[0]!.workdir, /notes[/\\]automations[/\\]digest$/);
    assert.equal(closes.n, 1, 'dispatch surface always torn down');
  });

  it('emits a live run-stream: run.start → node lifecycle per ctx call → run.end', async () => {
    // A handler that drives one ctx.tool then one ctx.agent. The stub
    // dispatch returns fixed results so the node lifecycle is deterministic.
    await writeAutomation(
      appsDir,
      'notes',
      'flow',
      manifest({ name: 'Flow' }),
      `export default async ({ ctx }) => {
         await ctx.tool('mailer', { to: 'x' });
         await ctx.agent({ prompt: 'summarize' });
         return { ok: true };
       };`,
    );
    const events: RunStreamEvent[] = [];
    const dispatch = (args: OpenAutomationDispatchArgs): Promise<AutomationDispatchSurface> => {
      void args;
      return Promise.resolve({
        toolDispatcher: async () => [{ ok: true, result: { sent: true } }],
        agentDispatcher: async () => 'a summary',
        async close() {},
      });
    };

    const { outcome } = await runAutomationFire(
      { automationRef: 'notes/flow', appsDir, onRunEvent: (ev) => events.push(ev) },
      { openDispatch: dispatch },
    );
    assert.equal(outcome.ok, true);

    // run.start first, run.end last.
    assert.equal(events.at(0)?.type, 'run.start');
    assert.equal(events.at(-1)?.type, 'run.end');
    const end = events.at(-1) as Extract<RunStreamEvent, { type: 'run.end' }>;
    assert.equal(end.ok, true);

    // Every node opened (start) before it closed (end), in dispatch order:
    // tool (ordinal 0) then agent (ordinal 1).
    const lifecycle = events.filter((e) => e.type === 'node.start' || e.type === 'node.end');
    assert.deepEqual(
      lifecycle.map((e) => [
        e.type,
        (e as { ordinal: number }).ordinal,
        (e as { kind?: string }).kind,
      ]),
      [
        ['node.start', 0, 'tool'],
        ['node.end', 0, undefined],
        ['node.start', 1, 'agent'],
        ['node.end', 1, undefined],
      ],
    );
    const toolStart = lifecycle[0] as Extract<RunStreamEvent, { type: 'node.start' }>;
    assert.equal(toolStart.name, 'mailer');
    assert.deepEqual(toolStart.args, { to: 'x' });
    const agentStart = lifecycle[2] as Extract<RunStreamEvent, { type: 'node.start' }>;
    assert.equal(agentStart.name, 'agent');
    assert.deepEqual(agentStart.args, { prompt: 'summarize' });
  });

  it('streams ctx.agent token deltas as node.delta and persists the usage rollup', async () => {
    await writeAutomation(
      appsDir,
      'notes',
      'ask',
      manifest({ name: 'Ask' }),
      `export default async ({ ctx }) => {
         const answer = await ctx.agent({ prompt: 'hi' });
         return { output: answer };
       };`,
    );
    const events: RunStreamEvent[] = [];
    // A stub agent dispatcher that behaves like a streaming chat adapter:
    // forward token deltas + a usage event through `call.onEvent`, then
    // return the final answer.
    const dispatch = (): Promise<AutomationDispatchSurface> =>
      Promise.resolve({
        toolDispatcher: async () => [],
        agentDispatcher: async (call) => {
          call.onEvent?.({ type: 'assistant.delta', delta: 'hel' });
          call.onEvent?.({ type: 'assistant.delta', delta: 'lo' });
          call.onEvent?.({
            type: 'usage',
            model: 'a-capable-model',
            provider: 'prov',
            inputTokens: 12,
            outputTokens: 3,
          });
          call.onEvent?.({ type: 'final', text: 'hello' });
          return 'hello';
        },
        async close() {},
      });

    const { outcome, record } = await runAutomationFire(
      { automationRef: 'notes/ask', appsDir, onRunEvent: (ev) => events.push(ev) },
      { openDispatch: dispatch },
    );
    assert.equal(outcome.ok, true);

    // Token deltas surfaced as node.delta on the agent node (ordinal 0).
    const deltas = events.filter((e) => e.type === 'node.delta');
    assert.ok(deltas.length >= 3, 'forwarded the chat stream events');
    assert.ok(deltas.every((d) => (d as { ordinal: number }).ordinal === 0));
    const deltaTypes = deltas.map((d) => ((d as { event: { type: string } }).event ?? {}).type);
    assert.ok(deltaTypes.includes('assistant.delta'));
    assert.ok(deltaTypes.includes('usage'));

    // The usage event was persisted onto the agent node's ledger row, so the
    // run's token rollup is accurate.
    const store = new AgentRunsStore(
      makeRuntimeDbProvider(path.join(appsDir, 'notes', 'runtime.sqlite')),
    );
    const agentNode = store.listNodes(record.runId).find((n) => n.kind === 'agent');
    assert.ok(agentNode, 'an agent node was recorded');
    assert.equal(agentNode.model, 'a-capable-model');
    assert.equal(agentNode.inputTokens, 12);
    assert.equal(agentNode.outputTokens, 3);
    const run = store.getRun(record.runId);
    assert.equal(run?.totalInputTokens, 12);
    assert.equal(run?.totalOutputTokens, 3);
    store.close();
  });

  it('records a ctx.tool node with the dispatcher-reported per-call window (Phase 3)', async () => {
    await writeAutomation(
      appsDir,
      'notes',
      'send',
      manifest({ name: 'Send' }),
      `export default async ({ ctx }) => {
         await ctx.tool('mailer', { to: 'x' });
         return { ok: true };
       };`,
    );
    // A dispatcher that reports a precise 250ms tool window (as the mock's
    // onToolStart/onToolResults would), distinct from the batch span.
    const dispatch = (): Promise<AutomationDispatchSurface> =>
      Promise.resolve({
        toolDispatcher: async () => [
          { ok: true, result: { sent: true }, startedAt: 1_000_000, endedAt: 1_000_250 },
        ],
        agentDispatcher: async () => '',
        async close() {},
      });

    const { record } = await runAutomationFire(
      { automationRef: 'notes/send', appsDir },
      { openDispatch: dispatch },
    );

    const store = new AgentRunsStore(
      makeRuntimeDbProvider(path.join(appsDir, 'notes', 'runtime.sqlite')),
    );
    const toolNode = store.listNodes(record.runId).find((n) => n.kind === 'tool');
    assert.ok(toolNode, 'a tool node was recorded');
    // Duration is the dispatcher's per-call window, not the batch span.
    assert.equal(toolNode.durationMs, 250);
    store.close();
  });

  it('settles tool nodes when the dispatcher rejects (no node stranded open)', async () => {
    // The handler swallows the ctx.tool rejection and finishes ok — so the run
    // ends while the tool node, opened before dispatch, must NOT stay
    // `ended_at = NULL`. The dispatcher rejects wholesale (CLI spawn blew up).
    await writeAutomation(
      appsDir,
      'notes',
      'flaky',
      manifest({ name: 'Flaky' }),
      `export default async ({ ctx }) => {
         try { await ctx.tool('mailer', { to: 'x' }); } catch { /* swallow */ }
         return { ok: true };
       };`,
    );
    const events: RunStreamEvent[] = [];
    const dispatch = (): Promise<AutomationDispatchSurface> =>
      Promise.resolve({
        toolDispatcher: async () => {
          throw new Error('spawn blew up');
        },
        agentDispatcher: async () => '',
        async close() {},
      });

    const { outcome, record } = await runAutomationFire(
      { automationRef: 'notes/flaky', appsDir, onRunEvent: (ev) => events.push(ev) },
      { openDispatch: dispatch },
    );
    assert.equal(outcome.ok, true, 'the handler swallowed the tool failure');

    // The tool node terminated on the live stream despite the rejection.
    const nodeEnds = events.filter((e) => e.type === 'node.end');
    assert.equal(nodeEnds.length, 1);
    const end = nodeEnds[0] as Extract<RunStreamEvent, { type: 'node.end' }>;
    assert.equal(end.ok, false);
    assert.match(String(end.error), /spawn blew up/);

    // And the ledger row is closed (duration set), not stranded open.
    const store = new AgentRunsStore(
      makeRuntimeDbProvider(path.join(appsDir, 'notes', 'runtime.sqlite')),
    );
    const toolNode = store.listNodes(record.runId).find((n) => n.kind === 'tool');
    assert.ok(toolNode, 'a tool node was recorded');
    assert.equal(toolNode.ok, false);
    assert.notEqual(toolNode.durationMs, undefined, 'the node was closed, not left running');
    store.close();
  });

  it('cascades onFailure through the SAME injected dispatch surface', async () => {
    // `main` throws → its onFailure target `recover` fires, both via the one
    // injected `openDispatch`. Proves the cascade stayed in the spine and did
    // not leak back into the host.
    await writeAutomation(
      appsDir,
      'notes',
      'main',
      manifest({ name: 'Main', onFailure: 'recover' }),
      'export default async () => { throw new Error("boom"); };',
    );
    await writeAutomation(appsDir, 'notes', 'recover', manifest({ name: 'Recover' }));

    const opened: OpenAutomationDispatchArgs[] = [];
    const closes = { n: 0 };

    const { outcome } = await runAutomationFire(
      { automationRef: 'notes/main', appsDir },
      { openDispatch: stubDispatch(opened, closes) },
    );

    assert.equal(outcome.ok, false, 'the primary fire failed');
    const refs = opened.map((o) => o.automationRef);
    assert.deepEqual(refs, ['notes/main', 'notes/recover'], 'onFailure cascade fired recover');
    assert.equal(closes.n, 2, 'both dispatch surfaces torn down');
  });
});
