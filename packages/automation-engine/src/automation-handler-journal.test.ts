/*
 * Crash-resume journal replay (issue #166, Phase 3).
 *
 * A first fire records its `ctx.agent` / `ctx.tool` results into the run
 * ledger (the journal). A second fire with `resumeFromRunId` re-runs the same
 * handler against that journal: already-serviced calls return their recorded
 * results without re-dispatching — so `ctx.agent` is never re-billed — and a
 * call that failed (or never ran) the first time runs live from the journal's
 * end. Driven through `runAutomationFire` with a counting stub dispatch.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAutomationFire, type AutomationDispatchSurface } from './automation-fire.js';
import type { AutomationManifest } from './automation-manifest.js';

function manifest(over: Partial<AutomationManifest> = {}): AutomationManifest {
  return {
    name: 'Resumable',
    version: '0.1.0',
    enabled: true,
    prompt: 'do the thing',
    triggers: [{ kind: 'cron', expr: '0 9 * * *' }],
    requires: {},
    history: { keep: { count: 100 } },
    generated: { by: 'test', at: '2026-06-02' },
    ...over,
  };
}

async function writeAutomation(
  appsDir: string,
  appId: string,
  id: string,
  handler: string,
  m: AutomationManifest = manifest(),
): Promise<void> {
  const dir = path.join(appsDir, appId, 'automations', id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'automation.json'), JSON.stringify(m, null, 2));
  await fs.writeFile(path.join(dir, 'handler.js'), handler);
}

interface Counters {
  agent: number;
  tool: number;
}

/** A dispatch surface counting each agent/tool dispatch. `agentAnswer`/
 *  `toolOk` let a test make a call fail (to simulate a crash point). */
function countingDispatch(
  counters: Counters,
  opts: { agentAnswer?: string; agentThrows?: boolean; toolOk?: boolean } = {},
) {
  return (): Promise<AutomationDispatchSurface> =>
    Promise.resolve({
      toolDispatcher: async () => {
        counters.tool += 1;
        return [
          opts.toolOk === false
            ? { ok: false, error: 'tool failed' }
            : { ok: true, result: { sent: true } },
        ];
      },
      agentDispatcher: async () => {
        counters.agent += 1;
        if (opts.agentThrows) throw new Error('ctx.agent must not be re-billed on replay');
        return opts.agentAnswer ?? 'ANSWER';
      },
      async close() {},
    });
}

// A handler that calls ctx.agent then ctx.tool, returning both.
const AGENT_THEN_TOOL = `export default async ({ ctx }) => {
  const a = await ctx.agent({ prompt: 'summarize' });
  const t = await ctx.tool('mailer', { to: 'x' });
  return { output: { a, t } };
};`;

describe('journal replay on resume (issue #166)', () => {
  let appsDir: string;
  beforeEach(async () => {
    appsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-journal-'));
  });
  afterEach(async () => {
    await fs.rm(appsDir, { recursive: true, force: true });
  });

  it('replays a fully-journaled run without re-dispatching any call', async () => {
    await writeAutomation(appsDir, 'notes', 'flow', AGENT_THEN_TOOL);

    // First fire: both ctx.agent + ctx.tool run live and are journaled.
    const c1: Counters = { agent: 0, tool: 0 };
    const first = await runAutomationFire(
      { automationRef: 'notes/flow', appsDir },
      { openDispatch: countingDispatch(c1, { agentAnswer: 'SUMMARY-1' }) },
    );
    assert.equal(first.outcome.ok, true);
    assert.deepEqual(first.outcome.output, { a: 'SUMMARY-1', t: { sent: true } });
    assert.deepEqual(c1, { agent: 1, tool: 1 });

    // Resume: the agent dispatcher THROWS if touched — proving the journaled
    // answer is served without paying for inference again.
    const c2: Counters = { agent: 0, tool: 0 };
    const second = await runAutomationFire(
      { automationRef: 'notes/flow', appsDir, resumeFromRunId: first.record.runId },
      { openDispatch: countingDispatch(c2, { agentThrows: true }) },
    );
    assert.equal(second.outcome.ok, true, 'resume completed from the journal');
    // Same output as the original run, reconstructed from the journal.
    assert.deepEqual(second.outcome.output, { a: 'SUMMARY-1', t: { sent: true } });
    // Nothing was re-dispatched.
    assert.deepEqual(c2, { agent: 0, tool: 0 }, 'no call re-dispatched on full replay');
  });

  it('replays the journaled ctx.agent but re-runs the failed ctx.tool live', async () => {
    await writeAutomation(appsDir, 'notes', 'partial', AGENT_THEN_TOOL);

    // First fire crashes at ctx.tool: the agent node lands ok (journaled), the
    // tool node fails (NOT journaled) and the handler promise rejects.
    const c1: Counters = { agent: 0, tool: 0 };
    const first = await runAutomationFire(
      { automationRef: 'notes/partial', appsDir },
      { openDispatch: countingDispatch(c1, { agentAnswer: 'SUMMARY-2', toolOk: false }) },
    );
    assert.equal(first.outcome.ok, false, 'the first fire failed at the tool');
    assert.deepEqual(c1, { agent: 1, tool: 1 });

    // Resume: the agent must replay from the journal (dispatcher throws if
    // touched); the tool must run live (now succeeding) from the resume point.
    const c2: Counters = { agent: 0, tool: 0 };
    const second = await runAutomationFire(
      { automationRef: 'notes/partial', appsDir, resumeFromRunId: first.record.runId },
      { openDispatch: countingDispatch(c2, { agentThrows: true, toolOk: true }) },
    );
    assert.equal(second.outcome.ok, true, 'resume finished the run');
    assert.deepEqual(second.outcome.output, { a: 'SUMMARY-2', t: { sent: true } });
    assert.equal(c2.agent, 0, 'ctx.agent replayed from journal — not re-billed');
    assert.equal(c2.tool, 1, 'ctx.tool re-ran live from the resume point');
  });

  it('records the resume as a fresh run linked by retryOf', async () => {
    await writeAutomation(appsDir, 'notes', 'link', AGENT_THEN_TOOL);
    const c1: Counters = { agent: 0, tool: 0 };
    const first = await runAutomationFire(
      { automationRef: 'notes/link', appsDir },
      { openDispatch: countingDispatch(c1, { agentAnswer: 'X' }) },
    );
    const c2: Counters = { agent: 0, tool: 0 };
    const second = await runAutomationFire(
      { automationRef: 'notes/link', appsDir, resumeFromRunId: first.record.runId },
      { openDispatch: countingDispatch(c2, { agentThrows: true }) },
    );
    assert.notEqual(second.record.runId, first.record.runId, 'resume is a fresh run');

    const { AgentRunsStore, makeRuntimeDbProvider } = await import('@centraid/app-engine');
    const store = new AgentRunsStore(
      makeRuntimeDbProvider(path.join(appsDir, 'notes', 'runtime.sqlite')),
    );
    const run = store.getRun(second.record.runId);
    assert.equal(run?.retryOf, first.record.runId, 'resume linked to the source run');
    // The resume run carries a complete journal of its own (agent + tool).
    const kinds = store
      .listNodes(second.record.runId)
      .map((n) => n.kind)
      .sort();
    assert.deepEqual(kinds, ['agent', 'tool']);
    store.close();
  });
});
