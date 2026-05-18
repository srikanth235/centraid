/*
 * Claude Code CLI adapter.
 *
 * Runs `claude -p <prompt> --output-format stream-json --verbose` with
 * the working directory pinned to `<appsDir>/<appId>` and the
 * `centraid` CLI bin on PATH. Claude Code's default sandbox is
 * permission-based (it asks the user before each new tool use) rather
 * than network-blocking, so the direct-CLI pattern works without
 * special flags — same as codex.
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
import type { RunOneTurnArgs } from './types.js';

const CENTRAID_PROMPT_PREAMBLE = `## centraid CLI

You have a "centraid" CLI available for reading and writing this app's data:

  centraid sql describe                      — JSON: tables, columns, indexes, views
  centraid sql read  "SELECT ..."            — JSON: { columns, rows, totalRows, truncated }
  centraid sql write "INSERT/UPDATE/DELETE/REPLACE ..."  — JSON: { rowsAffected, lastInsertRowid }

The CLI operates on ./data.sqlite in the current working directory, which is
already scoped to this app. You do NOT need to pass an appId. DDL
(CREATE/ALTER/DROP) and PRAGMA are refused.

Prefer one focused SELECT over many small ones (use LIMIT). Call
\`centraid sql describe\` first if you don't know the schema yet.`;

export interface ClaudeAdapterResult {
  sessionId?: string;
}

export interface ClaudeAdapterEnv {
  appsDir: string;
  centraidCliDir: string;
}

export async function runClaudeTurn(
  args: RunOneTurnArgs,
  prevSessionId: string | undefined,
  env: ClaudeAdapterEnv,
): Promise<ClaudeAdapterResult> {
  const { ctx, input } = args;
  const bin = ctx.prefs.binPath ?? 'claude';

  const appWorkspace = path.join(env.appsDir, input.appId);
  await fs.mkdir(appWorkspace, { recursive: true });

  const cliArgs = ['-p', input.message, '--output-format', 'stream-json', '--verbose'];
  if (prevSessionId) cliArgs.push('--resume', prevSessionId);
  if (input.model) cliArgs.push('--model', input.model);

  const systemPrompt = input.extraSystemPrompt
    ? `${CENTRAID_PROMPT_PREAMBLE}\n\n${input.extraSystemPrompt}`
    : CENTRAID_PROMPT_PREAMBLE;
  cliArgs.push('--append-system-prompt', systemPrompt);

  if (ctx.prefs.extraArgs && ctx.prefs.extraArgs.length > 0) {
    cliArgs.push(...ctx.prefs.extraArgs);
  }

  let sessionId: string | undefined;
  let sawFinal = false;
  let finalText = '';

  const emit = (event: ChatStreamEvent): void => {
    if (input.abortSignal.aborted) return;
    input.onEvent(event);
  };

  emit({ type: 'assistant.start' });

  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${env.centraidCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
  };

  const result = await spawnCli({
    bin,
    args: cliArgs,
    cwd: appWorkspace,
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
