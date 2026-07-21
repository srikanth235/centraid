import { tempDir } from '@centraid/test-kit/temp-dir';
/*
 * Automation fire spine (issue #147, Concern 2). The per-fire orchestration
 * lives here in app-engine; the `ctx.agent` dispatch surface is injected by
 * the host via `openDispatch`. These tests run a real (trivial) `handler.js`
 * through `runFire` with a STUB dispatch surface, proving the spine resolves
 * the automation, opens its ledger, runs the handler, and cascades
 * `onFailure` — all without any agent-runtime CLI machinery.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ConversationStore,
  makeJournalDbProvider,
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
 *  trivial handlers below never call `ctx.agent`, so the dispatcher itself is
 *  never invoked. */
function stubDispatch(opened: OpenDispatchArgs[], closes: { n: number }) {
  return (args: OpenDispatchArgs): Promise<DispatchSurface> => {
    opened.push(args);
    return Promise.resolve({
      agentDispatcher: async () => '',
      async close() {
        closes.n += 1;
      },
    });
  };
}

describe('runFire', () => {
  let appsDir: string;
  let journalDbFile: string;

  beforeEach(async () => {
    appsDir = await tempDir('centraid-fire-');
    journalDbFile = path.join(appsDir, 'journal.db');
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  it('resolves the automation, opens an injected dispatch surface, and closes it', async () => {
    await writeAutomation(appsDir, 'notes', 'digest', manifest());
    const opened: OpenDispatchArgs[] = [];
    const closes = { n: 0 };

    const { outcome, record } = await runFire(
      { automationRef: 'notes/digest', appsDir, journalDbFile },
      { openDispatch: stubDispatch(opened, closes) },
    );

    expect(outcome.ok).toBe(true);
    expect(record.automationRef).toBe('notes/digest');
    expect(record.automationName).toBe('Digest');

    // The spine opened exactly one dispatch surface, with the resolved app
    // dir as workdir.
    expect(opened.length).toBe(1);
    expect(opened[0]!.automationRef).toBe('notes/digest');
    expect(opened[0]!.workdir).toMatch(/notes[/\\]automations[/\\]digest$/);
    expect(closes.n).toBe(1);
  });

  it('injects one fire-start instant as deterministic ctx.now', async () => {
    await writeAutomation(
      appsDir,
      'notes',
      'clock',
      manifest(),
      'export default async ({ ctx }) => ({ output: { now: ctx.now } });',
    );
    const opened: OpenDispatchArgs[] = [];
    const closes = { n: 0 };
    const { outcome, record } = await runFire(
      { automationRef: 'notes/clock', appsDir, journalDbFile },
      { openDispatch: stubDispatch(opened, closes) },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toEqual({ now: new Date(record.startedAt).toISOString() });
  });

  it('emits a live run-stream: run.start → node lifecycle per ctx call → run.end', async () => {
    // A handler that drives one ctx.agent. The stub dispatch returns a fixed
    // answer so the node lifecycle is deterministic.
    await writeAutomation(
      appsDir,
      'notes',
      'flow',
      manifest({ name: 'Flow' }),
      `export default async ({ ctx }) => {
         await ctx.agent({ prompt: 'summarize' });
         return { ok: true };
       };`,
    );
    const events: RunStreamEvent[] = [];
    const dispatch = (args: OpenDispatchArgs): Promise<DispatchSurface> => {
      void args;
      return Promise.resolve({
        agentDispatcher: async () => 'a summary',
        async close() {},
      });
    };

    const { outcome } = await runFire(
      {
        automationRef: 'notes/flow',
        appsDir,
        journalDbFile,
        onRunEvent: (ev) => events.push(ev),
      },
      { openDispatch: dispatch },
    );
    expect(outcome.ok).toBe(true);

    // run.start first, run.end last.
    expect(events.at(0)?.type).toBe('run.start');
    expect(events.at(-1)?.type).toBe('run.end');
    const end = events.at(-1) as Extract<RunStreamEvent, { type: 'run.end' }>;
    expect(end.ok).toBe(true);

    // The agent node opened (start) before it closed (end), at ordinal 0.
    const lifecycle = events.filter((e) => e.type === 'node.start' || e.type === 'node.end');
    expect(
      lifecycle.map((e) => [
        e.type,
        (e as { ordinal: number }).ordinal,
        (e as { kind?: string }).kind,
      ]),
    ).toEqual([
      ['node.start', 0, 'agent'],
      ['node.end', 0, undefined],
    ]);
    const agentStart = lifecycle[0] as Extract<RunStreamEvent, { type: 'node.start' }>;
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
      {
        automationRef: 'notes/ask',
        appsDir,
        journalDbFile,
        onRunEvent: (ev) => events.push(ev),
      },
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
    const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
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
      { automationRef: 'notes/main', appsDir, journalDbFile },
      { openDispatch: stubDispatch(opened, closes) },
    );

    expect(outcome.ok).toBe(false);
    const refs = opened.map((o) => o.automationRef);
    expect(refs).toEqual(['notes/main', 'notes/recover']);
    expect(closes.n).toBe(2);
  });
});
