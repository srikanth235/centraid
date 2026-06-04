// governance: allow-repo-hygiene file-size-limit #190 — multimodal content-block
// wiring (issue #190) tips this cohesive adapter just over the cap.
/*
 * Claude Agent SDK backend.
 *
 * Drives one agent turn through `@anthropic-ai/claude-agent-sdk`'s
 * `query()` function — in-process, no subprocess we manage. We pass
 * `extraSystemPrompt` via the documented preset+append shape and
 * iterate the async generator, translating each `SDKMessage` into the
 * normalized `TurnStreamEvent` union the rest of the codebase consumes.
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
import { type TurnStreamEvent, type TurnAttachment } from '@centraid/app-engine';
import type { ToolContext } from '../../runtime.js';
import type { CapabilityTier } from '../../models/tiers.js';
import { buildUserContent } from '../../multimodal.js';
import { buildCentraidMcpServer } from './host-tools.js';

/**
 * Map a provider-agnostic capability tier to the Claude CLI's built-in model
 * aliases (it resolves these to the latest model in each tier). Any other
 * value — a full model id or the gateway default — passes through unchanged,
 * so concrete ids the caller supplies still work.
 */
const CLAUDE_TIER_ALIAS: Record<CapabilityTier, string> = {
  smart: 'opus',
  balanced: 'sonnet',
  fast: 'haiku',
};

export function resolveClaudeModel(model: string): string {
  return CLAUDE_TIER_ALIAS[model as CapabilityTier] ?? model;
}

export interface ClaudeTurnInput {
  cwd: string;
  message: string;
  /**
   * Attachments on this turn's inbound message (issue #190). When present the
   * prompt is sent as a structured user message with image/document content
   * blocks instead of a bare text string.
   */
  attachments?: TurnAttachment[];
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
  /**
   * When provided, the SDK is configured with an in-process MCP server
   * exposing the three structured centraid tools (`centraid_describe`,
   * `centraid_read`, `centraid_write`) that delegate to the shared
   * app-engine dispatcher. `_sql` lands as a built-in inside the
   * dispatcher.
   */
  toolContext?: ToolContext;
  /**
   * SDK permission mode (`options.permissionMode`). Chat leaves this unset
   * (SDK default). Automation `ctx.agent` passes `'bypassPermissions'` to
   * preserve the non-interactive behavior of the old `claude -p
   * --permission-mode bypassPermissions` spawn — a detached turn must never
   * block on an approval prompt.
   */
  permissionMode?: string;
  abortSignal: AbortSignal;
  onEvent: (event: TurnStreamEvent) => void;
}

export interface ClaudeTurnConfig {
  /** Override the bundled `claude` binary location. */
  pathToClaudeCodeExecutable?: string;
}

export interface ClaudeTurnResult {
  sessionId?: string;
}

export async function runClaudeTurn(
  input: ClaudeTurnInput,
  config: ClaudeTurnConfig = {},
): Promise<ClaudeTurnResult> {
  await fs.mkdir(input.cwd, { recursive: true });

  const emit = (event: TurnStreamEvent): void => {
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
    if (input.model) options.model = resolveClaudeModel(input.model);
    if (input.permissionMode) options.permissionMode = input.permissionMode;
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
    if (input.toolContext) {
      const server = await buildCentraidMcpServer(mod, input.toolContext);
      options.mcpServers = { centraid: server };
    }

    // With attachments, send a structured user message (text + image/document
    // content blocks) as a single-shot async iterable; else a bare text
    // prompt (issue #190).
    const promptArg = input.attachments?.length
      ? (async function* () {
          yield {
            type: 'user' as const,
            message: {
              role: 'user' as const,
              content: buildUserContent(input.message, input.attachments!),
            },
            parent_tool_use_id: null,
            session_id: '',
          };
        })()
      : input.message;

    const generator = mod.query({
      prompt: promptArg as Parameters<typeof mod.query>[0]['prompt'],
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
 * Translate `SDKMessage` events into `TurnStreamEvent`s.
 *
 * The SDK's union is wider than what the renderer consumes; we handle
 * the load-bearing variants (`assistant`, partial assistant, `user`
 * tool_result, `result`, `system` init) and let everything else fall
 * through silently — staying defensive keeps a future SDK update from
 * exploding the chat surface.
 */
function makeSdkMessageTranslator(
  emit: (event: TurnStreamEvent) => void,
  onSessionId: (id: string) => void,
): {
  (msg: Record<string, unknown>): void;
  flush: () => void;
} {
  let sawFinalText = false;
  let finalText = '';
  let lastModel: string | undefined;
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
      const usage = readClaudeUsage(msg.usage);
      if (usage) {
        emit({
          type: 'usage',
          provider: 'anthropic',
          ...(lastModel ? { model: lastModel } : {}),
          ...usage,
        });
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
    if (typeof message?.model === 'string') lastModel = message.model;
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

/**
 * Pull per-turn token usage out of a Claude SDK `result` message's
 * `usage` block. Read defensively — the SDK's usage shape uses
 * snake_case Anthropic field names. Returns `undefined` when absent.
 */
function readClaudeUsage(raw: unknown):
  | {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return undefined;
  };
  const out: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  } = {};
  const input = num('input_tokens', 'inputTokens');
  const output = num('output_tokens', 'outputTokens');
  const cacheRead = num('cache_read_input_tokens', 'cacheReadInputTokens');
  const cacheWrite = num('cache_creation_input_tokens', 'cacheCreationInputTokens');
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) out.cacheWriteTokens = cacheWrite;
  return Object.keys(out).length > 0 ? out : undefined;
}
