/*
 * Runner-kind routing for the automation dispatch path (issue #479).
 *
 * A fire has its OWN dispatch surface, separate from the conversation
 * `runTurn`: `ctx.agent` is a one-shot against the user's real provider,
 * routed through the runner registry. Issue #484 removed the `ctx.tool` rail
 * (and the mock-LLM session it puppeted), so the dispatch surface no longer
 * accepts a tool dispatcher — a fire whose handler only touches ctx.vault /
 * ctx.state constructs nothing and spawns nothing. These tests pin the
 * `ctx.agent` routing at the one surviving seam.
 */

import { afterEach, expect, test } from 'vitest';
import {
  ConversationStore,
  makeJournalDbProvider,
  type TurnConfig,
  type TurnInput,
  type TurnResult,
  type TurnStreamEvent,
} from '@centraid/app-engine';
import { tempDir } from '@centraid/test-kit/temp-dir';
import type { RunnerKind } from '../types.ts';
import { RUNNER_BACKENDS } from '../registry.ts';
import { startLiveDispatch, type LiveDispatch } from './run-automation-live-dispatch.ts';

const ACP_KINDS = ['gemini', 'qwen', 'acp'] as const satisfies readonly RunnerKind[];

/** Restore any backend a test swapped out of the registry table. */
const restores: Array<() => void> = [];
const openDispatches: LiveDispatch[] = [];

afterEach(async () => {
  for (const d of openDispatches.splice(0)) await d.close().catch(() => undefined);
  for (const restore of restores.splice(0)) restore();
});

/**
 * Swap one backend's `runTurn` for a recording stub, mirroring the pattern
 * `registry.test.ts` uses. Returns the recorder.
 */
function stubBackendRunTurn(
  kind: RunnerKind,
  impl: (input: TurnInput, config: TurnConfig) => TurnResult | void | Promise<TurnResult | void>,
): { calls: Array<{ input: TurnInput; config: TurnConfig }> } {
  const original = RUNNER_BACKENDS[kind];
  const calls: Array<{ input: TurnInput; config: TurnConfig }> = [];
  RUNNER_BACKENDS[kind] = {
    ...original,
    runTurn: async (input, config) => {
      calls.push({ input, config });
      const result = await impl(input, config);
      return result ?? { adapterKind: kind };
    },
  };
  restores.push(() => {
    RUNNER_BACKENDS[kind] = original;
  });
  return { calls };
}

async function openDispatch(runner: RunnerKind, model?: string): Promise<LiveDispatch> {
  const workdir = await tempDir('centraid-automation-dispatch-');
  const journalDbFile = `${workdir}/journal.db`;
  const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
  store.ensureAutomationConversation('demo/nightly', 'demo', 'Nightly', runner);
  store.close();
  const dispatch = await startLiveDispatch({
    workdir,
    runId: 'run-1',
    automationRef: 'demo/nightly',
    journalDbFile,
    runner,
    ...(model ? { model } : {}),
    onLog: () => undefined,
  });
  openDispatches.push(dispatch);
  return dispatch;
}

const dispatchCtx = {
  runId: 'run-1',
  automationId: 'demo/nightly',
  abortSignal: new AbortController().signal,
};

// ---- zero-spawn seam ------------------------------------------------------

test('the dispatch surface exposes only ctx.agent — no tool dispatcher, nothing eager', async () => {
  // The seam itself is the assertion: a vault-/state-only fire never touches
  // this surface, and there is no `toolDispatcher` for it to reach. Opening
  // the surface must be inert — no persistent mock session, no HTTP server.
  const dispatch = await openDispatch('codex');
  expect(dispatch).not.toHaveProperty('toolDispatcher');
  expect(typeof dispatch.agentDispatcher).toBe('function');
  expect(typeof dispatch.close).toBe('function');
});

// ---- ctx.agent -----------------------------------------------------------

test.each(ACP_KINDS)('ctx.agent on %s drives the registered backend', async (kind) => {
  const stub = stubBackendRunTurn(kind, (input) => {
    input.onEvent({ type: 'assistant.start' });
    input.onEvent({ type: 'final', text: 'answer from the acp agent' });
  });

  const { agentDispatcher } = await openDispatch(kind, 'some-model');
  const forwarded: TurnStreamEvent[] = [];
  const answer = await agentDispatcher(
    { prompt: 'summarise the inbox', onEvent: (ev) => forwarded.push(ev) },
    dispatchCtx,
  );

  expect(answer).toBe('answer from the acp agent');
  expect(stub.calls).toHaveLength(1);
  const [call] = stub.calls;
  expect(call?.input.message).toBe('summarise the inbox');
  expect(call?.input.model).toBe('some-model');
  expect(call?.config.prefs.kind).toBe(kind);
  // The normalized stream reaches the run bus.
  expect(forwarded.map((e) => e.type)).toEqual(['assistant.start', 'final']);
});

test('ctx.agent coerces the ACP final text against the requested JSON shape', async () => {
  stubBackendRunTurn('gemini', (input) => {
    input.onEvent({ type: 'final', text: '{"count": 3}' });
  });

  const { agentDispatcher } = await openDispatch('gemini');
  const answer = await agentDispatcher(
    { prompt: 'count them', json: { type: 'object', properties: { count: { type: 'number' } } } },
    dispatchCtx,
  );

  expect(answer).toEqual({ count: 3 });
});

test('ctx.agent surfaces an ACP backend error that produced no text', async () => {
  stubBackendRunTurn('acp', (input) => {
    input.onEvent({ type: 'error', message: 'no binary configured' });
  });

  const { agentDispatcher } = await openDispatch('acp');
  await expect(agentDispatcher({ prompt: 'go' }, dispatchCtx)).rejects.toThrow(
    /centraid-agent-failure:.*"runner":"acp".*"message":"no binary configured"/,
  );
});

test('typed automation failures survive a handler-worker stack suffix', async () => {
  const { parseAutomationAgentFailure } = await import('./run-automation-live-dispatch.ts');
  expect(
    parseAutomationAgentFailure(
      'Error: centraid-agent-failure:{"runner":"codex","failureClass":"spawn","message":"missing"}\n' +
        '    at MessagePort.<anonymous> (runner.js:71:25)',
    ),
  ).toEqual({ runner: 'codex', failureClass: 'spawn', message: 'missing' });
});

test('ctx.agent never retries another provider inside the same turn', async () => {
  const primary = stubBackendRunTurn('codex', (input) => {
    input.onEvent({ type: 'error', message: 'quota', failureClass: 'quota' });
  });
  const fallback = stubBackendRunTurn('claude-code', (input) => {
    input.onEvent({ type: 'final', text: 'fallback answer' });
  });
  const workdir = await tempDir('centraid-automation-failover-');
  const journalDbFile = `${workdir}/journal.db`;
  const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
  store.ensureAutomationConversation('demo/nightly', 'demo', 'Nightly', 'codex');
  store.close();
  const dispatch = await startLiveDispatch({
    workdir,
    runId: 'run-fallback',
    automationRef: 'demo/nightly',
    journalDbFile,
    runner: 'codex',
    model: 'gpt-primary',
    configPins: { thought_level: 'xhigh' },
    runnerPrefsFor: async (kind) =>
      kind === 'claude-code' ? { kind, configPins: { thought_level: 'high' } } : { kind: 'codex' },
    onLog: () => undefined,
  });
  openDispatches.push(dispatch);
  await expect(dispatch.agentDispatcher({ prompt: 'go' }, dispatchCtx)).rejects.toThrow(
    /centraid-agent-failure:.*"failureClass":"quota"/,
  );
  expect(primary.calls[0]!.input).toMatchObject({
    model: 'gpt-primary',
    configPins: { thought_level: 'xhigh' },
  });
  expect(fallback.calls).toHaveLength(0);
});

// Issue #479 retired the bespoke `codex exec` / claude-SDK arms: every kind
// now enters the same registry seam, so nothing spawns a CLI from this file.
test.each(['codex', 'claude-code'] as const)(
  'ctx.agent on %s routes through the registry like every other kind',
  async (kind) => {
    const stub = stubBackendRunTurn(kind, (input) => {
      input.onEvent({ type: 'final', text: 'answer' });
    });

    const { agentDispatcher } = await openDispatch(kind, 'some-model');
    expect(await agentDispatcher({ prompt: 'go' }, dispatchCtx)).toBe('answer');
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.config.prefs.kind).toBe(kind);
  },
);

test('scheduled A→B→A reuses A and hydrates only B ledger turns', async () => {
  const workdir = await tempDir('centraid-automation-bindings-');
  const journalDbFile = `${workdir}/journal.db`;
  const ref = 'demo/nightly';
  const seed = new ConversationStore(makeJournalDbProvider(journalDbFile));
  seed.ensureAutomationConversation(ref, 'demo', 'Nightly', 'codex');
  seed.insertTurn({
    turnId: 'a-first',
    conversationId: ref,
    triggerKind: 'scheduled',
    startedAt: 1,
  });
  seed.finishTurn({
    turnId: 'a-first',
    endedAt: 2,
    ok: true,
    summary: 'A first answer',
  });
  seed.noteTurn(ref, '', { kind: 'codex', sessionId: 'session-a' });
  seed.close();

  const claude = stubBackendRunTurn('claude-code', (input) => {
    input.onEvent({ type: 'final', text: 'B answer' });
    return { adapterKind: 'claude-code', sessionId: 'session-b', hydrated: true };
  });
  const bDispatch = await startLiveDispatch({
    workdir,
    runId: 'b-turn',
    automationRef: ref,
    journalDbFile,
    runner: 'claude-code',
    onLog: () => undefined,
  });
  const duringB = new ConversationStore(makeJournalDbProvider(journalDbFile));
  duringB.insertTurn({
    turnId: 'b-turn',
    conversationId: ref,
    triggerKind: 'scheduled',
    startedAt: 3,
  });
  await bDispatch.agentDispatcher({ prompt: 'run B' }, dispatchCtx);
  duringB.finishTurn({
    turnId: 'b-turn',
    endedAt: 4,
    ok: true,
    summary: 'B durable answer',
  });
  bDispatch.finalizeTurn(duringB, ref, 'b-turn', true);
  duringB.close();
  await bDispatch.close();
  expect(claude.calls[0]?.input.prevSessionId).toBeUndefined();
  expect(claude.calls[0]?.input.hydrationContext).toContain('A first answer');

  const codex = stubBackendRunTurn('codex', (input) => {
    input.onEvent({ type: 'final', text: 'A returns' });
    return { adapterKind: 'codex', sessionId: 'session-a' };
  });
  const aDispatch = await startLiveDispatch({
    workdir,
    runId: 'a-return',
    automationRef: ref,
    journalDbFile,
    runner: 'codex',
    onLog: () => undefined,
  });
  const duringA = new ConversationStore(makeJournalDbProvider(journalDbFile));
  duringA.insertTurn({
    turnId: 'a-return',
    conversationId: ref,
    triggerKind: 'scheduled',
    startedAt: 5,
  });
  await aDispatch.agentDispatcher({ prompt: 'return to A' }, dispatchCtx);
  duringA.finishTurn({ turnId: 'a-return', endedAt: 6, ok: true });
  aDispatch.finalizeTurn(duringA, ref, 'a-return', true);
  duringA.close();
  await aDispatch.close();

  expect(codex.calls[0]?.input.prevSessionId).toBe('session-a');
  expect(codex.calls[0]?.input.hydrationContext).toContain('B durable answer');
  expect(codex.calls[0]?.input.hydrationContext).not.toContain('A first answer');
  const finalStore = new ConversationStore(makeJournalDbProvider(journalDbFile));
  expect(finalStore.getConversation(ref)?.id).toBe(ref);
  expect(finalStore.getTurn('b-turn')?.hydrationTokens).toBeGreaterThan(0);
  expect(finalStore.getHarnessBinding(ref, 'codex')?.acpSessionId).toBe('session-a');
  expect(finalStore.getHarnessBinding(ref, 'claude-code')?.acpSessionId).toBe('session-b');
  finalStore.close();
});
