import type { TurnStreamEvent } from '@centraid/blueprints/kit/turn-stream.js';
import type { AsstMsgDTO, AsstToolCallDTO, AsstUsageDTO } from '../../screen-contracts.js';
import { richAnswerHtml } from './assistantRich.js';
import {
  itemText,
  stopReasonBubble,
  stopReasonForItem,
  stopReasonFromJson,
  stopReasonIn,
  toolLabel,
  usageForItem,
} from './automationTurnMessages.js';

interface AutomationLiveItemState {
  itemId: string;
  ordinal: number;
  kind: CentraidAutomationItem['kind'];
  name?: string;
  callId?: string;
  /** Agent item that was still open when this tool started. */
  parentItemId?: string;
  assistantText: string;
  reasoningText: string;
  tools: AsstToolCallDTO[];
  toolIndex: ReadonlyMap<string, number>;
  notices: Array<{ level: 'warn' | 'info'; text: string }>;
  usage?: AsstUsageDTO;
  finalText?: string;
  error?: string;
  stopReason?: string;
  done: boolean;
}

export interface AutomationLiveTraceState {
  message: string;
  items: ReadonlyMap<string, AutomationLiveItemState>;
}

function createLiveItem(
  itemId: string,
  ordinal: number,
  kind: CentraidAutomationItem['kind'],
  parentItemId?: string,
  name?: string,
  callId?: string,
): AutomationLiveItemState {
  const state: AutomationLiveItemState = {
    itemId,
    ordinal,
    kind,
    ...(parentItemId ? { parentItemId } : {}),
    ...(name ? { name } : {}),
    ...(callId ? { callId } : {}),
    assistantText: '',
    reasoningText: '',
    tools: [],
    toolIndex: new Map(),
    notices: [],
    done: false,
  };
  if (kind === 'tool' && name) {
    state.tools = [{ tool: name, state: 'run', meta: 'running…' }];
    state.toolIndex = new Map([[callId ?? itemId, 0]]);
  }
  return state;
}

function activeAgentItemId(
  state: AutomationLiveTraceState,
  beforeOrdinal: number,
): string | undefined {
  return [...state.items.values()]
    .filter((item) => item.kind === 'agent' && !item.done && item.ordinal < beforeOrdinal)
    .sort((left, right) => right.ordinal - left.ordinal)[0]?.itemId;
}

export function createAutomationLiveTrace(message = ''): AutomationLiveTraceState {
  return {
    message,
    items: new Map(),
  };
}

/** Seed a live trace from the durable prefix already visible to a late viewer. */
export function createAutomationLiveTraceFromItems(
  message: string,
  sourceItems: readonly CentraidAutomationItem[],
): AutomationLiveTraceState {
  const items = new Map<string, AutomationLiveItemState>();
  const ordered = sourceItems
    .filter((item) => item.kind !== 'message_in')
    .toSorted((left, right) => left.ordinal - right.ordinal || left.startedAt - right.startedAt);
  let parentAgent: CentraidAutomationItem | undefined;
  for (const item of ordered) {
    if (item.kind === 'agent') parentAgent = item;
    const parentItemId =
      item.kind === 'tool' &&
      parentAgent &&
      (parentAgent.endedAt === undefined || item.startedAt <= parentAgent.endedAt)
        ? parentAgent.itemId
        : undefined;
    const live = createLiveItem(
      item.itemId,
      item.ordinal,
      item.kind,
      parentItemId,
      item.name,
      item.callId,
    );
    const usage = usageForItem(item);
    if (item.kind === 'tool') {
      const key = item.callId ?? item.itemId;
      live.tools = [
        {
          tool: item.name ?? 'tool',
          state: item.endedAt === undefined ? 'run' : item.ok ? 'ok' : 'error',
          meta:
            item.endedAt === undefined
              ? 'running…'
              : item.ok
                ? item.durationMs !== undefined
                  ? `${item.durationMs}ms`
                  : 'completed'
                : (item.error ?? 'failed'),
        },
      ];
      live.toolIndex = new Map([[key, 0]]);
    } else if (item.kind === 'step' && item.name?.startsWith('notice:')) {
      const [, level] = item.name.split(':');
      const text = itemText(item.outputJson);
      if (text) {
        live.notices = [{ level: level === 'warn' ? 'warn' : 'info', text }];
      }
    } else {
      const text = itemText(item.outputJson);
      if (text) live.finalText = text;
      if (!item.ok && item.error) live.error = item.error;
    }
    if (usage) live.usage = usage;
    const stopReason = stopReasonForItem(item);
    if (stopReason) live.stopReason = stopReason;
    live.done = item.endedAt !== undefined;
    items.set(item.itemId, live);
  }
  return { message, items };
}

function reduceLiveItem(
  state: AutomationLiveItemState,
  event: TurnStreamEvent,
): AutomationLiveItemState {
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
    return {
      ...state,
      finalText: event.text,
      ...(event.stopReason ? { stopReason: event.stopReason } : {}),
      done: true,
    };
  }
  if (event.type === 'error') {
    return {
      ...state,
      error: event.message,
      ...(event.stopReason ? { stopReason: event.stopReason } : {}),
      done: true,
    };
  }
  if (event.type === 'aborted') {
    return { ...state, error: 'The automation turn was stopped.', done: true };
  }
  return state;
}

/** Pure reducer for one identified native item delta. */
export function reduceAutomationItemEvent(
  state: AutomationLiveTraceState,
  input: { itemId: string; ordinal: number; event: TurnStreamEvent },
): AutomationLiveTraceState {
  const items = new Map(state.items);
  const prior =
    items.get(input.itemId) ??
    createLiveItem(
      input.itemId,
      input.ordinal,
      input.event.type === 'tool.start' || input.event.type === 'tool.result' ? 'tool' : 'agent',
      input.event.type === 'tool.start' || input.event.type === 'tool.result'
        ? activeAgentItemId(state, input.ordinal)
        : undefined,
    );
  items.set(input.itemId, reduceLiveItem(prior, input.event));
  return { ...state, items };
}

/** Register a native item before its nested standard events arrive. */
export function startAutomationLiveItem(
  state: AutomationLiveTraceState,
  input: {
    itemId: string;
    ordinal: number;
    kind: CentraidAutomationItem['kind'];
    name?: string;
    callId?: string;
  },
): AutomationLiveTraceState {
  if (state.items.has(input.itemId)) return state;
  const items = new Map(state.items);
  items.set(
    input.itemId,
    createLiveItem(
      input.itemId,
      input.ordinal,
      input.kind,
      input.kind === 'tool' ? activeAgentItemId(state, input.ordinal) : undefined,
      input.name,
      input.callId,
    ),
  );
  return { ...state, items };
}

/** Hydrate and settle one durable item.end replay/live event. */
export function finishAutomationLiveItem(
  state: AutomationLiveTraceState,
  input: {
    itemId: string;
    ordinal: number;
    callId?: string;
    ok: boolean;
    result?: unknown;
    error?: string;
    durationMs: number;
    rawJson?: string;
  },
): AutomationLiveTraceState {
  const items = new Map(state.items);
  const prior =
    items.get(input.itemId) ??
    createLiveItem(input.itemId, input.ordinal, input.callId ? 'tool' : 'agent', undefined);
  const next: AutomationLiveItemState = { ...prior, done: true };
  if (prior.kind === 'tool') {
    const key = input.callId ?? prior.callId ?? input.itemId;
    const tools = prior.tools.slice();
    const toolIndex = new Map(prior.toolIndex);
    const index = toolIndex.get(key) ?? 0;
    tools[index] = {
      tool: tools[index]?.tool ?? prior.name ?? 'tool',
      state: input.ok ? 'ok' : 'error',
      meta: input.ok
        ? input.durationMs > 0
          ? `${input.durationMs}ms`
          : 'completed'
        : (input.error ?? 'failed'),
    };
    toolIndex.set(key, index);
    next.tools = tools;
    next.toolIndex = toolIndex;
  } else {
    const text =
      typeof input.result === 'string'
        ? input.result
        : input.result && typeof input.result === 'object'
          ? typeof (input.result as { text?: unknown }).text === 'string'
            ? (input.result as { text: string }).text
            : JSON.stringify(input.result, null, 2)
          : '';
    if (text) next.finalText = text;
  }
  if (!input.ok && input.error) next.error = input.error;
  const stopReason = stopReasonIn(input.result) ?? stopReasonFromJson(input.rawJson);
  if (stopReason) next.stopReason = stopReason;
  items.set(input.itemId, next);
  return { ...state, items };
}

/** Pure reducer for a direct, single-agent standard turn stream. */
export function reduceAutomationTurnEvent(
  state: AutomationLiveTraceState,
  event: TurnStreamEvent,
): AutomationLiveTraceState {
  const started = startAutomationLiveItem(state, {
    itemId: 'direct',
    ordinal: 0,
    kind: 'agent',
  });
  return reduceAutomationItemEvent(started, { itemId: 'direct', ordinal: 0, event });
}

/** Settle an outer native turn when its ledger reread is briefly unavailable. */
export function finishAutomationLiveTrace(
  state: AutomationLiveTraceState,
  error?: string,
): AutomationLiveTraceState {
  const items = new Map(state.items);
  if (items.size === 0) {
    items.set('terminal', {
      ...createLiveItem('terminal', 0, 'agent'),
      ...(error ? { error } : { finalText: 'The automation completed.' }),
      done: true,
    });
    return { ...state, items };
  }
  const ordered = [...items.values()].sort(
    (left, right) => left.ordinal - right.ordinal || left.itemId.localeCompare(right.itemId),
  );
  for (const item of ordered) items.set(item.itemId, { ...item, done: true });
  if (error) {
    const last = ordered.at(-1)!;
    items.set(last.itemId, { ...items.get(last.itemId)!, error, done: true });
  }
  return { ...state, items };
}

function liveItemMessages(
  state: AutomationLiveItemState,
  nestedTools: readonly AsstToolCallDTO[] = [],
): AsstMsgDTO[] {
  const messages: AsstMsgDTO[] = [];
  if (state.reasoningText) {
    messages.push({
      kind: 'thinking',
      text: state.reasoningText,
      streaming: !state.done,
      msgId: `${state.itemId}:thinking`,
    });
  }
  const tools = [...state.tools, ...nestedTools];
  if (tools.length > 0) {
    messages.push({
      kind: 'tools',
      label: toolLabel(tools),
      calls: tools,
      msgId: `${state.itemId}:tools`,
    });
  }
  for (const [index, notice] of state.notices.entries()) {
    messages.push({ kind: 'notice', ...notice, msgId: `${state.itemId}:notice:${index}` });
  }
  const answer = state.error ?? state.finalText ?? state.assistantText;
  if (!answer && (state.kind === 'tool' || state.notices.length > 0)) return messages;
  if (!state.done) {
    messages.push({ kind: 'ai', streaming: true, text: answer, msgId: `${state.itemId}:ai` });
  } else {
    const text = answer || 'The automation completed.';
    messages.push({
      kind: 'ai',
      streaming: false,
      html: richAnswerHtml(text),
      error: state.error !== undefined,
      copyText: text,
      feedback: null,
      msgId: `${state.itemId}:ai`,
      ...(state.usage ? { usage: state.usage } : {}),
    });
  }
  const stop = stopReasonBubble(state.stopReason);
  if (stop && (state.error === undefined || stop.copyText !== answer)) {
    messages.push({ ...stop, msgId: `${state.itemId}:stop` });
  }
  return messages;
}

/** Project live reducer state into the exact DTO consumed by shared Message. */
export function automationLiveMessages(state: AutomationLiveTraceState): AsstMsgDTO[] {
  const messages: AsstMsgDTO[] = [];
  if (state.message) messages.push({ kind: 'user', text: state.message, msgId: 'inbound' });
  const ordered = [...state.items.values()].sort(
    (left, right) => left.ordinal - right.ordinal || left.itemId.localeCompare(right.itemId),
  );
  let pendingAgent: AutomationLiveItemState | undefined;
  let nestedTools: AsstToolCallDTO[] = [];
  const flushAgent = (): void => {
    if (!pendingAgent) return;
    messages.push(...liveItemMessages(pendingAgent, nestedTools));
    pendingAgent = undefined;
    nestedTools = [];
  };
  for (const item of ordered) {
    if (item.kind === 'agent') {
      flushAgent();
      pendingAgent = item;
      continue;
    }
    if (item.kind === 'tool' && item.parentItemId === pendingAgent?.itemId) {
      nestedTools.push(...item.tools);
      continue;
    }
    flushAgent();
    messages.push(...liveItemMessages(item));
  }
  flushAgent();
  return messages;
}
