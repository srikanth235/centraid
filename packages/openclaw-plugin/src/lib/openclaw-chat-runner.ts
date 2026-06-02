/*
 * OpenClaw `ChatRunner` implementation.
 *
 * Wraps `api.runtime.agent.runEmbeddedAgent` so the per-app chat endpoint
 * (`POST /centraid/<appId>/_chat`) drives the same in-process embedded
 * agent that powers everything else in the gateway. Centraid does NOT
 * register its own agent identity here:
 *
 *   - `isCanonicalWorkspace: false` plus a plugin-owned `workspaceDir`
 *     gives `bootstrapMode = "limited"` — AGENTS.md / SOUL.md / USER.md
 *     loading is skipped. We don't pretend to be the user's main agent.
 *   - No `agentId` override; OpenClaw falls back to its default (`"main"`)
 *     so model resolution + tool policy follow the user's existing config.
 *
 * Streaming translation maps OpenClaw's callbacks onto `ChatStreamEvent`s:
 *   onAssistantMessageStart → { type: 'assistant.start' }
 *   onBlockReply (text=...)  → { type: 'assistant.delta' }
 *   onReasoningStream        → { type: 'reasoning.delta' }
 *   onToolResult             → { type: 'tool.result' }
 *   onAgentEvent (best-effort) → { type: 'tool.start' | 'phase' }
 *
 * Tool-start events aren't in the public callback surface; we synthesize
 * them from `onAgentEvent` stream entries when we can. The harness handles
 * absent tool-starts gracefully — it just shows a placeholder until the
 * matching `tool.result` lands.
 */

import path from 'node:path';
import os from 'node:os';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import type { ChatRunner, ChatRunInput, ChatStreamEvent } from '@centraid/app-engine';
import { runEmbeddedTurn } from './openclaw-agent-turn.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Construct a `ChatRunner` bound to the OpenClaw plugin api. The runner is
 * stateless — every `run()` call resolves an independent agent run.
 */
export function makeOpenClawChatRunner(api: OpenClawPluginApi): ChatRunner {
  return {
    async run(input: ChatRunInput): Promise<void> {
      const sessionKey = `centraid-chat:${input.appId}:w${input.chatSessionId}`;
      const sessionId = sessionKey;
      const runId = `centraid:${input.appId}:${input.chatSessionId}:${Date.now().toString(36)}`;

      // Plugin-owned scratch dir plus `isCanonicalWorkspace=false` so
      // OpenClaw skips AGENTS.md / SOUL.md / USER.md loading; the user's
      // agent persona still drives tool-policy resolution because agentId
      // is unset (defaults to main).
      const workspaceDir = path.join(os.homedir(), '.openclaw', 'centraid', '_chat-workspace');

      // Synthesize tool.start events from the generic agent-event stream.
      // OpenClaw doesn't expose a typed `onToolStart` callback, so we
      // pattern-match on the most common shapes; everything else falls
      // through as a `phase` event for the harness to log/ignore.
      const pendingByCallId = new Map<string, string>();

      const emit = (event: ChatStreamEvent): void => {
        if (input.abortSignal.aborted) return;
        input.onEvent(event);
      };

      try {
        // `runEmbeddedTurn` applies the centraid defaults `isCanonicalWorkspace:
        // false` (→ bootstrapMode "limited", so AGENTS.md / SOUL.md / USER.md
        // loading is skipped) and `promptMode: 'full'`.
        await runEmbeddedTurn(api, {
          sessionId,
          sessionKey,
          sessionFile: input.sessionFile,
          workspaceDir,
          prompt: input.message,
          extraSystemPrompt: input.extraSystemPrompt,
          ...(input.model ? { model: input.model } : {}),
          ...(input.thinking
            ? { thinkLevel: input.thinking as 'low' | 'medium' | 'high' | 'off' }
            : {}),
          trigger: 'user',
          abortSignal: input.abortSignal,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          runId,

          onAssistantMessageStart: () => {
            emit({ type: 'assistant.start' });
          },
          onBlockReply: (payload) => {
            if (payload.isReasoning) {
              if (payload.text) emit({ type: 'reasoning.delta', delta: payload.text });
              return;
            }
            if (payload.text) emit({ type: 'assistant.delta', delta: payload.text });
          },
          onReasoningStream: (payload) => {
            if (payload.text) emit({ type: 'reasoning.delta', delta: payload.text });
          },
          onToolResult: (payload) => {
            // ReplyPayload carries a tool *result* text. The original tool
            // name isn't in this shape — we surface what we have, the
            // harness handles results without a paired tool.start.
            const isError = payload.isError === true;
            const text = typeof payload.text === 'string' ? payload.text : undefined;
            const callId = `oc-${pendingByCallId.size}`;
            emit({
              type: 'tool.result',
              toolCallId: callId,
              toolName: '',
              ok: !isError,
              result: text ?? payload,
              ...(isError && text ? { errorText: text } : {}),
            });
          },
          onAgentEvent: (evt) => {
            try {
              translateAgentEvent(evt, emit, pendingByCallId);
            } catch {
              // Translation failures are non-fatal — they're just diagnostic
              // pass-throughs.
            }
          },
        });

        // OpenClaw's run resolves with a result blob; we don't surface it
        // separately. The harness already saw the final assistant text via
        // onBlockReply. Emit a `final` marker so the harness can flush.
        emit({ type: 'final', text: '' });
      } catch (err) {
        if (input.abortSignal.aborted) {
          emit({ type: 'aborted' });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        emit({ type: 'error', message });
        throw err;
      }
    },
  };
}

/**
 * Translate one entry from OpenClaw's generic agent-event stream into a
 * `ChatStreamEvent`. We recognize a handful of shapes (tool start) and
 * pass the rest through as `phase` events for the harness's diagnostic UI.
 */
function translateAgentEvent(
  evt: { stream: string; data: Record<string, unknown> },
  emit: (e: ChatStreamEvent) => void,
  pending: Map<string, string>,
): void {
  const stream = evt.stream;
  const data = evt.data ?? {};

  if (stream === 'tool_execution_start' || stream === 'tool_call_start') {
    const toolCallId = String((data.toolCallId ?? data.callId ?? data.id ?? '') || '');
    const toolName = String((data.toolName ?? data.name ?? 'tool') || 'tool');
    const args = (data.args ?? data.params ?? data.arguments) as
      | Record<string, unknown>
      | undefined;
    const sql =
      args && typeof args === 'object' && typeof args.sql === 'string'
        ? (args.sql as string)
        : undefined;
    if (toolCallId) pending.set(toolCallId, toolName);
    emit({
      type: 'tool.start',
      toolCallId: toolCallId || `oc-${pending.size}`,
      toolName,
      args,
      ...(sql ? { sql } : {}),
    });
    return;
  }
  if (stream === 'execution_phase' || stream === 'phase') {
    const phase = String((data.phase ?? data.name ?? 'phase') || 'phase');
    emit({ type: 'phase', phase, detail: data });
    return;
  }
  // Anything else gets surfaced as a generic phase so the harness can show
  // it (or ignore it) without us trying to enumerate every OpenClaw stream.
  emit({ type: 'phase', phase: stream, detail: data });
}
