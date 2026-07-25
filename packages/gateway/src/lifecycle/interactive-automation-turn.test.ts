import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ConversationStore,
  makeJournalDbProvider,
  type AutomationTurnStreamEvent,
  type ConversationRunner,
  type ConversationTurnInput,
  type TurnStreamEvent,
} from '@centraid/app-engine';
import { validateManifest, type Row as AutomationRow } from '@centraid/automation';
import {
  automationContextPreamble,
  runInteractiveAutomationTurn,
} from './interactive-automation-turn.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function row(dir: string): AutomationRow {
  const manifest = validateManifest({
    name: 'Daily brief',
    version: '0.1.0',
    enabled: true,
    prompt: 'Summarize important account changes.',
    triggers: [],
    requires: { runner: 'codex', model: 'gpt-test' },
    connections: [{ connectionId: 'gmail-work', kind: 'pull.gmail', label: 'Work' }],
    vault: {
      purpose: 'dpv:ServiceProvision',
      scopes: [{ schema: 'core', table: 'message', verbs: 'read' }],
    },
    history: { keep: { count: 100 } },
    generated: { by: 'test', at: '2026-07-25T00:00:00.000Z' },
  });
  return {
    id: 'main',
    dir,
    name: manifest.name,
    triggers: manifest.triggers,
    enabled: manifest.enabled,
    ownerApp: 'brief',
    ref: 'brief/main',
    manifest,
  };
}

function seed(journalDbFile: string, withHandle: boolean): void {
  const store = new ConversationStore(makeJournalDbProvider(journalDbFile));
  store.ensureAutomationConversation('brief/main', 'brief', 'Daily brief');
  store.insertTurn({
    turnId: 'prior',
    conversationId: 'brief/main',
    triggerKind: 'manual',
    triggerOrigin: 'manual',
    startedAt: 10,
  });
  store.insertMessageIn({
    itemId: 'prior-input',
    turnId: 'prior',
    role: 'user',
    text: '{"tick":1}',
    startedAt: 10,
  });
  store.finishTurn({
    turnId: 'prior',
    endedAt: 20,
    ok: true,
    summary: 'Found two important changes.',
    outputJson: '{"count":2}',
  });
  if (withHandle) store.noteTurn('brief/main', '', { kind: 'codex', sessionId: 'cached-1' });
  store.close();
}

async function runHarness(input: {
  withHandle: boolean;
  emit?: (turn: ConversationTurnInput) => void;
}): Promise<{
  received: ConversationTurnInput;
  stream: TurnStreamEvent[];
  bus: AutomationTurnStreamEvent[];
  store: ConversationStore;
}> {
  const dir = await tempDir('interactive-automation-turn-');
  dirs.push(dir);
  const journalDbFile = path.join(dir, 'journal.db');
  seed(journalDbFile, input.withHandle);
  let received!: ConversationTurnInput;
  const runner: ConversationRunner = {
    run: async (turn) => {
      received = turn;
      input.emit?.(turn);
      return { adapterKind: 'codex', adapterSessionId: 'cached-2' };
    },
  };
  const stream: TurnStreamEvent[] = [];
  const bus: AutomationTurnStreamEvent[] = [];
  await runInteractiveAutomationTurn({
    row: row(dir),
    turnId: 'interactive-1',
    message: 'What changed?',
    journalDbFile,
    runnerSessionDir: path.join(dir, 'sessions'),
    runner,
    runnerKind: 'codex',
    model: 'gpt-test',
    abortSignal: new AbortController().signal,
    conversationLocks: new Map(),
    onEvent: (event) => stream.push(event),
    onTurnEvent: (event) => bus.push(event),
  });
  return {
    received,
    stream,
    bus,
    store: new ConversationStore(makeJournalDbProvider(journalDbFile)),
  };
}

describe('automationContextPreamble', () => {
  it('contains standing instructions, exact account ids, scope, history, and steering', () => {
    const text = automationContextPreamble(
      row('/tmp/automation'),
      [
        {
          turnId: 't1',
          conversationId: 'brief/main',
          seq: 0,
          triggerKind: 'manual',
          startedAt: 1,
          endedAt: 2,
          ok: true,
          pinned: false,
          summary: 'Previous result',
        },
      ],
      'Explain today.',
    );
    expect(text).toContain('Summarize important account changes.');
    expect(text).toContain('gmail-work');
    expect(text).toContain('core');
    expect(text).toContain('Previous result');
    expect(text).toContain('Explain today.');
  });
});

describe('runInteractiveAutomationTurn', () => {
  it('is ledger-equivalent cold and resumed while using the cached handle only as an optimization', async () => {
    const cold = await runHarness({ withHandle: false });
    const resumed = await runHarness({ withHandle: true });
    expect(cold.received.extraSystemPrompt).toBe(resumed.received.extraSystemPrompt);
    expect(cold.received.prevAdapterSessionId).toBeUndefined();
    expect(resumed.received.prevAdapterSessionId).toBe('cached-1');
    expect(resumed.received.permissionPolicy).toBe('deny');
    expect(resumed.received.runnerKind).toBe('codex');
    expect(resumed.received.model).toBe('gpt-test');
    expect(resumed.store.getConversation('brief/main')).toMatchObject({
      adapterKind: 'codex',
      adapterSessionId: 'cached-2',
    });
    cold.store.close();
    resumed.store.close();
  });

  it('persists a native interactive trace and fans the same events to second viewers', async () => {
    const out = await runHarness({
      withHandle: false,
      emit: (turn) => {
        turn.onEvent({ type: 'assistant.delta', delta: 'Two changes.' });
        turn.onEvent({
          type: 'tool.start',
          toolCallId: 'call-1',
          toolName: 'vault_read',
          args: { entity: 'core.message' },
          rawJson: '{"sessionUpdate":"tool_call"}',
        });
        turn.onEvent({
          type: 'tool.result',
          toolCallId: 'call-1',
          toolName: 'vault_read',
          ok: true,
          result: { rows: 2 },
          rawJson: '{"sessionUpdate":"tool_call_update"}',
        });
        turn.onEvent({
          type: 'usage',
          model: 'gpt-test',
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0.01,
        });
        turn.onEvent({
          type: 'final',
          text: 'Two changes.',
          stopReason: 'end_turn',
          rawJson: '{"stopReason":"end_turn"}',
        });
      },
    });
    expect(out.stream.at(-1)).toMatchObject({
      type: 'final',
      stopReason: 'end_turn',
    });
    expect(out.bus[0]).toEqual({ type: 'turn.start', turnId: 'interactive-1' });
    expect(out.bus.at(-1)).toEqual({
      type: 'turn.end',
      turnId: 'interactive-1',
      ok: true,
    });
    expect(out.store.getTurn('interactive-1')).toMatchObject({
      triggerKind: 'interactive',
      ok: true,
      totalInputTokens: 100,
      totalOutputTokens: 20,
      totalCostUsd: 0.01,
    });
    expect(out.store.listItems('interactive-1')).toEqual([
      expect.objectContaining({ kind: 'message_in', text: 'What changed?' }),
      expect.objectContaining({
        kind: 'agent',
        rawJson: '{"stopReason":"end_turn"}',
        inputTokens: 100,
        costSource: 'agent',
      }),
      expect.objectContaining({
        kind: 'tool',
        callId: 'call-1',
        rawJson: '{"sessionUpdate":"tool_call_update"}',
      }),
    ]);
    out.store.close();
  });
});
