/*
 * Interactive automation turn (issue #541, Wave 6).
 *
 * The ACP session is only a cache. Every steering turn receives a compact
 * preamble reconstructed from the durable automation conversation, so a cold
 * process and a resumed process see the same standing instructions, recent
 * outcomes, connector bindings, and requested vault scope. The turn itself is
 * persisted directly to the native conversation → turn → item ledger while
 * shared `TurnStreamEvent`s fan out to the caller and, nested under the owning
 * item, to the automation turn event bus for second-viewer parity.
 */

import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  ConversationStore,
  makeJournalDbProvider,
  resolveItemCost,
  withConversationLock,
  type AutomationTurnStreamEvent,
  type ConversationRunner,
  type RunnerKind,
  type Turn,
  type TurnStreamEvent,
} from '@centraid/app-engine';
import type { Row as AutomationRow } from '@centraid/automation';

const PREAMBLE_CHAR_BUDGET = 12_000;
const RECENT_TURN_LIMIT = 6;
const AUDIT_CHAR_BUDGET = 64 * 1024;

function safeJson(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json.length <= AUDIT_CHAR_BUDGET) return json;
    return JSON.stringify({
      _truncated: true,
      chars: json.length,
      head: json.slice(0, 512),
    });
  } catch {
    return JSON.stringify({ _truncated: true, reason: 'unserializable' });
  }
}

function contextTurnLine(turn: Turn): string | undefined {
  const result = turn.summary ?? turn.outputJson ?? turn.error;
  if (!result) return undefined;
  const status = turn.endedAt === undefined ? 'running' : turn.ok ? 'ok' : 'error';
  return `- ${turn.triggerKind} (${status}): ${result.slice(0, 1_500)}`;
}

/**
 * Deterministic, ledger-sufficient context. Native ACP resume may improve
 * quality, but correctness never depends on it.
 */
export function automationContextPreamble(
  row: AutomationRow,
  recentTurns: readonly Turn[],
  steeringMessage: string,
  budget = PREAMBLE_CHAR_BUDGET,
): string {
  const history = [...recentTurns]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map(contextTurnLine)
    .filter((line): line is string => line !== undefined)
    .slice(-RECENT_TURN_LIMIT);
  const connections = row.manifest.connections?.map((binding) => ({
    connectionId: binding.connectionId,
    kind: binding.kind,
    label: binding.label,
  }));
  const scope = row.manifest.vault
    ? {
        purpose: row.manifest.vault.purpose,
        scopes: row.manifest.vault.scopes,
      }
    : undefined;
  const sections = [
    'You are the interactive register for one Centraid automation.',
    'Use only the host-provided tools and already-granted vault access. Never ask to widen permissions. Do not edit automation source files; standing-instruction changes use the separate revision flow.',
    `Automation: ${row.name} (${row.ref})`,
    `Standing instructions:\n${row.manifest.prompt}`,
    connections?.length ? `Bound connector accounts:\n${safeJson(connections)}` : '',
    scope
      ? `Declared vault access (the host still enforces the actual grant):\n${safeJson(scope)}`
      : '',
    history.length ? `Recent durable turn outcomes:\n${history.join('\n')}` : '',
    `Current steering message:\n${steeringMessage}`,
  ].filter(Boolean);
  const full = sections.join('\n\n');
  if (full.length <= budget) return full;
  // Standing instructions and the current message are load-bearing. Trim only
  // from the middle history/context area by retaining both ends.
  const head = Math.max(0, Math.floor(budget * 0.68));
  const tail = Math.max(0, budget - head - 40);
  return `${full.slice(0, head)}\n\n[context truncated]\n\n${full.slice(-tail)}`;
}

type UsageEvent = Extract<TurnStreamEvent, { type: 'usage' }>;

function pricedUsage(event: UsageEvent): UsageEvent {
  if (event.costUsd !== undefined) {
    return event.costSource ? event : { ...event, costSource: 'agent' };
  }
  const priced = resolveItemCost({
    model: event.model,
    usage: {
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheWriteTokens: event.cacheWriteTokens,
    },
    estimateUnknownModel: true,
  });
  return priced.costUsd === undefined
    ? event
    : {
        ...event,
        costUsd: priced.costUsd,
        costSource: priced.costSource,
      };
}

function usageFields(usage: UsageEvent | undefined): {
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
  costSource?: 'agent' | 'estimated';
} {
  if (!usage) return {};
  return {
    ...(usage.model !== undefined ? { model: usage.model } : {}),
    ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
    ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
    ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
    ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    ...(usage.costSource !== undefined ? { costSource: usage.costSource } : {}),
  };
}

function itemId(turnId: string, ordinal: number): string {
  return `${turnId}:${ordinal}:${randomUUID().slice(0, 6)}`;
}

export interface InteractiveAutomationTurnOptions {
  row: AutomationRow;
  turnId: string;
  message: string;
  journalDbFile: string;
  runnerSessionDir: string;
  runner: ConversationRunner;
  runnerKind: RunnerKind;
  model?: string;
  abortSignal: AbortSignal;
  conversationLocks: Map<string, Promise<void>>;
  /** Direct SSE sink. */
  onEvent: (event: TurnStreamEvent) => void;
  /** Automation bus sink for replay/second-viewer parity. */
  onTurnEvent?: (event: AutomationTurnStreamEvent) => void;
}

export interface InteractiveAutomationTurnResult {
  turnId: string;
  ok: boolean;
  error?: string;
}

/**
 * Run one steering turn. The lock covers ledger context selection, runner
 * dispatch, and resume-handle update so two messages on one automation cannot
 * race the same cached ACP session.
 */
export async function runInteractiveAutomationTurn(
  opts: InteractiveAutomationTurnOptions,
): Promise<InteractiveAutomationTurnResult> {
  const store = new ConversationStore(makeJournalDbProvider(opts.journalDbFile));
  const ref = opts.row.ref;
  const conversationId = store.ensureAutomationConversation(
    ref,
    opts.row.ownerApp,
    opts.row.name,
    opts.runnerKind,
  );

  return withConversationLock(opts.conversationLocks, opts.row.ownerApp, ref, async () => {
    const conversation = store.getConversation(conversationId);
    if (!conversation) {
      throw new Error(`automation conversation "${conversationId}" was not created`);
    }

    const recentTurns = store.listTurns(conversationId).toReversed().slice(0, RECENT_TURN_LIMIT);
    const preamble = automationContextPreamble(opts.row, recentTurns, opts.message);
    const startedAt = Date.now();
    store.insertTurn({
      turnId: opts.turnId,
      conversationId,
      triggerKind: 'interactive',
      triggerOrigin: 'manual',
      note: 'Interactive steering turn',
      startedAt,
    });
    store.insertMessageIn({
      turnId: opts.turnId,
      role: 'user',
      text: opts.message,
      startedAt,
    });

    const emitTurn = (event: AutomationTurnStreamEvent): void => {
      try {
        opts.onTurnEvent?.(event);
      } catch {
        /* a subscriber must not fail the turn */
      }
    };
    emitTurn({ type: 'turn.start', turnId: opts.turnId });

    let nextOrdinal = 1;
    const agentOrdinal = nextOrdinal++;
    const agentItemId = itemId(opts.turnId, agentOrdinal);
    store.openItem({
      itemId: agentItemId,
      turnId: opts.turnId,
      ordinal: agentOrdinal,
      kind: 'agent',
      name: 'interactive',
      argsJson: safeJson({ message: opts.message }),
      startedAt,
    });
    emitTurn({
      type: 'item.start',
      itemId: agentItemId,
      ordinal: agentOrdinal,
      kind: 'agent',
      name: 'interactive',
      args: { message: opts.message },
    });

    const toolItems = new Map<
      string,
      { itemId: string; ordinal: number; startedAt: number; name: string }
    >();
    let text = '';
    let finalText: string | undefined;
    let finalRawJson: string | undefined;
    let stopReason: string | undefined;
    let failure: string | undefined;
    let usage: UsageEvent | undefined;

    const closeTool = (
      callId: string,
      open: { itemId: string; ordinal: number; startedAt: number; name: string },
      event: Extract<TurnStreamEvent, { type: 'tool.result' }> | { ok: false; errorText: string },
    ): void => {
      const endedAt = Date.now();
      const result = 'result' in event ? event.result : undefined;
      const rawJson = 'rawJson' in event ? event.rawJson : undefined;
      const error = event.ok ? undefined : event.errorText || 'Tool failed.';
      store.closeItem({
        itemId: open.itemId,
        ok: event.ok,
        ...(result !== undefined ? { outputJson: safeJson(result) } : {}),
        ...(rawJson !== undefined ? { rawJson } : {}),
        ...(error !== undefined ? { error } : {}),
        endedAt,
        durationMs: endedAt - open.startedAt,
      });
      emitTurn({
        type: 'item.end',
        itemId: open.itemId,
        ordinal: open.ordinal,
        callId,
        ok: event.ok,
        ...(result !== undefined ? { result } : {}),
        ...(error !== undefined ? { error } : {}),
        durationMs: endedAt - open.startedAt,
        ...(rawJson !== undefined ? { rawJson } : {}),
      });
      toolItems.delete(callId);
    };

    const onEvent = (incoming: TurnStreamEvent): void => {
      const event = incoming.type === 'usage' ? pricedUsage(incoming) : incoming;
      if (event.type === 'assistant.delta') text += event.delta;
      if (event.type === 'usage') usage = event;
      if (event.type === 'final') {
        finalText = text || event.text;
        finalRawJson = event.rawJson;
        stopReason = event.stopReason;
      }
      if (event.type === 'error') {
        failure = event.message;
        finalRawJson = event.rawJson;
        stopReason = event.stopReason;
      }

      if (event.type === 'tool.start') {
        const ordinal = nextOrdinal++;
        const openedAt = Date.now();
        const id = itemId(opts.turnId, ordinal);
        store.openItem({
          itemId: id,
          turnId: opts.turnId,
          ordinal,
          callId: event.toolCallId,
          kind: 'tool',
          name: event.toolName,
          ...(event.args !== undefined ? { argsJson: safeJson(event.args) } : {}),
          ...(event.rawJson !== undefined ? { rawJson: event.rawJson } : {}),
          startedAt: openedAt,
        });
        toolItems.set(event.toolCallId, {
          itemId: id,
          ordinal,
          startedAt: openedAt,
          name: event.toolName,
        });
        emitTurn({
          type: 'item.start',
          itemId: id,
          ordinal,
          callId: event.toolCallId,
          kind: 'tool',
          name: event.toolName,
          ...(event.args !== undefined ? { args: event.args } : {}),
          ...(event.rawJson !== undefined ? { rawJson: event.rawJson } : {}),
        });
        emitTurn({
          type: 'item.delta',
          itemId: id,
          ordinal,
          callId: event.toolCallId,
          event,
        });
      } else if (event.type === 'tool.result') {
        const open = toolItems.get(event.toolCallId);
        if (open) {
          emitTurn({
            type: 'item.delta',
            itemId: open.itemId,
            ordinal: open.ordinal,
            callId: event.toolCallId,
            event,
          });
          closeTool(event.toolCallId, open, event);
        } else {
          emitTurn({ type: 'item.delta', itemId: agentItemId, ordinal: agentOrdinal, event });
        }
      } else {
        emitTurn({ type: 'item.delta', itemId: agentItemId, ordinal: agentOrdinal, event });
      }
      try {
        opts.onEvent(event);
      } catch {
        /* transport teardown is handled by abortSignal */
      }
    };

    const digest = createHash('sha256').update(conversationId).digest('hex').slice(0, 24);
    const scratchDir = path.join(opts.runnerSessionDir, 'automation-turns', digest);
    await fs.mkdir(scratchDir, { recursive: true });
    const sessionFile = path.join(scratchDir, 'session.jsonl');

    let adapter:
      | {
          adapterSessionId?: string;
          adapterKind?: string;
          adapterUsageSnapshot?: import('@centraid/app-engine').AdapterUsageSnapshot;
        }
      | undefined;
    try {
      const result = await opts.runner.run({
        appId: opts.row.ownerApp,
        dataDir: scratchDir,
        conversationId,
        sessionFile,
        message: opts.message,
        extraSystemPrompt: preamble,
        runnerKind: opts.runnerKind,
        ...(opts.model ? { model: opts.model } : {}),
        permissionPolicy: 'deny',
        abortSignal: opts.abortSignal,
        ...(conversation.adapterSessionId
          ? { prevAdapterSessionId: conversation.adapterSessionId }
          : {}),
        ...(conversation.adapterKind ? { prevAdapterKind: conversation.adapterKind } : {}),
        ...(conversation.adapterUsageSnapshot
          ? { prevAdapterUsageSnapshot: conversation.adapterUsageSnapshot }
          : {}),
        onEvent,
      });
      adapter = result ?? undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!failure) {
        failure = message;
        onEvent({ type: 'error', message });
      }
    }

    if (opts.abortSignal.aborted && !failure) failure = 'Turn aborted.';
    for (const [callId, open] of toolItems) {
      closeTool(callId, open, {
        ok: false,
        errorText: failure ?? 'Tool call ended without a terminal result.',
      });
    }

    const endedAt = Date.now();
    const answer = finalText ?? text;
    const ok = failure === undefined && !opts.abortSignal.aborted;
    const output = {
      ...(answer ? { text: answer } : {}),
      ...(stopReason ? { stopReason } : {}),
    };
    store.closeItem({
      itemId: agentItemId,
      ok,
      ...(Object.keys(output).length > 0 ? { outputJson: safeJson(output) } : {}),
      ...(finalRawJson !== undefined ? { rawJson: finalRawJson } : {}),
      ...(failure !== undefined ? { error: failure } : {}),
      endedAt,
      durationMs: endedAt - startedAt,
      ...usageFields(usage),
    });
    emitTurn({
      type: 'item.end',
      itemId: agentItemId,
      ordinal: agentOrdinal,
      ok,
      ...(Object.keys(output).length > 0 ? { result: output } : {}),
      ...(failure !== undefined ? { error: failure } : {}),
      durationMs: endedAt - startedAt,
      ...(finalRawJson !== undefined ? { rawJson: finalRawJson } : {}),
    });
    store.finishTurn({
      turnId: opts.turnId,
      endedAt,
      ok,
      ...(failure !== undefined ? { error: failure } : {}),
      ...(answer ? { summary: answer.slice(0, 240) } : {}),
      ...(Object.keys(output).length > 0 ? { outputJson: safeJson(output) } : {}),
    });
    store.noteTurn(
      conversationId,
      '',
      adapter?.adapterKind
        ? {
            kind: adapter.adapterKind,
            ...(adapter.adapterSessionId ? { sessionId: adapter.adapterSessionId } : {}),
            ...(adapter.adapterUsageSnapshot
              ? { usageSnapshot: adapter.adapterUsageSnapshot }
              : {}),
          }
        : undefined,
    );
    emitTurn({
      type: 'turn.end',
      turnId: opts.turnId,
      ok,
      ...(failure !== undefined ? { error: failure } : {}),
    });
    return {
      turnId: opts.turnId,
      ok,
      ...(failure !== undefined ? { error: failure } : {}),
    };
  });
}
