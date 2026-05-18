/*
 * Claude Code CLI adapter.
 *
 * Runs `claude` in non-interactive mode with stream-json output, an inline
 * `--mcp-config` pointing at our stdio MCP server, and per-mode permission
 * flags. Parses the SDK stream-json event format and translates entries
 * into `ChatStreamEvent`s.
 *
 * Session continuity uses `--resume <sessionId>` on subsequent turns,
 * with the session id captured from the first turn's `session.init`-style
 * event.
 *
 * Mode flags:
 *   - **full**: nothing added; the user's claude defaults apply.
 *   - **data**: `--permission-mode plan` (planning-only, no edits), plus
 *     `--allowedTools` narrowed to the MCP-prefixed centraid tools.
 *
 * Event mapping (subject to verification — open item in the issue):
 *   { type: 'system', subtype: 'init', session_id }
 *   { type: 'assistant', message: { content: [...] } }    → assistant.delta / tool.start
 *   { type: 'user', message: { content: [{ tool_use_id, content }] } } → tool.result
 *   { type: 'result', ... }                              → final
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChatStreamEvent } from '@centraid/runtime-core';
import { spawnCli } from './spawn-cli.js';
import type { RunOneTurnArgs } from './types.js';

const MCP_SERVER_LABEL = 'centraid';

export interface ClaudeAdapterResult {
  sessionId?: string;
}

export async function runClaudeTurn(
  args: RunOneTurnArgs,
  prevSessionId: string | undefined,
): Promise<ClaudeAdapterResult> {
  const { ctx, input } = args;
  const bin = ctx.prefs.binPath ?? 'claude';

  // Claude Code wants an inline JSON file (or string) for --mcp-config.
  // We materialize a tmp file per turn so the path is durable across the
  // CLI's startup sequence; cleanup happens after exit.
  const mcpConfig = {
    mcpServers: {
      [MCP_SERVER_LABEL]: {
        command: ctx.nodeBin ?? process.execPath,
        args: [
          ctx.mcpServerScript,
          '--apps-dir',
          ctx.appsDir,
          '--app-id',
          input.appId,
          '--mode',
          input.mode,
        ],
      },
    },
  };
  const mcpFile = path.join(tmpdir(), `centraid-mcp-${randomUUID()}.json`);
  await fs.writeFile(mcpFile, JSON.stringify(mcpConfig), { mode: 0o600 });

  const cliArgs = ['-p', input.message, '--output-format', 'stream-json', '--mcp-config', mcpFile];
  if (prevSessionId) cliArgs.push('--resume', prevSessionId);
  if (input.model) cliArgs.push('--model', input.model);
  if (input.extraSystemPrompt) {
    cliArgs.push('--append-system-prompt', input.extraSystemPrompt);
  }
  if (input.mode === 'data') {
    cliArgs.push('--permission-mode', 'plan');
    cliArgs.push(
      '--allowedTools',
      [
        `mcp__${MCP_SERVER_LABEL}__centraid_sql_describe`,
        `mcp__${MCP_SERVER_LABEL}__centraid_sql_read`,
        `mcp__${MCP_SERVER_LABEL}__centraid_sql_write`,
      ].join(','),
    );
  }
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

  try {
    const result = await spawnCli({
      bin,
      args: cliArgs,
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
  } finally {
    await fs.unlink(mcpFile).catch(() => undefined);
  }

  return sessionId ? { sessionId } : {};
}

function translateClaudeLine(
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
