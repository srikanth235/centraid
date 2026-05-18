/*
 * Claude Code CLI adapter — mode-agnostic primitive.
 *
 * Runs `claude -p <prompt> --output-format stream-json --verbose` with
 * cwd pinned to the caller-supplied workspace and `extraSystemPrompt`
 * passed via `--append-system-prompt`. Caller owns scoping concerns and
 * any preamble teaching claude about host-side CLIs.
 *
 * Empirically captured against Claude Code 2.1.126:
 *   {"type":"system","subtype":"init","session_id":"<uuid>",...}
 *   {"type":"assistant","message":{"content":[{"type":"text",...}, {"type":"tool_use",...}]}, "session_id":"...", "uuid":"..."}
 *   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"...","content":...,"is_error":...}]}}
 *   {"type":"result","subtype":"success","result":"...","session_id":"..."}
 *
 * --output-format stream-json REQUIRES --verbose; otherwise claude
 * errors out at startup.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { ChatStreamEvent } from '@centraid/runtime-core';
import { spawnCli } from './spawn-cli.js';

export interface ClaudeTurnInput {
  cwd: string;
  message: string;
  /** Passed via `--append-system-prompt`. Empty string omits the flag. */
  extraSystemPrompt: string;
  model?: string;
  /** Claude session id from a prior turn; triggers `--resume`. */
  prevSessionId?: string;
  abortSignal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}

export interface ClaudeTurnConfig {
  /** Directory to prepend to PATH so claude can invoke host bins by bare name. */
  hostBinDir?: string;
  /** Override the claude binary; defaults to PATH lookup of `claude`. */
  binPath?: string;
  /** Extra args passed verbatim. */
  extraArgs?: string[];
}

export interface ClaudeTurnResult {
  sessionId?: string;
}

export async function runClaudeTurn(
  input: ClaudeTurnInput,
  config: ClaudeTurnConfig = {},
): Promise<ClaudeTurnResult> {
  const bin = config.binPath ?? 'claude';

  await fs.mkdir(input.cwd, { recursive: true });

  const cliArgs = ['-p', input.message, '--output-format', 'stream-json', '--verbose'];
  if (input.prevSessionId) cliArgs.push('--resume', input.prevSessionId);
  if (input.model) cliArgs.push('--model', input.model);
  if (input.extraSystemPrompt) {
    cliArgs.push('--append-system-prompt', input.extraSystemPrompt);
  }

  if (config.extraArgs && config.extraArgs.length > 0) {
    cliArgs.push(...config.extraArgs);
  }

  let sessionId: string | undefined;
  let sawFinal = false;
  let finalText = '';

  const emit = (event: ChatStreamEvent): void => {
    if (input.abortSignal.aborted) return;
    input.onEvent(event);
  };

  emit({ type: 'assistant.start' });

  const spawnEnv: NodeJS.ProcessEnv = config.hostBinDir
    ? {
        ...process.env,
        PATH: `${config.hostBinDir}${path.delimiter}${process.env.PATH ?? ''}`,
      }
    : { ...process.env };

  const result = await spawnCli({
    bin,
    args: cliArgs,
    cwd: input.cwd,
    env: spawnEnv,
    abortSignal: input.abortSignal,
    onStderrLine: (line) => emit({ type: 'phase', phase: 'stderr', detail: line }),
    onJsonLine: (line) => {
      try {
        translateClaudeLine(
          line,
          emit,
          (id) => {
            sessionId = id;
          },
          (text) => {
            sawFinal = true;
            finalText = text;
          },
        );
      } catch {
        // ignore
      }
    },
  });

  if (input.abortSignal.aborted) {
    emit({ type: 'aborted' });
  } else if (result.exitCode !== 0 && !sawFinal) {
    emit({
      type: 'error',
      message: `claude exited ${result.exitCode ?? 'null'}${
        result.stderrTail ? `\n${result.stderrTail}` : ''
      }`,
    });
  } else if (!sawFinal) {
    emit({ type: 'final', text: finalText });
  }

  return sessionId ? { sessionId } : {};
}

/**
 * Translate one JSON event line from `claude -p --output-format
 * stream-json --verbose` into a `ChatStreamEvent`. Confirmed schema
 * for Claude Code 2.1.126; unknown shapes fall through as `phase`.
 */
export function translateClaudeLine(
  line: Record<string, unknown>,
  emit: (e: ChatStreamEvent) => void,
  onSessionId: (id: string) => void,
  onFinal: (text: string) => void,
): void {
  const type = String(line.type ?? '');

  if (type === 'system') {
    const subtype = String(line.subtype ?? '');
    if (subtype === 'init') {
      const id = typeof line.session_id === 'string' ? line.session_id : undefined;
      if (id) onSessionId(id);
    }
    emit({ type: 'phase', phase: `system.${subtype || 'unknown'}`, detail: line });
    return;
  }

  if (type === 'assistant') {
    const message = line.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const kind = String(it.type ?? '');
      if (kind === 'text' && typeof it.text === 'string') {
        emit({ type: 'assistant.delta', delta: it.text });
      } else if (kind === 'thinking' && typeof it.thinking === 'string') {
        emit({ type: 'reasoning.delta', delta: it.thinking });
      } else if (kind === 'tool_use') {
        const toolCallId = String(it.id ?? '');
        const toolName = String(it.name ?? 'tool');
        const args = (it.input ?? {}) as Record<string, unknown>;
        const sql = typeof args.sql === 'string' ? (args.sql as string) : undefined;
        emit({
          type: 'tool.start',
          toolCallId,
          toolName,
          args,
          ...(sql ? { sql } : {}),
        });
      }
    }
    return;
  }

  if (type === 'user') {
    const message = line.message as { content?: unknown[] } | undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const item of content) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, unknown>;
      const kind = String(it.type ?? '');
      if (kind === 'tool_result') {
        const toolCallId = String(it.tool_use_id ?? '');
        const isError = it.is_error === true;
        const output = it.content;
        emit({
          type: 'tool.result',
          toolCallId,
          toolName: '',
          ok: !isError,
          result: output,
          ...(isError && typeof output === 'string' ? { errorText: output } : {}),
        });
      }
    }
    return;
  }

  if (type === 'result') {
    const text =
      typeof line.result === 'string'
        ? line.result
        : typeof line.text === 'string'
          ? (line.text as string)
          : '';
    onFinal(text);
    emit({ type: 'final', text });
    return;
  }

  if (type === 'error') {
    const message =
      typeof line.message === 'string'
        ? line.message
        : typeof line.error === 'string'
          ? (line.error as string)
          : 'unknown claude error';
    emit({ type: 'error', message });
    return;
  }

  emit({ type: 'phase', phase: type || 'unknown', detail: line });
}
