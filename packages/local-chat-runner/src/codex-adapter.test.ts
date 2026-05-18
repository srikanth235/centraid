import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { translateCodexLine } from './codex-adapter.ts';
import type { ChatStreamEvent } from '@centraid/runtime-core';

/**
 * Schema fixtures captured empirically from `codex-cli 0.128.0`.
 * `codex exec --json --skip-git-repo-check --sandbox workspace-write "..."`
 * emits the following event stream verbatim — keeping a pinned fixture
 * here means an unexpected schema change shows up as a unit-test
 * failure rather than silent runtime breakage.
 */
const FIXTURE_BASIC = [
  { type: 'thread.started', thread_id: '019e3a7a-24f5-78e0-b068-b018886e322b' },
  { type: 'turn.started' },
  {
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: 'Hi there friend' },
  },
  {
    type: 'turn.completed',
    usage: {
      input_tokens: 19207,
      cached_input_tokens: 3456,
      output_tokens: 4,
      reasoning_output_tokens: 0,
    },
  },
];

const FIXTURE_TOOL = [
  { type: 'thread.started', thread_id: '019e3a7c-5244-7f83-ba83-6c2531cc66ce' },
  { type: 'turn.started' },
  {
    type: 'item.started',
    item: {
      id: 'item_0',
      type: 'command_execution',
      command: "/bin/zsh -lc 'pwd && rg --files'",
      aggregated_output: '',
      exit_code: null,
      status: 'in_progress',
    },
  },
  {
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'command_execution',
      command: "/bin/zsh -lc 'pwd && rg --files'",
      aggregated_output: '/tmp/codex-test\n',
      exit_code: 1,
      status: 'failed',
    },
  },
  {
    type: 'item.completed',
    item: { id: 'item_1', type: 'agent_message', text: '`/tmp/codex-test` is empty.' },
  },
  { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } },
];

function collect(fixture: Array<Record<string, unknown>>): {
  events: ChatStreamEvent[];
  threadId: string | undefined;
  finalText: string;
} {
  const events: ChatStreamEvent[] = [];
  let threadId: string | undefined;
  let finalText = '';
  const seenStarts = new Set<string>();
  for (const line of fixture) {
    translateCodexLine(
      line,
      (e) => events.push(e),
      seenStarts,
      (id) => {
        threadId = id;
      },
      (text) => {
        finalText = text;
      },
    );
  }
  return { events, threadId, finalText };
}

test('translates the basic codex-cli 0.128.0 schema', () => {
  const { events, threadId, finalText } = collect(FIXTURE_BASIC);
  assert.equal(threadId, '019e3a7a-24f5-78e0-b068-b018886e322b');
  const types = events.map((e) => e.type);
  assert.deepEqual(types, ['phase', 'assistant.delta', 'final', 'phase']);
  const delta = events.find((e) => e.type === 'assistant.delta');
  assert.equal(delta?.type === 'assistant.delta' ? delta.delta : '', 'Hi there friend');
  assert.equal(finalText, 'Hi there friend');
});

test('translates tool-call lifecycle (item.started + item.completed)', () => {
  const { events, threadId } = collect(FIXTURE_TOOL);
  assert.equal(threadId, '019e3a7c-5244-7f83-ba83-6c2531cc66ce');
  const toolStarts = events.filter((e) => e.type === 'tool.start');
  const toolResults = events.filter((e) => e.type === 'tool.result');
  assert.equal(toolStarts.length, 1);
  assert.equal(toolResults.length, 1);
  const start = toolStarts[0];
  const result = toolResults[0];
  assert.ok(start && start.type === 'tool.start');
  assert.equal(start.toolCallId, 'item_0');
  assert.match(start.toolName, /^exec\(/);
  assert.ok(result && result.type === 'tool.result');
  assert.equal(result.ok, false);
});

test('treats turn.failed as an error event', () => {
  const events: ChatStreamEvent[] = [];
  const seenStarts = new Set<string>();
  translateCodexLine(
    { type: 'turn.failed', error: { message: 'rate-limited' } },
    (e) => events.push(e),
    seenStarts,
    () => undefined,
    () => undefined,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'error');
  assert.equal((events[0] as { message: string }).message, 'rate-limited');
});

test('unknown event types fall through as phase events', () => {
  const events: ChatStreamEvent[] = [];
  const seenStarts = new Set<string>();
  translateCodexLine(
    { type: 'codex.experimental.something', payload: { x: 1 } },
    (e) => events.push(e),
    seenStarts,
    () => undefined,
    () => undefined,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'phase');
});
