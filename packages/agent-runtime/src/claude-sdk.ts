/*
 * Claude Agent SDK backend.
 *
 * Drives one agent turn through `@anthropic-ai/claude-agent-sdk`'s
 * `query()` function — in-process, no subprocess we manage. We pass
 * `extraSystemPrompt` via the documented preset+append shape and
 * iterate the async generator, translating each `SDKMessage` into the
 * normalized `ChatStreamEvent` union the rest of the codebase consumes.
 *
 * `includePartialMessages: true` is required for token-level streaming;
 * without it, the SDK only yields complete assistant messages.
 *
 * The SDK reads `ANTHROPIC_API_KEY` from the environment — there is no
 * per-call auth field today. Callers in Electron should ensure the env
 * var is set before this runs; the desktop's auth-import status reports
 * whether it is.
 *
 * Lazy-import: the SDK pulls a sizable subgraph + a vendored claude
 * binary; we avoid that cost when the user has selected codex.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatStreamEvent } from '@centraid/runtime-core';

export interface ClaudeSdkInput {
  cwd: string;
  message: string;
  /** Appended to the `claude_code` preset prompt via `systemPrompt.append`. */
  extraSystemPrompt: string;
  model?: string;
  /** SDK session id from a prior turn; passed as `options.resume`. */
  prevSessionId?: string;
  /**
   * Path-delimited dirs prepended to PATH in the SDK-spawned claude
   * process's env. Used so the agent's Bash tool can invoke the
   * `centraid` CLI by bare name. The SDK accepts `env` on `query`'s
   * options, so we never mutate the host's `process.env`.
   */
  extraPath?: string;
  abortSignal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}

export interface ClaudeSdkConfig {
  /** Override the bundled `claude` binary location. */
  pathToClaudeCodeExecutable?: string;
}

export interface ClaudeSdkResult {
  sessionId?: string;
}

export async function runClaudeSdkTurn(
  input: ClaudeSdkInput,
  config: ClaudeSdkConfig = {},
): Promise<ClaudeSdkResult> {
  await fs.mkdir(input.cwd, { recursive: true });

  const emit = (event: ChatStreamEvent): void => {
    if (input.abortSignal.aborted) return;
    input.onEvent(event);
  };

  emit({ type: 'assistant.start' });

  let mod: typeof import('@anthropic-ai/claude-agent-sdk');
  try {
    mod = await import('@anthropic-ai/claude-agent-sdk');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emit({
      type: 'error',
      message: `failed to load @anthropic-ai/claude-agent-sdk: ${msg}`,
    });
    return {};
  }

  const abortController = new AbortController();
  const onParentAbort = (): void => abortController.abort();
  if (input.abortSignal.aborted) abortController.abort();
  else input.abortSignal.addEventListener('abort', onParentAbort, { once: true });

  let sessionId: string | undefined = input.prevSessionId;
  const translator = makeSdkMessageTranslator(emit, (id) => {
    sessionId = id;
  });

  try {
    const options: Record<string, unknown> = {
      cwd: input.cwd,
      includePartialMessages: true,
      abortController,
    };
    if (input.extraSystemPrompt) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: input.extraSystemPrompt,
      };
    }
    if (input.model) options.model = input.model;
    if (input.prevSessionId) options.resume = input.prevSessionId;
    if (input.extraPath) {
      const current = process.env.PATH ?? '';
      options.env = {
        ...process.env,
        PATH: current ? `${input.extraPath}${path.delimiter}${current}` : input.extraPath,
      };
    }
    if (config.pathToClaudeCodeExecutable) {
      options.pathToClaudeCodeExecutable = config.pathToClaudeCodeExecutable;
    }

    const generator = mod.query({
      prompt: input.message,
      options: options as Parameters<typeof mod.query>[0]['options'],
    });

    for await (const message of generator) {
      translator(message as unknown as Record<string, unknown>);
      if (input.abortSignal.aborted) break;
    }
    translator.flush();
  } catch (err) {
    if (!input.abortSignal.aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ type: 'error', message: msg });
    }
  } finally {
    input.abortSignal.removeEventListener('abort', onParentAbort);
  }

  if (input.abortSignal.aborted) emit({ type: 'aborted' });

  return sessionId ? { sessionId } : {};
}

/**
 * Translate `SDKMessage` events into `ChatStreamEvent`s.
 *
 * The SDK's union is wider than what the renderer consumes; we handle
 * the load-bearing variants (`assistant`, partial assistant, `user`
 * tool_result, `result`, `system` init) and let everything else fall
 * through silently — staying defensive keeps a future SDK update from
 * exploding the chat surface.
 */
function makeSdkMessageTranslator(
  emit: (event: ChatStreamEvent) => void,
  onSessionId: (id: string) => void,
): {
  (msg: Record<string, unknown>): void;
  flush: () => void;
} {
  let sawFinalText = false;
  let finalText = '';
  const seenToolStarts = new Set<string>();

  const fn = (msg: Record<string, unknown>): void => {
    const type = typeof msg.type === 'string' ? msg.type : '';

    if (type === 'system') {
      const sessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined;
      if (sessionId) onSessionId(sessionId);
      return;
    }

    if (type === 'stream_event' || type === 'partial_assistant_message') {
      handlePartialAssistant(msg);
      return;
    }

    if (type === 'assistant') {
      handleAssistantMessage(msg);
      return;
    }

    if (type === 'user') {
      handleUserMessage(msg);
      return;
    }

    if (type === 'result') {
      const text = readResultText(msg);
      if (text) {
        sawFinalText = true;
        finalText = text;
        emit({ type: 'final', text });
      } else if (!sawFinalText && finalText) {
        emit({ type: 'final', text: finalText });
      }
      const sessionId = typeof msg.session_id === 'string' ? msg.session_id : undefined;
      if (sessionId) onSessionId(sessionId);
      return;
    }

    if (type === 'permission_denied') {
      const reason = typeof msg.reason === 'string' ? (msg.reason as string) : 'permission denied';
      emit({ type: 'error', message: reason });
    }
  };

  fn.flush = (): void => {
    if (!sawFinalText && finalText) {
      emit({ type: 'final', text: finalText });
    }
  };

  return fn;

  function handlePartialAssistant(msg: Record<string, unknown>): void {
    const event = msg.event as Record<string, unknown> | undefined;
    if (!event) return;
    const t = typeof event.type === 'string' ? event.type : '';
    if (t === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      const dt = typeof delta?.type === 'string' ? delta.type : '';
      if (dt === 'text_delta' && typeof delta?.text === 'string') {
        finalText += delta.text;
        emit({ type: 'assistant.delta', delta: delta.text });
      } else if (dt === 'thinking_delta' && typeof delta?.thinking === 'string') {
        emit({ type: 'reasoning.delta', delta: delta.thinking });
      }
    }
  }

  function handleAssistantMessage(msg: Record<string, unknown>): void {
    const message = msg.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const bt = typeof b.type === 'string' ? b.type : '';
      if (bt === 'tool_use') {
        const id = typeof b.id === 'string' ? b.id : '';
        if (id && seenToolStarts.has(id)) continue;
        if (id) seenToolStarts.add(id);
        const name = typeof b.name === 'string' ? b.name : 'tool';
        const args = (b.input ?? {}) as Record<string, unknown>;
        emit({
          type: 'tool.start',
          toolCallId: id || `claude-${Date.now()}`,
          toolName: name,
          args,
        });
      } else if (bt === 'text' && typeof b.text === 'string') {
        // Non-streaming complete-text path (happens when
        // includePartialMessages is off OR for the closing snapshot).
        // Only emit if we haven't seen any partial deltas yet to avoid
        // double-emission.
        if (!finalText) {
          finalText = b.text;
          emit({ type: 'assistant.delta', delta: b.text });
        }
      }
    }
  }

  function handleUserMessage(msg: Record<string, unknown>): void {
    const message = msg.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      const bt = typeof b.type === 'string' ? b.type : '';
      if (bt === 'tool_result') {
        const toolCallId = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
        const isError = b.is_error === true;
        const result = b.content;
        emit({
          type: 'tool.result',
          toolCallId,
          toolName: '',
          ok: !isError,
          result,
          ...(isError && typeof result === 'string' ? { errorText: result } : {}),
        });
      }
    }
  }

  function readResultText(msg: Record<string, unknown>): string {
    if (typeof msg.result === 'string') return msg.result;
    if (typeof msg.text === 'string') return msg.text;
    return '';
  }
}
