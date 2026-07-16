/*
 * Runner-core: per-subsystem runner selection + session-resume gating.
 *
 * The spine resolves prefs PER TURN via the injected `prefsLoader`, and the
 * register's `subsystem` tag rides along on every call. That's what makes
 * per-subsystem runner selection work without restructuring the boot-time
 * wiring: a host builds one runner per register at boot, but neither the
 * runner kind nor the model is chosen until the turn actually runs.
 */

import { describe, expect, it, vi } from 'vitest';
import { makeConversationRunnerCore } from './runner-core.js';
import type { ConversationTurnInput } from './runner.js';
import type { Dispatcher } from '../handlers/dispatcher.js';
import type { ModelSubsystem } from '../stores/prefs-store.js';
import type { RunnerPrefs, TurnConfig, TurnInput, TurnResult } from './turn.js';

const dispatcher = {} as Dispatcher;

function turnInput(over: Partial<ConversationTurnInput> = {}): ConversationTurnInput {
  return {
    appId: 'demo',
    dataDir: '/tmp/demo',
    conversationId: 'conv-1',
    sessionFile: '/tmp/demo/conv-1.jsonl',
    message: 'hi',
    extraSystemPrompt: 'preamble',
    abortSignal: new AbortController().signal,
    onEvent: () => undefined,
    ...over,
  };
}

/** A core wired to a stub turn driver; captures what the driver received. */
function build(opts: {
  prefsLoader: (subsystem?: ModelSubsystem) => Promise<RunnerPrefs | undefined>;
  subsystem?: ModelSubsystem;
}) {
  const seen: TurnInput[] = [];
  const runTurn = vi.fn(async (input: TurnInput, _config: TurnConfig): Promise<TurnResult> => {
    seen.push(input);
    return { adapterKind: 'codex', sessionId: 'new-session' };
  });
  const runner = makeConversationRunnerCore({
    prefsLoader: opts.prefsLoader,
    ...(opts.subsystem ? { subsystem: opts.subsystem } : {}),
    getDispatcher: () => dispatcher,
    resolveCwd: (input) => input.dataDir,
    runTurn,
  });
  return { runner, seen, runTurn };
}

describe('makeConversationRunnerCore — per-subsystem prefs loading', () => {
  it("passes the register's subsystem to the prefs loader on every turn", async () => {
    const prefsLoader = vi.fn(async () => ({ kind: 'claude-code' as const }));
    const { runner } = build({ prefsLoader, subsystem: 'ask' });

    await runner.run(turnInput());
    await runner.run(turnInput());

    // Called PER TURN (not once at construction) and always tagged with the
    // register's subsystem — that's the seam per-subsystem selection rides.
    expect(prefsLoader).toHaveBeenCalledTimes(2);
    expect(prefsLoader).toHaveBeenNthCalledWith(1, 'ask');
    expect(prefsLoader).toHaveBeenNthCalledWith(2, 'ask');
  });

  it('calls the loader bare when the register has no subsystem (back-compat)', async () => {
    const prefsLoader = vi.fn(async () => ({ kind: 'codex' as const }));
    const { runner } = build({ prefsLoader });

    await runner.run(turnInput());

    // An untagged register inherits the host default — byte-identical to the
    // pre-per-subsystem behavior, which called the loader with no args.
    expect(prefsLoader).toHaveBeenCalledWith(undefined);
  });

  it('picks up a runner re-pin mid-session, with no restart', async () => {
    let kind: RunnerPrefs['kind'] = 'codex';
    const { runner, runTurn } = build({
      prefsLoader: async () => ({ kind }),
      subsystem: 'assistant',
    });

    await runner.run(turnInput());
    expect(runTurn.mock.calls[0]![1]).toEqual({ prefs: { kind: 'codex' } });

    // The owner re-pins `runner.assistant` between turns.
    kind = 'claude-code';
    await runner.run(turnInput());
    expect(runTurn.mock.calls[1]![1]).toEqual({ prefs: { kind: 'claude-code' } });
  });
});

describe('makeConversationRunnerCore — session resume gating', () => {
  it('resumes when the previous turn used the same runner kind', async () => {
    const { runner, seen } = build({
      prefsLoader: async () => ({ kind: 'codex' }),
      subsystem: 'assistant',
    });

    await runner.run(turnInput({ prevAdapterKind: 'codex', prevAdapterSessionId: 'thread-abc' }));

    expect(seen[0]!.prevSessionId).toBe('thread-abc');
  });

  it("invalidates the session when the subsystem's runner has changed", async () => {
    // The prior turn ran on codex and left a codex thread id; the owner has
    // since pinned `runner.assistant` to claude-code. Resuming a codex thread
    // against the Claude backend is meaningless — the turn must start fresh.
    const { runner, seen } = build({
      prefsLoader: async () => ({ kind: 'claude-code' }),
      subsystem: 'assistant',
    });

    await runner.run(turnInput({ prevAdapterKind: 'codex', prevAdapterSessionId: 'thread-abc' }));

    expect(seen[0]!.prevSessionId).toBeUndefined();
  });

  it('invalidates independently per subsystem', async () => {
    // Two registers over the same spine: ask has been re-pinned to
    // claude-code, the builder still rides codex. The builder's session
    // must survive the ask re-pin — cross-subsystem isolation.
    const ask = build({
      prefsLoader: async () => ({ kind: 'claude-code' }),
      subsystem: 'ask',
    });
    const builder = build({
      prefsLoader: async () => ({ kind: 'codex' }),
      subsystem: 'builder',
    });
    const prior = { prevAdapterKind: 'codex', prevAdapterSessionId: 'thread-abc' };

    await ask.runner.run(turnInput(prior));
    await builder.runner.run(turnInput(prior));

    expect(ask.seen[0]!.prevSessionId).toBeUndefined();
    expect(builder.seen[0]!.prevSessionId).toBe('thread-abc');
  });

  it('starts fresh when there is no prior session at all', async () => {
    const { runner, seen } = build({
      prefsLoader: async () => ({ kind: 'codex' }),
      subsystem: 'assistant',
    });

    await runner.run(turnInput());

    expect(seen[0]!.prevSessionId).toBeUndefined();
  });
});
