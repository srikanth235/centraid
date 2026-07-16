import { describe, it, expect } from 'vitest';
import { makeConversationRunnerCore } from './runner-core.js';
import type { ConversationTurnInput, TurnStreamEvent } from './runner.js';
import type { Dispatcher } from '../handlers/dispatcher.js';
import type { RunnerPrefs, RunTurnFn, TurnConfig, TurnInput } from './turn.js';

// Runner-kind pin + visible context-reset (issue #424). The spine is
// backend-agnostic: `runTurn` is a stub that records the prefs it was handed
// and the resume id, so these tests pin down (1) which backend a turn routes
// to and (2) whether it resumes — the two things the pin governs.

function makeInput(over: Partial<ConversationTurnInput> = {}): {
  input: ConversationTurnInput;
  events: TurnStreamEvent[];
} {
  const events: TurnStreamEvent[] = [];
  const input: ConversationTurnInput = {
    appId: 'app1',
    dataDir: '/tmp/data',
    conversationId: 'c1',
    sessionFile: '/tmp/c1.jsonl',
    message: 'hi',
    extraSystemPrompt: '',
    abortSignal: new AbortController().signal,
    onEvent: (e) => events.push(e),
    ...over,
  };
  return { input, events };
}

function harness(prefs: RunnerPrefs) {
  const seen: { config?: TurnConfig; prevSessionId?: string } = {};
  const runTurn: RunTurnFn = async (input: TurnInput, config: TurnConfig) => {
    seen.config = config;
    seen.prevSessionId = input.prevSessionId;
    return { adapterKind: config.prefs.kind, sessionId: 'new-session' };
  };
  const runner = makeConversationRunnerCore({
    prefsLoader: async () => prefs,
    getDispatcher: () => ({}) as unknown as Dispatcher,
    resolveCwd: (i) => i.dataDir,
    runTurn,
  });
  return { runner, seen };
}

describe('runner-core runner-kind pin (#424)', () => {
  it('pins the conversation kind over a flipped pref and resumes its handle', async () => {
    // The user flipped prefs to claude-code, but the conversation ran its
    // first turn on codex — the pin wins and resume is passed.
    const { runner, seen } = harness({ kind: 'claude-code', binPath: '/opt/cc' });
    const { input, events } = makeInput({
      prevAdapterKind: 'codex',
      prevAdapterSessionId: 'sess-codex',
    });

    const result = await runner.run(input);

    expect(seen.config?.prefs.kind).toBe('codex');
    // Only `kind` is overridden — the rest of the loaded prefs survive.
    expect(seen.config?.prefs.binPath).toBe('/opt/cc');
    expect(seen.prevSessionId).toBe('sess-codex');
    expect(result).toEqual({ adapterKind: 'codex', adapterSessionId: 'new-session' });
    expect(events.some((e) => e.type === 'notice')).toBe(false);
  });

  it('first turn (no prior kind) uses the pref and does not resume', async () => {
    const { runner, seen } = harness({ kind: 'codex' });
    const { input, events } = makeInput();

    const result = await runner.run(input);

    expect(seen.config?.prefs.kind).toBe('codex');
    expect(seen.prevSessionId).toBeUndefined();
    expect(result).toEqual({ adapterKind: 'codex', adapterSessionId: 'new-session' });
    expect(events.some((e) => e.type === 'notice')).toBe(false);
  });

  it('resumes without a notice when the pinned kind still has its handle', async () => {
    const { runner, seen } = harness({ kind: 'codex' });
    const { input, events } = makeInput({
      prevAdapterKind: 'codex',
      prevAdapterSessionId: 'sess-codex',
    });

    await runner.run(input);

    expect(seen.prevSessionId).toBe('sess-codex');
    expect(events.some((e) => e.type === 'notice')).toBe(false);
  });

  it('emits a context.reset notice and starts fresh on a lost handle', async () => {
    // Prior turns exist (kind pinned) but the resume handle is gone — the turn
    // must run fresh AND surface the reset.
    const { runner, seen } = harness({ kind: 'claude-code' });
    const { input, events } = makeInput({ prevAdapterKind: 'codex' });

    await runner.run(input);

    // Still routes to the pinned backend, but with no resume id.
    expect(seen.config?.prefs.kind).toBe('codex');
    expect(seen.prevSessionId).toBeUndefined();
    const notice = events.find((e) => e.type === 'notice');
    expect(notice).toMatchObject({ type: 'notice', level: 'warn', code: 'context.reset' });
  });
});
