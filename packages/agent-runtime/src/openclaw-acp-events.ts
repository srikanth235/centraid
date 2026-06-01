/*
 * ACP → `ChatStreamEvent` translation.
 *
 * `openclaw acp` speaks the Agent Client Protocol (ACP): during a
 * `session/prompt` turn it streams `session/update` notifications. This
 * module maps each `SessionUpdate` variant onto the normalized
 * `ChatStreamEvent` shape the chat + builder surfaces consume — the same
 * target the codex (`codex-app-server.ts`) and claude (`claude-sdk.ts`)
 * adapters translate into.
 *
 * Kept pure + free of the subprocess/JSON-RPC machinery (which lives in
 * `openclaw-acp.ts`) so the mapping can be unit-tested against synthetic
 * notifications without spawning a CLI.
 *
 * Mapping:
 *   agent_message_chunk  → assistant.delta (accumulated into final text)
 *   agent_thought_chunk  → reasoning.delta
 *   user_message_chunk   → ignored (the agent echoing our own prompt)
 *   tool_call            → tool.start (+ tool.result if it arrives terminal)
 *   tool_call_update     → tool.result once status is completed / failed
 *   plan                 → phase 'plan'
 *   usage_update         → usage
 *   (everything else)    → ignored
 */

import type { ChatStreamEvent } from '@centraid/app-engine';
import type {
  ContentBlock,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';

/** A terminal ACP tool-call status maps to a centraid `tool.result`. */
function isTerminalStatus(status: string | null | undefined): boolean {
  return status === 'completed' || status === 'failed';
}

/** Pull plain text out of an ACP content block (only `text` carries it). */
function contentText(block: ContentBlock | undefined): string {
  if (block && block.type === 'text' && typeof block.text === 'string') return block.text;
  return '';
}

/** Best-effort human label for a tool call. */
function toolLabel(tc: ToolCall | ToolCallUpdate): string {
  if ('title' in tc && typeof tc.title === 'string' && tc.title) return tc.title;
  if (tc.kind) return String(tc.kind);
  return tc.toolCallId;
}

/** Flatten an ACP tool-call's content blocks into a summary string. */
function summarizeToolContent(tc: ToolCall | ToolCallUpdate): string | undefined {
  if (tc.rawOutput !== undefined) return undefined; // rawOutput wins; reported directly
  const content = tc.content;
  if (!Array.isArray(content) || content.length === 0) return undefined;
  let s = '';
  for (const item of content) {
    if (item && item.type === 'content') s += contentText(item.content);
  }
  return s || undefined;
}

/**
 * Stateful translator for one ACP prompt turn. `onUpdate` returns the
 * `ChatStreamEvent`s a single `session/update` notification produces; the
 * accumulated assistant text is exposed via `finalText` so the driver can
 * emit a closing `final` event when the turn resolves.
 */
export class AcpStreamTranslator {
  private assistantText = '';
  /** Tool-call labels by id, so a later `tool_call_update` can name its result. */
  private readonly toolLabels = new Map<string, string>();

  get finalText(): string {
    return this.assistantText;
  }

  onUpdate(update: SessionUpdate): ChatStreamEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = contentText(update.content);
        if (!text) return [];
        this.assistantText += text;
        return [{ type: 'assistant.delta', delta: text }];
      }
      case 'agent_thought_chunk': {
        const text = contentText(update.content);
        return text ? [{ type: 'reasoning.delta', delta: text }] : [];
      }
      case 'tool_call':
        return this.handleToolCall(update);
      case 'tool_call_update':
        return this.handleToolCallUpdate(update);
      case 'plan':
        return [{ type: 'phase', phase: 'plan', detail: update }];
      case 'usage_update':
        return this.handleUsage(update);
      default:
        // user_message_chunk, available_commands_update, current_mode_update,
        // config_option_update, session_info_update — not surfaced to chat.
        return [];
    }
  }

  private handleToolCall(update: ToolCall & { sessionUpdate: 'tool_call' }): ChatStreamEvent[] {
    const id = update.toolCallId;
    const toolName = toolLabel(update);
    this.toolLabels.set(id, toolName);
    const events: ChatStreamEvent[] = [
      {
        type: 'tool.start',
        toolCallId: id,
        toolName,
        ...(update.rawInput !== undefined ? { args: update.rawInput } : {}),
      },
    ];
    // A tool_call notification may already be terminal (single-shot tools).
    if (isTerminalStatus(update.status)) {
      events.push(this.toolResult(id, toolName, update));
    }
    return events;
  }

  private handleToolCallUpdate(
    update: ToolCallUpdate & { sessionUpdate: 'tool_call_update' },
  ): ChatStreamEvent[] {
    if (!isTerminalStatus(update.status)) return [];
    const id = update.toolCallId;
    const toolName = this.toolLabels.get(id) ?? toolLabel(update);
    return [this.toolResult(id, toolName, update)];
  }

  private toolResult(id: string, toolName: string, tc: ToolCall | ToolCallUpdate): ChatStreamEvent {
    const ok = tc.status !== 'failed';
    const result = tc.rawOutput !== undefined ? tc.rawOutput : summarizeToolContent(tc);
    const errorText = ok ? undefined : (summarizeToolContent(tc) ?? 'tool call failed');
    return {
      type: 'tool.result',
      toolCallId: id,
      toolName,
      ok,
      ...(result !== undefined ? { result } : {}),
      ...(errorText !== undefined ? { errorText } : {}),
    };
  }

  private handleUsage(
    update: SessionUpdate & { sessionUpdate: 'usage_update' },
  ): ChatStreamEvent[] {
    // UsageUpdate carries an optional token breakdown; forward what's present.
    const raw = (update as unknown as { usage?: Record<string, unknown> }).usage;
    if (!raw || typeof raw !== 'object') return [];
    const num = (...keys: string[]): number | undefined => {
      for (const k of keys) {
        const v = raw[k];
        if (typeof v === 'number' && Number.isFinite(v)) return v;
      }
      return undefined;
    };
    const out: Extract<ChatStreamEvent, { type: 'usage' }> = {
      type: 'usage',
      provider: 'openclaw',
    };
    const input = num('inputTokens', 'input_tokens', 'promptTokens');
    const output = num('outputTokens', 'output_tokens', 'completionTokens');
    const cacheRead = num('cacheReadTokens', 'cachedInputTokens', 'cache_read_input_tokens');
    const cacheWrite = num('cacheWriteTokens', 'cacheCreationInputTokens');
    if (input !== undefined) out.inputTokens = input;
    if (output !== undefined) out.outputTokens = output;
    if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
    if (cacheWrite !== undefined) out.cacheWriteTokens = cacheWrite;
    return [out];
  }
}
