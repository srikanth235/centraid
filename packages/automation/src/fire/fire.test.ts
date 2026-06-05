/*
 * Automation fire spine (issue #147, Concern 2). The per-fire orchestration
 * lives here in app-engine; the live `ctx.tool` / `ctx.agent` dispatch
 * surface is injected by the host via `openDispatch`. These tests run a real
 * (trivial) `handler.js` through `runFire` with a STUB dispatch
 * surface, proving the spine resolves the automation, opens its ledger, runs
 * the handler, and cascades `onFailure` — all without any agent-runtime
 * mock-LLM / CLI machinery.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ConversationStore,
  makeRuntimeDbProvider,
  type RunStreamEvent,
} from '@centraid/app-engine';
import { runFire, type DispatchSurface, type OpenDispatchArgs } from './fire.js';
import type { Manifest } from '../manifest/manifest.js';

function manifest(over: Partial<Manifest> = {}): Manifest {
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
  m: Manifest,
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
function stubDispatch(opened: OpenDispatchArgs[], closes: { n: number }) {
  return (args: OpenDispatchArgs): Promise<DispatchSurface> => {
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

describe('runFire', () => {
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
    const opened: OpenDispatchArgs[] = [];
    const closes = { n: 0 };

    const { outcome, record } = await runFire(
      { automationRef: 'notes/digest', appsDir },
      { openDispatch: stubDispatch(opened, closes) },
    );

    expect(outcome.ok).toBe(true);
    expect(record.automationRef).toBe('notes/digest');
    expect(record.automationName).toBe('Digest');

    // The spine opened exactly one dispatch surface, with the resolved app
    // dir as workdir and the manifest's tool allowlist forwarded.
    expect(opened.length).toBe(1);
    expect(opened[0]!.automationRef).toBe('notes/digest');
    expect(opened[0]!.toolsAllow).toEqual(['mailer']);
    expect(opened[0]!.workdir).toMatch(/notes[/\\]automations[/\\]digest$/);
    expect(closes.n).toBe(1);
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
    const dispatch = (args: OpenDispatchArgs): Promise<DispatchSurface> => {
      void args;
      return Promise.resolve({
        toolDispatcher: async () => [{ ok: true, result: { sent: true } }],
        agentDispatcher: async () => 'a summary',
        async close() {},
      });
    };

    const { outcome } = await runFire(
      { automationRef: 'notes/flow', appsDir, onRunEvent: (ev) => events.push(ev) },
      { openDispatch: dispatch },
    );
    expect(outcome.ok).toBe(true);

    // run.start first, run.end last.
    expect(events.at(0)?.type).toBe('run.start');
    expect(events.at(-1)?.type).toBe('run.end');
    const end = events.at(-1) as Extract<RunStreamEvent, { type: 'run.end' }>;
    expect(end.ok).toBe(true);

    // Every node opened (start) before it closed (end), in dispatch order:
    // tool (ordinal 0) then agent (ordinal 1).
    const lifecycle = events.filter((e) => e.type === 'node.start' || e.type === 'node.end');
    expect(
      lifecycle.map((e) => [
        e.type,
        (e as { ordinal: number }).ordinal,
        (e as { kind?: string }).kind,
      ]),
    ).toEqual([
      ['node.start', 0, 'tool'],
      ['node.end', 0, undefined],
      ['node.start', 1, 'agent'],
      ['node.end', 1, undefined],
    ]);
    const toolStart = lifecycle[0] as Extract<RunStreamEvent, { type: 'node.start' }>;
    expect(toolStart.name).toBe('mailer');
    expect(toolStart.args).toEqual({ to: 'x' });
    const agentStart = lifecycle[2] as Extract<RunStreamEvent, { type: 'node.start' }>;
    expect(agentStart.name).toBe('agent');
    expect(agentStart.args).toEqual({ prompt: 'summarize' });
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
    const dispatch = (): Promise<DispatchSurface> =>
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

    const { outcome, record } = await runFire(
      { automationRef: 'notes/ask', appsDir, onRunEvent: (ev) => events.push(ev) },
      { openDispatch: dispatch },
    );
    expect(outcome.ok).toBe(true);

    // Token deltas surfaced as node.delta on the agent node (ordinal 0).
    const deltas = events.filter((e) => e.type === 'node.delta');
    expect(deltas.length >= 3).toBeTruthy();
    expect(deltas.every((d) => (d as { ordinal: number }).ordinal === 0)).toBeTruthy();
    const deltaTypes = deltas.map((d) => ((d as { event: { type: string } }).event ?? {}).type);
    expect(deltaTypes.includes('assistant.delta')).toBeTruthy();
    expect(deltaTypes.includes('usage')).toBeTruthy();

    // The usage event was persisted onto the agent node's ledger row, so the
    // run's token rollup is accurate.
    const store = new ConversationStore(
      makeRuntimeDbProvider(path.join(appsDir, 'notes', 'runtime.sqlite')),
    );
    const agentNode = store.listItems(record.runId).find((n) => n.kind === 'agent');
    expect(agentNode).toBeTruthy();
    expect(agentNode!.model).toBe('a-capable-model');
    expect(agentNode!.inputTokens).toBe(12);
    expect(agentNode!.outputTokens).toBe(3);
    const run = store.getTurn(record.runId);
    expect(run?.totalInputTokens).toBe(12);
    expect(run?.totalOutputTokens).toBe(3);
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
    const dispatch = (): Promise<DispatchSurface> =>
      Promise.resolve({
        toolDispatcher: async () => [
          { ok: true, result: { sent: true }, startedAt: 1_000_000, endedAt: 1_000_250 },
        ],
        agentDispatcher: async () => '',
        async close() {},
      });

    const { record } = await runFire(
      { automationRef: 'notes/send', appsDir },
      { openDispatch: dispatch },
    );

    const store = new ConversationStore(
      makeRuntimeDbProvider(path.join(appsDir, 'notes', 'runtime.sqlite')),
    );
    const toolNode = store.listItems(record.runId).find((n) => n.kind === 'tool');
    expect(toolNode).toBeTruthy();
    // Duration is the dispatcher's per-call window, not the batch span.
    expect(toolNode!.durationMs).toBe(250);
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
    const dispatch = (): Promise<DispatchSurface> =>
      Promise.resolve({
        toolDispatcher: async () => {
          throw new Error('spawn blew up');
        },
        agentDispatcher: async () => '',
        async close() {},
      });

    const { outcome, record } = await runFire(
      { automationRef: 'notes/flaky', appsDir, onRunEvent: (ev) => events.push(ev) },
      { openDispatch: dispatch },
    );
    expect(outcome.ok).toBe(true);

    // The tool node terminated on the live stream despite the rejection.
    const nodeEnds = events.filter((e) => e.type === 'node.end');
    expect(nodeEnds.length).toBe(1);
    const end = nodeEnds[0] as Extract<RunStreamEvent, { type: 'node.end' }>;
    expect(end.ok).toBe(false);
    expect(String(end.error)).toMatch(/spawn blew up/);

    // And the ledger row is closed (duration set), not stranded open.
    const store = new ConversationStore(
      makeRuntimeDbProvider(path.join(appsDir, 'notes', 'runtime.sqlite')),
    );
    const toolNode = store.listItems(record.runId).find((n) => n.kind === 'tool');
    expect(toolNode).toBeTruthy();
    expect(toolNode!.ok).toBe(false);
    expect(toolNode!.durationMs).not.toBe(undefined);
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

    const opened: OpenDispatchArgs[] = [];
    const closes = { n: 0 };

    const { outcome } = await runFire(
      { automationRef: 'notes/main', appsDir },
      { openDispatch: stubDispatch(opened, closes) },
    );

    expect(outcome.ok).toBe(false);
    const refs = opened.map((o) => o.automationRef);
    expect(refs).toEqual(['notes/main', 'notes/recover']);
    expect(closes.n).toBe(2);
  });
});
