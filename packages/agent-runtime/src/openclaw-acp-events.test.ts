import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import type { ChatStreamEvent } from '@centraid/app-engine';
import { AcpStreamTranslator } from './openclaw-acp-events.js';

/** Feed a list of updates through a fresh translator, collecting all events. */
function run(updates: SessionUpdate[]): { events: ChatStreamEvent[]; finalText: string } {
  const t = new AcpStreamTranslator();
  const events: ChatStreamEvent[] = [];
  for (const u of updates) events.push(...t.onUpdate(u));
  return { events, finalText: t.finalText };
}

test('agent_message_chunk accumulates assistant deltas into final text', () => {
  const { events, finalText } = run([
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } },
  ]);
  assert.deepEqual(events, [
    { type: 'assistant.delta', delta: 'Hello ' },
    { type: 'assistant.delta', delta: 'world' },
  ]);
  assert.equal(finalText, 'Hello world');
});

test('agent_thought_chunk maps to reasoning.delta and is not part of final text', () => {
  const { events, finalText } = run([
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking…' } },
  ]);
  assert.deepEqual(events, [{ type: 'reasoning.delta', delta: 'thinking…' }]);
  assert.equal(finalText, '');
});

test('tool_call then terminal tool_call_update emits start + result', () => {
  const { events } = run([
    {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Read config',
      kind: 'read',
      status: 'pending',
      rawInput: { path: 'app.json' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawOutput: { bytes: 42 },
    },
  ]);
  assert.deepEqual(events, [
    { type: 'tool.start', toolCallId: 't1', toolName: 'Read config', args: { path: 'app.json' } },
    {
      type: 'tool.result',
      toolCallId: 't1',
      toolName: 'Read config',
      ok: true,
      result: { bytes: 42 },
    },
  ]);
});

test('non-terminal tool_call_update produces no event', () => {
  const { events } = run([
    { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Exec', status: 'pending' },
    { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress' },
  ]);
  assert.deepEqual(events, [{ type: 'tool.start', toolCallId: 't1', toolName: 'Exec' }]);
});

test('failed tool_call_update marks the result not-ok with error text', () => {
  const { events } = run([
    { sessionUpdate: 'tool_call', toolCallId: 't9', title: 'Write', status: 'in_progress' },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't9',
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'permission denied' } }],
    },
  ]);
  const result = events.find((e) => e.type === 'tool.result');
  assert.ok(result && result.type === 'tool.result');
  assert.equal(result.ok, false);
  assert.equal(result.errorText, 'permission denied');
});

test('a tool_call that arrives already-terminal emits start + result together', () => {
  const { events } = run([
    {
      sessionUpdate: 'tool_call',
      toolCallId: 's1',
      title: 'Search',
      status: 'completed',
      rawOutput: { hits: 3 },
    },
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, 'tool.start');
  assert.equal(events[1]?.type, 'tool.result');
});

test('user_message_chunk and unknown updates are ignored', () => {
  const { events } = run([
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } },
    { sessionUpdate: 'current_mode_update', currentModeId: 'build' } as unknown as SessionUpdate,
  ]);
  assert.deepEqual(events, []);
});

test('plan update surfaces as a phase event', () => {
  const update = {
    sessionUpdate: 'plan',
    entries: [{ content: 'step 1', priority: 'high', status: 'pending' }],
  } as unknown as SessionUpdate;
  const { events } = run([update]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'phase');
  assert.ok(events[0]?.type === 'phase' && events[0].phase === 'plan');
});

test('usage_update forwards token counts under the openclaw provider', () => {
  const update = {
    sessionUpdate: 'usage_update',
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 8 },
  } as unknown as SessionUpdate;
  const { events } = run([update]);
  assert.deepEqual(events, [
    {
      type: 'usage',
      provider: 'openclaw',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 8,
    },
  ]);
});
