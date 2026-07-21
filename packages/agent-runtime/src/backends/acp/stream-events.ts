/*
 * Translating ACP `session/update` notifications into the normalized
 * `TurnStreamEvent` shape every surface (chat + builder) consumes.
 *
 * Streaming wire shape (verified against the public ACP spec):
 * `session/update` { sessionId, update: { sessionUpdate, ... } } — variants
 * agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update,
 * plan, user_message_chunk, available_commands_update, current_mode_update,
 * usage_update.
 *
 * The mapper owns the per-turn accumulation that only it can see: the
 * assistant text assembled from chunks, which tool calls are open, and the
 * usage folded off `usage_update`. The orchestrator reads those back at the
 * end of the turn.
 */

import type { TurnStreamEvent } from '@centraid/app-engine';
import { firstString, textOf } from './content.js';
import { readCost, readTokenUsage, type TokenUsage, type UsageCost } from './usage.js';

export interface SessionUpdateMapper {
  /** Feed one `session/update` notification's `params`. */
  handleSessionUpdate: (params: unknown) => void;
  /**
   * Is the agent itself already streaming a tool call by this name?
   *
   * An agent that surfaces its MCP calls announces `tool_call` BEFORE it
   * dials our endpoint, and closes it with `tool_call_update` afterwards —
   * so by the time a vault tool runs, a matching open ACP tool call means
   * the transcript is already covered and our own events would double-render
   * it. Agents that keep MCP calls private leave nothing open, and we emit.
   * The `includes` is deliberate: namespacing agents surface the tool as
   * `mcp__centraid__vault_sql`.
   */
  agentStreamsTool: (toolName: string) => boolean;
  /** Assistant text accumulated across `agent_message_chunk`s. */
  finalText: () => string;
  /** Merge a token breakdown read elsewhere (the `session/prompt` result). */
  foldTokenUsage: (source: Record<string, unknown>) => void;
  /** Everything folded so far, for the single end-of-turn `usage` event. */
  usage: () => { tokens: TokenUsage; cost: UsageCost | undefined };
}

export function createSessionUpdateMapper(
  emit: (event: TurnStreamEvent) => void,
): SessionUpdateMapper {
  let sentAssistantStart = false;
  let finalText = '';
  const toolTitles = new Map<string, string>();
  const toolDone = new Set<string>();
  let usageTokens: TokenUsage = {};
  let usageCost: UsageCost | undefined;

  const ensureStarted = (): void => {
    if (sentAssistantStart) return;
    sentAssistantStart = true;
    emit({ type: 'assistant.start' });
  };

  const agentStreamsTool = (toolName: string): boolean => {
    const needle = toolName.toLowerCase();
    if (!needle) return false;
    for (const [id, title] of toolTitles) {
      if (toolDone.has(id)) continue;
      if (title.toLowerCase().includes(needle)) return true;
    }
    return false;
  };

  const maybeEmitToolResult = (id: string, update: Record<string, unknown>): void => {
    const status = typeof update.status === 'string' ? update.status : undefined;
    if (status !== 'completed' && status !== 'failed') return;
    if (toolDone.has(id)) return;
    toolDone.add(id);
    const ok = status === 'completed';
    const result = update.rawOutput ?? update.content ?? null;
    const errorText = ok ? undefined : textOf(update.content) || 'tool call failed';
    emit({
      type: 'tool.result',
      toolCallId: id,
      toolName: toolTitles.get(id) ?? 'tool',
      ok,
      result,
      ...(errorText ? { errorText } : {}),
    });
  };

  const handleSessionUpdate = (params: unknown): void => {
    const p = params as { update?: Record<string, unknown> } | undefined;
    const update = p?.update;
    if (!update || typeof update !== 'object') return;
    const kind = update.sessionUpdate;

    if (kind === 'agent_message_chunk') {
      const text = textOf(update.content);
      if (text) {
        ensureStarted();
        finalText += text;
        emit({ type: 'assistant.delta', delta: text });
      }
      return;
    }
    if (kind === 'agent_thought_chunk') {
      const text = textOf(update.content);
      if (text) {
        ensureStarted();
        emit({ type: 'reasoning.delta', delta: text });
      }
      return;
    }
    if (kind === 'tool_call') {
      const id = String(update.toolCallId ?? '');
      if (!id) return;
      const title = firstString(update.title, update.kind) ?? 'tool';
      toolTitles.set(id, title);
      ensureStarted();
      emit({
        type: 'tool.start',
        toolCallId: id,
        toolName: title,
        ...(update.rawInput !== undefined ? { args: update.rawInput } : {}),
      });
      maybeEmitToolResult(id, update);
      return;
    }
    if (kind === 'tool_call_update') {
      const id = String(update.toolCallId ?? '');
      if (!id) return;
      maybeEmitToolResult(id, update);
      return;
    }
    if (kind === 'plan') {
      emit({ type: 'phase', phase: 'plan', ...(update.entries ? { detail: update.entries } : {}) });
      return;
    }
    if (kind === 'usage_update') {
      // Per schema, `usage_update` carries context-window used/size plus a
      // cumulative `cost`. Some agents also hang token counts here, so we
      // still merge whatever tokens we can read — the end-of-turn emit wins.
      usageTokens = { ...usageTokens, ...readTokenUsage(update) };
      const cost = readCost(update.cost);
      if (cost) usageCost = cost;
    }
    // user_message_chunk / available_commands_update / current_mode_update:
    // nothing the transcript needs mid-turn.
  };

  return {
    handleSessionUpdate,
    agentStreamsTool,
    finalText: () => finalText,
    foldTokenUsage: (source) => {
      usageTokens = { ...usageTokens, ...readTokenUsage(source) };
    },
    usage: () => ({ tokens: usageTokens, cost: usageCost }),
  };
}
