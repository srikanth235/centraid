import { describe, expect, it, vi } from 'vitest';
import {
  automationTurnInboundText,
  automationTurnMessages,
  COMPILE_TURN_INBOUND_TEXT,
} from './automationTurnMessages.js';
import {
  automationLiveMessages,
  createAutomationLiveTrace,
  createAutomationLiveTraceFromItems,
  finishAutomationLiveItem,
  reduceAutomationItemEvent,
  startAutomationLiveItem,
} from './automationLiveMessages.js';

vi.mock('../../../gateway-client.js', () => ({}));

const turn = (over: Partial<CentraidAutomationTurnRecord> = {}): CentraidAutomationTurnRecord =>
  ({
    turnId: 'turn-1',
    automationId: 'brief/main',
    kind: 'automation',
    triggerKind: 'scheduled',
    startedAt: 1,
    endedAt: 20,
    ok: true,
    ...over,
  }) as CentraidAutomationTurnRecord;

const item = (
  ordinal: number,
  kind: CentraidAutomationItem['kind'],
  over: Partial<CentraidAutomationItem> = {},
): CentraidAutomationItem =>
  ({
    itemId: `item-${ordinal}`,
    turnId: 'turn-1',
    ordinal,
    kind,
    ok: true,
    startedAt: ordinal,
    endedAt: ordinal + 1,
    durationMs: 1,
    ...over,
  }) as CentraidAutomationItem;

describe('automationTurnMessages cold projection', () => {
  it('coalesces only consecutive tools and preserves later agent/tool groups', () => {
    const messages = automationTurnMessages(turn(), [
      item(0, 'message_in', { text: 'Run the brief.' }),
      item(1, 'agent', {
        startedAt: 1,
        endedAt: 10,
        outputJson: '{"text":"First answer"}',
      }),
      item(2, 'tool', { callId: 'a', name: 'mail.search', startedAt: 2 }),
      item(3, 'tool', { callId: 'b', name: 'mail.read', startedAt: 3 }),
      item(4, 'agent', {
        startedAt: 11,
        endedAt: 20,
        outputJson: '{"text":"Second answer"}',
      }),
      item(5, 'tool', { callId: 'c', name: 'calendar.read', startedAt: 12 }),
    ]);

    expect(messages.map((message) => message.kind)).toEqual(['user', 'tools', 'ai', 'tools', 'ai']);
    expect(messages.filter((message) => message.kind === 'tools')).toHaveLength(2);
    expect(
      messages
        .filter((message) => message.kind === 'ai' && !message.streaming)
        .map((message) => (message.kind === 'ai' && !message.streaming ? message.copyText : '')),
    ).toEqual(['First answer', 'Second answer']);
  });

  it('renders a durable max_tokens stop reason as a distinct error bubble', () => {
    const messages = automationTurnMessages(turn(), [
      item(1, 'agent', {
        outputJson: '{"text":"Partial answer"}',
        rawJson: '{"stopReason":"max_tokens"}',
      }),
    ]);
    expect(messages).toEqual([
      expect.objectContaining({ kind: 'ai', error: false, copyText: 'Partial answer' }),
      expect.objectContaining({
        kind: 'ai',
        error: true,
        copyText:
          'The agent hit its output token limit before finishing — the reply may be incomplete.',
      }),
    ]);
  });
});

describe('automation turn live projection', () => {
  it('isolates final state, text, and tools by native item identity', () => {
    let state = createAutomationLiveTrace('Run the brief.');
    state = startAutomationLiveItem(state, {
      itemId: 'agent-a',
      ordinal: 1,
      kind: 'agent',
    });
    state = startAutomationLiveItem(state, {
      itemId: 'tool-a',
      ordinal: 2,
      kind: 'tool',
    });
    state = reduceAutomationItemEvent(state, {
      itemId: 'tool-a',
      ordinal: 2,
      event: { type: 'tool.start', toolCallId: 'tool-a', toolName: 'mail.read' },
    });
    state = reduceAutomationItemEvent(state, {
      itemId: 'agent-a',
      ordinal: 1,
      event: { type: 'final', text: 'First answer', stopReason: 'end_turn' },
    });
    state = startAutomationLiveItem(state, {
      itemId: 'agent-b',
      ordinal: 4,
      kind: 'agent',
    });
    state = startAutomationLiveItem(state, {
      itemId: 'tool-b',
      ordinal: 5,
      kind: 'tool',
    });
    state = reduceAutomationItemEvent(state, {
      itemId: 'tool-b',
      ordinal: 5,
      event: { type: 'tool.start', toolCallId: 'tool-b', toolName: 'calendar.read' },
    });
    state = reduceAutomationItemEvent(state, {
      itemId: 'agent-b',
      ordinal: 4,
      event: { type: 'final', text: 'Second answer', stopReason: 'end_turn' },
    });

    const messages = automationLiveMessages(state);
    expect(messages.map((message) => message.kind)).toEqual(['user', 'tools', 'ai', 'tools', 'ai']);
    expect(
      messages
        .filter((message) => message.kind === 'ai' && !message.streaming)
        .map((message) => (message.kind === 'ai' && !message.streaming ? message.copyText : '')),
    ).toEqual(['First answer', 'Second answer']);
    expect(
      messages
        .filter((message) => message.kind === 'tools')
        .flatMap((message) => (message.kind === 'tools' ? message.calls : [])),
    ).toEqual([
      { tool: 'mail.read', state: 'run', meta: 'running…' },
      { tool: 'calendar.read', state: 'run', meta: 'running…' },
    ]);
  });

  it('keeps a tool started after an agent final as a standalone row', () => {
    let state = createAutomationLiveTrace('Run the brief.');
    state = startAutomationLiveItem(state, {
      itemId: 'agent-a',
      ordinal: 1,
      kind: 'agent',
    });
    state = reduceAutomationItemEvent(state, {
      itemId: 'agent-a',
      ordinal: 1,
      event: { type: 'final', text: 'First answer', stopReason: 'end_turn' },
    });
    state = startAutomationLiveItem(state, {
      itemId: 'standalone-tool',
      ordinal: 2,
      kind: 'tool',
    });
    state = reduceAutomationItemEvent(state, {
      itemId: 'standalone-tool',
      ordinal: 2,
      event: { type: 'tool.start', toolCallId: 'vault', toolName: 'vault.invoke' },
    });

    const messages = automationLiveMessages(state);
    expect(messages.map((message) => message.kind)).toEqual(['user', 'ai', 'tools']);
    expect(messages.filter((message) => message.kind === 'ai')).toHaveLength(1);
  });

  it('keeps the completed durable prefix when a second viewer joins mid-turn', () => {
    let state = createAutomationLiveTraceFromItems('Run the brief.', [
      item(0, 'message_in', { text: 'Run the brief.' }),
      item(1, 'agent', {
        startedAt: 1,
        endedAt: 10,
        outputJson: '{"text":"First answer"}',
      }),
      item(2, 'tool', {
        callId: 'mail',
        name: 'mail.read',
        startedAt: 2,
        endedAt: 4,
      }),
      item(3, 'agent', { startedAt: 11, endedAt: undefined }),
    ]);
    // Durable replay repeats the already-seeded start/end pair. Both are
    // idempotent; the completed answer and tool remain visible.
    state = startAutomationLiveItem(state, {
      itemId: 'item-1',
      ordinal: 1,
      kind: 'agent',
      name: 'run',
    });
    state = finishAutomationLiveItem(state, {
      itemId: 'item-1',
      ordinal: 1,
      ok: true,
      result: { text: 'First answer' },
      durationMs: 9,
    });
    const messages = automationLiveMessages(state);
    expect(messages.map((message) => message.kind)).toEqual(['user', 'tools', 'ai', 'ai']);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'tools', label: '1 tool' }),
        expect.objectContaining({ kind: 'ai', copyText: 'First answer' }),
        expect.objectContaining({ kind: 'ai', streaming: true }),
      ]),
    );
  });

  it('hydrates an item.end replay even when no ephemeral deltas were observed', () => {
    let state = createAutomationLiveTrace();
    state = startAutomationLiveItem(state, {
      itemId: 'agent',
      ordinal: 1,
      kind: 'agent',
    });
    state = finishAutomationLiveItem(state, {
      itemId: 'agent',
      ordinal: 1,
      ok: true,
      result: { text: 'Recovered answer', stopReason: 'max_turn_requests' },
      rawJson: '{"stopReason":"max_turn_requests"}',
      durationMs: 25,
    });
    expect(automationLiveMessages(state)).toEqual([
      expect.objectContaining({ kind: 'ai', copyText: 'Recovered answer' }),
      expect.objectContaining({
        kind: 'ai',
        error: true,
        copyText:
          'The agent hit its max turn/request limit before finishing — the reply may be incomplete.',
      }),
    ]);
  });
});

describe('compile-turn inbound bubble (#541)', () => {
  const WORK_ORDER = [
    'Compile this automation headlessly. Do not ask questions.',
    "Use generated.by = 'centraid-compiler'.",
    'Resolved anchors: core.link_anchor/anchor-1 → invoice.total',
  ].join('\n\n');

  it('never renders the compiler work order as the owner’s own message', () => {
    const messages = automationTurnMessages(turn({ triggerKind: 'compile' }), [
      item(0, 'message_in', { text: WORK_ORDER }),
      item(1, 'agent', { startedAt: 1, endedAt: 10, outputJson: '{"text":"Plan ready"}' }),
    ]);
    const user = messages.find((message) => message.kind === 'user');
    expect(user).toEqual(
      expect.objectContaining({ kind: 'user', text: COMPILE_TURN_INBOUND_TEXT }),
    );
    expect(JSON.stringify(messages)).not.toContain('centraid-compiler');
  });

  it('keeps a non-compile turn’s inbound message verbatim', () => {
    const messages = automationTurnMessages(turn({ triggerKind: 'interactive' }), [
      item(0, 'message_in', { text: 'only flag movers over 5%' }),
    ]);
    expect(messages[0]).toEqual(
      expect.objectContaining({ kind: 'user', text: 'only flag movers over 5%' }),
    );
  });

  it('agrees with the live seed on the same turn', () => {
    const items = [item(0, 'message_in', { text: WORK_ORDER })];
    // The cold projection and the live seed read the same turn — they must
    // put the same words in the owner's bubble.
    expect(automationTurnInboundText(turn({ triggerKind: 'compile' }), items)).toBe(
      COMPILE_TURN_INBOUND_TEXT,
    );
    expect(automationTurnMessages(turn({ triggerKind: 'compile' }), items)[0]).toEqual(
      expect.objectContaining({ text: COMPILE_TURN_INBOUND_TEXT }),
    );
    expect(automationTurnInboundText(turn({ triggerKind: 'manual' }), items)).toBe(WORK_ORDER);
  });

  it('gives every projected message a stable id that survives a tool flush', () => {
    const before = automationTurnMessages(turn({ endedAt: undefined }), [
      item(0, 'message_in', { text: 'go' }),
      item(1, 'agent', { startedAt: 1, endedAt: undefined }),
    ]);
    const after = automationTurnMessages(turn({ endedAt: undefined }), [
      item(0, 'message_in', { text: 'go' }),
      item(1, 'agent', { startedAt: 1, endedAt: undefined }),
      item(2, 'tool', { callId: 'a', name: 'mail.search', startedAt: 2, endedAt: undefined }),
    ]);
    // The tools row is inserted AHEAD of the agent bubble on flush, so index 1
    // changes identity — the ids must not.
    expect(before.map((message) => message.msgId)).toEqual(['item-0:in', 'item-1:ai']);
    expect(after.map((message) => message.msgId)).toEqual([
      'item-0:in',
      'item-2:tools',
      'item-1:ai',
    ]);
  });
});
