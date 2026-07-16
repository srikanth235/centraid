import { describe, expect, it, vi } from 'vitest';
import { cleanTitle, generateConversationTitle } from './auto-title.js';
import type { RunTurnFn } from './turn.js';

interface Capture {
  model?: string;
  toolContext?: unknown;
  prefsKind?: string;
}

/** A RunTurnFn stub that emits the given text via assistant.delta + final. */
function stubRunTurn(text: string, capture?: Capture): RunTurnFn {
  return async (input, config) => {
    if (capture) {
      capture.model = input.model;
      capture.toolContext = input.toolContext;
      capture.prefsKind = config.prefs.kind;
    }
    input.onEvent({ type: 'assistant.delta', delta: text });
    input.onEvent({ type: 'final', text });
    return { adapterKind: config.prefs.kind };
  };
}

describe('cleanTitle', () => {
  it('strips wrapping quotes, a Title: marker, and trailing punctuation', () => {
    expect(cleanTitle('"Quarterly budget review."')).toBe('Quarterly budget review');
    expect(cleanTitle('Title: Trip planning')).toBe('Trip planning');
    expect(cleanTitle('“Grocery list”')).toBe('Grocery list');
  });

  it('keeps only the first line and collapses whitespace', () => {
    expect(cleanTitle('Weekend plans\nExtra chatter the model added')).toBe('Weekend plans');
    expect(cleanTitle('  spaced   out   title  ')).toBe('spaced out title');
  });

  it('caps overly long output with an ellipsis and rejects empties', () => {
    const long = 'a'.repeat(80);
    const out = cleanTitle(long);
    expect(out?.length).toBe(60);
    expect(out?.endsWith('…')).toBe(true);
    expect(cleanTitle('   ')).toBeUndefined();
    expect(cleanTitle('""')).toBeUndefined();
  });
});

describe('generateConversationTitle', () => {
  it('drives a tool-less one-shot at the given tier and returns a cleaned title', async () => {
    const capture: Capture = {};
    const runTurn = stubRunTurn('  "Budget planning"  ', capture);
    const title = await generateConversationTitle({
      runTurn,
      runnerPrefs: { kind: 'claude-code' },
      cwd: '/tmp/x',
      model: 'fast',
      userMessage: 'help me plan a budget',
      assistantText: 'Sure, here is a plan…',
    });
    expect(title).toBe('Budget planning');
    // Provider-agnostic tier token flows straight through as the model.
    expect(capture.model).toBe('fast');
    // Tool-less: no toolContext handed to the runner.
    expect(capture.toolContext).toBeUndefined();
    expect(capture.prefsKind).toBe('claude-code');
  });

  it('returns undefined when the model produced nothing usable', async () => {
    const title = await generateConversationTitle({
      runTurn: stubRunTurn('   '),
      runnerPrefs: { kind: 'claude-code' },
      cwd: '/tmp/x',
      model: 'fast',
      userMessage: 'hi',
      assistantText: 'hello',
    });
    expect(title).toBeUndefined();
  });

  it('propagates a runTurn rejection (caller owns the fire-and-forget swallow)', async () => {
    const runTurn: RunTurnFn = vi.fn().mockRejectedValue(new Error('spawn failed'));
    await expect(
      generateConversationTitle({
        runTurn,
        runnerPrefs: { kind: 'claude-code' },
        cwd: '/tmp/x',
        model: 'fast',
        userMessage: 'hi',
        assistantText: 'hello',
      }),
    ).rejects.toThrow('spawn failed');
  });
});
