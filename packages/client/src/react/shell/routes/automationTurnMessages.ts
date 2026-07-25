import type { TurnStreamEvent } from '@centraid/blueprints/kit/turn-stream.js';
import type { AsstMsgDTO, AsstToolCallDTO, AsstUsageDTO } from '../../screen-contracts.js';
import { richAnswerHtml } from './assistantRich.js';

function itemText(json: string | undefined, fallback = ''): string {
  if (!json) return fallback;
  try {
    const value = JSON.parse(json) as unknown;
    if (typeof value === 'string') return value;
    if (
      value &&
      typeof value === 'object' &&
      typeof (value as { text?: unknown }).text === 'string'
    ) {
      return (value as { text: string }).text;
    }
    return JSON.stringify(value, null, 2);
  } catch {
    return json;
  }
}

function usageForItem(item: CentraidAutomationItem): AsstUsageDTO | undefined {
  if (
    item.inputTokens === undefined &&
    item.outputTokens === undefined &&
    item.costUsd === undefined &&
    item.model === undefined
  ) {
    return undefined;
  }
  return {
    ...(item.inputTokens !== undefined ? { inputTokens: item.inputTokens } : {}),
    ...(item.outputTokens !== undefined ? { outputTokens: item.outputTokens } : {}),
    ...(item.costUsd !== undefined ? { costUsd: item.costUsd } : {}),
    ...(item.costSource === 'estimated' ? { estimated: true } : {}),
    ...(item.model !== undefined ? { model: item.model } : {}),
  };
}

function toolLabel(calls: readonly AsstToolCallDTO[]): string {
  const running = calls.some((entry) => entry.state === 'run');
  const failed = calls.filter((entry) => entry.state === 'error').length;
  return running
    ? 'using tools…'
    : `${calls.length} ${calls.length === 1 ? 'tool' : 'tools'}${failed ? ` · ${failed} failed` : ''}`;
}

/**
 * Convert a native automation turn directly to the shared conversation
 * message DTO. Calls coalesce by callId, so overlapping same-named ACP calls
 * remain distinct while start/result updates for one call stay one row.
 *
 * Tool items are nested beneath their owning agent item in the ledger, so the
 * transcript deliberately emits inbound messages, then tool activity, then
 * completed agent/step answers rather than trusting raw ordinal order.
 */
export function automationTurnMessages(
  turn: CentraidAutomationTurnRecord,
  items: readonly CentraidAutomationItem[],
  liveText: ReadonlyMap<number, string> = new Map(),
): AsstMsgDTO[] {
  const inbound = items
    .filter((item) => item.kind === 'message_in')
    .map(
      (item): AsstMsgDTO => ({
        kind: 'user',
        text: item.text ?? '',
        createdAt: item.startedAt,
      }),
    );
  const calls: AsstToolCallDTO[] = [];
  const callIndex = new Map<string, number>();
  for (const item of items.filter((candidate) => candidate.kind === 'tool')) {
    const key = item.callId ?? item.itemId;
    const state = item.endedAt === undefined ? 'run' : item.ok ? 'ok' : 'error';
    const call: AsstToolCallDTO = {
      tool: item.name ?? 'tool',
      state,
      meta:
        state === 'run'
          ? 'running…'
          : state === 'error'
            ? (item.error ?? 'failed')
            : item.durationMs !== undefined
              ? `${item.durationMs}ms`
              : 'completed',
    };
    const prior = callIndex.get(key);
    if (prior !== undefined) calls[prior] = call;
    else callIndex.set(key, calls.push(call) - 1);
  }
  const toolMessages: AsstMsgDTO[] =
    calls.length > 0 ? [{ kind: 'tools', label: toolLabel(calls), calls }] : [];

  const answers: AsstMsgDTO[] = [];
  for (const item of items.filter(
    (candidate) => candidate.kind === 'agent' || candidate.kind === 'step',
  )) {
    const live = liveText.get(item.ordinal) ?? '';
    if (item.endedAt === undefined) {
      answers.push({ kind: 'ai', streaming: true, text: live });
      continue;
    }
    const text = item.ok
      ? itemText(item.outputJson, live)
      : (item.error ?? itemText(item.outputJson, 'The agent call failed.'));
    const usage = usageForItem(item);
    answers.push({
      kind: 'ai',
      streaming: false,
      html: richAnswerHtml(text),
      error: !item.ok,
      copyText: text,
      createdAt: item.endedAt,
      turnId: turn.turnId,
      feedback: null,
      ...(usage ? { usage } : {}),
    });
  }

  if (answers.length === 0 && turn.endedAt !== undefined) {
    const text = turn.ok
      ? itemText(turn.outputJson, turn.summary ?? 'The automation completed.')
      : (turn.error ?? 'The automation did not complete.');
    answers.push({
      kind: 'ai',
      streaming: false,
      html: richAnswerHtml(text),
      error: !turn.ok,
      copyText: text,
      createdAt: turn.endedAt,
      turnId: turn.turnId,
      feedback: turn.feedback ?? null,
    });
  }
  return [...inbound, ...toolMessages, ...answers];
}

export interface AutomationLiveTraceState {
  message: string;
  assistantText: string;
  reasoningText: string;
  tools: AsstToolCallDTO[];
  toolIndex: ReadonlyMap<string, number>;
  notices: Array<{ level: 'warn' | 'info'; text: string }>;
  usage?: AsstUsageDTO;
  finalText?: string;
  error?: string;
  done: boolean;
}

export function createAutomationLiveTrace(message = ''): AutomationLiveTraceState {
  return {
    message,
    assistantText: '',
    reasoningText: '',
    tools: [],
    toolIndex: new Map(),
    notices: [],
    done: false,
  };
}

/** Pure reducer for the standard conversation TurnStreamEvent grammar. */
export function reduceAutomationTurnEvent(
  state: AutomationLiveTraceState,
  event: TurnStreamEvent,
): AutomationLiveTraceState {
  if (event.type === 'assistant.delta') {
    return { ...state, assistantText: state.assistantText + event.delta };
  }
  if (event.type === 'reasoning.delta') {
    return { ...state, reasoningText: state.reasoningText + event.delta };
  }
  if (event.type === 'tool.start' || event.type === 'tool.result') {
    const tools = state.tools.slice();
    const toolIndex = new Map(state.toolIndex);
    const prior = toolIndex.get(event.toolCallId);
    const call: AsstToolCallDTO =
      event.type === 'tool.start'
        ? { tool: event.toolName, state: 'run', meta: 'running…' }
        : {
            tool: event.toolName,
            state: event.ok ? 'ok' : 'error',
            meta: event.ok ? 'completed' : (event.errorText ?? 'failed'),
          };
    if (prior === undefined) toolIndex.set(event.toolCallId, tools.push(call) - 1);
    else tools[prior] = call;
    return { ...state, tools, toolIndex };
  }
  if (event.type === 'notice') {
    return {
      ...state,
      notices: [...state.notices, { level: event.level, text: event.message }],
    };
  }
  if (event.type === 'usage') {
    return {
      ...state,
      usage: {
        ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
        ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
        ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
        ...(event.costSource === 'estimated' ? { estimated: true } : {}),
        ...(event.model !== undefined ? { model: event.model } : {}),
      },
    };
  }
  if (event.type === 'final') {
    return { ...state, finalText: event.text, done: true };
  }
  if (event.type === 'error') {
    return { ...state, error: event.message, done: true };
  }
  if (event.type === 'aborted') {
    return { ...state, error: 'The automation turn was stopped.', done: true };
  }
  return state;
}

/** Project live reducer state into the exact DTO consumed by shared Message. */
export function automationLiveMessages(state: AutomationLiveTraceState): AsstMsgDTO[] {
  const messages: AsstMsgDTO[] = [];
  if (state.message) messages.push({ kind: 'user', text: state.message });
  if (state.reasoningText) {
    messages.push({ kind: 'thinking', text: state.reasoningText, streaming: !state.done });
  }
  if (state.tools.length > 0) {
    messages.push({ kind: 'tools', label: toolLabel(state.tools), calls: state.tools });
  }
  for (const notice of state.notices) messages.push({ kind: 'notice', ...notice });
  const answer = state.error ?? state.finalText ?? state.assistantText;
  if (!state.done) {
    messages.push({ kind: 'ai', streaming: true, text: answer });
  } else {
    const text = answer || 'The automation completed.';
    messages.push({
      kind: 'ai',
      streaming: false,
      html: richAnswerHtml(text),
      error: state.error !== undefined,
      copyText: text,
      feedback: null,
      ...(state.usage ? { usage: state.usage } : {}),
    });
  }
  return messages;
}
