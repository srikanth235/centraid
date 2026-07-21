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
import type { TurnConfig, TurnInput, TurnStreamEvent } from '@centraid/app-engine';
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
  impl: (input: TurnInput, config: TurnConfig) => void | Promise<void>,
): { calls: Array<{ input: TurnInput; config: TurnConfig }> } {
  const original = RUNNER_BACKENDS[kind];
  const calls: Array<{ input: TurnInput; config: TurnConfig }> = [];
  RUNNER_BACKENDS[kind] = {
    ...original,
    runTurn: async (input, config) => {
      calls.push({ input, config });
      await impl(input, config);
      return { adapterKind: kind };
    },
  };
  restores.push(() => {
    RUNNER_BACKENDS[kind] = original;
  });
  return { calls };
}

async function openDispatch(runner: RunnerKind, model?: string): Promise<LiveDispatch> {
  const workdir = await tempDir('centraid-automation-dispatch-');
  const dispatch = await startLiveDispatch({
    workdir,
    runId: 'run-1',
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
    /ctx\.agent \(acp\) failed: no binary configured/,
  );
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
