/*
 * Codex CLI adapter.
 *
 * Runs `codex exec` in JSON mode with our stdio MCP server attached, parses
 * the structured event stream, and translates lines into `ChatStreamEvent`s.
 *
 * Session continuity:
 *   - First turn in a window: no `--session`, codex assigns a thread id we
 *     persist via `ChatStore.noteTurn(..., adapterSessionId)` from the
 *     `local-chat-runner` dispatcher.
 *   - Subsequent turns: `--session <id>` to resume.
 *
 * Mode flags:
 *   - **full** (default): nothing added. The user's codex defaults apply.
 *   - **data**: `--ask-for-approval never --sandbox read-only` plus the
 *     MCP-only allowlist. Locks codex to centraid_sql_* tools.
 *
 * Event mapping (subject to verification — open item in the issue):
 *   { type: 'item.assistant_delta', delta }          → assistant.delta
 *   { type: 'item.reasoning_delta', delta }          → reasoning.delta
 *   { type: 'item.tool_call', id, name, arguments }  → tool.start
 *   { type: 'item.tool_result', id, name, output }   → tool.result
 *   { type: 'thread.assigned', threadId }            → captured for resume
 *   { type: 'turn.end' / 'item.final' }              → final
 *
 * The harness tolerates unknown event shapes; if codex's stream evolves
 * we'll see `phase` events instead of typed ones until we add a mapping.
 */

import type { ChatStreamEvent } from '@centraid/runtime-core';
import { spawnCli } from './spawn-cli.js';
import type { RunOneTurnArgs } from './types.js';

const MCP_SERVER_LABEL = 'centraid';

export interface CodexAdapterResult {
  /** Codex thread id assigned this turn (or carried over). Undefined when
   *  we never saw a thread-id event — caller skips persisting. */
  threadId?: string;
}

export async function runCodexTurn(
  args: RunOneTurnArgs,
  prevThreadId: string | undefined,
): Promise<CodexAdapterResult> {
  const { ctx, input } = args;
  const bin = ctx.prefs.binPath ?? 'codex';

  // Build the MCP-server spawn argument that we hand to codex via CLI flag.
  // Codex executes this verbatim and pipes stdin/stdout to the spawned
  // process. AppId is baked in — the model cannot redirect it through tool
  // params because the MCP server doesn't accept an appId parameter.
  const mcpCmd = [
    ctx.nodeBin ?? process.execPath,
    ctx.mcpServerScript,
    '--apps-dir',
    ctx.appsDir,
    '--app-id',
    input.appId,
    '--mode',
    input.mode,
  ].join(' ');

  const cliArgs = ['exec', '--json'];
  if (prevThreadId) cliArgs.push('--session', prevThreadId);
  cliArgs.push('--mcp-server', `${MCP_SERVER_LABEL}=${mcpCmd}`);
  if (input.model) cliArgs.push('--model', input.model);
  if (input.mode === 'data') {
    cliArgs.push('--ask-for-approval', 'never', '--sandbox', 'read-only');
    cliArgs.push(
      '--allowed-tools',
      [
        `mcp__${MCP_SERVER_LABEL}__centraid_sql_describe`,
        `mcp__${MCP_SERVER_LABEL}__centraid_sql_read`,
        `mcp__${MCP_SERVER_LABEL}__centraid_sql_write`,
      ].join(','),
    );
  }
  if (input.extraSystemPrompt) {
    cliArgs.push('--system-prompt', input.extraSystemPrompt);
  }
  if (ctx.prefs.extraArgs && ctx.prefs.extraArgs.length > 0) {
    cliArgs.push(...ctx.prefs.extraArgs);
  }
  // The prompt is the trailing positional argument.
  cliArgs.push(input.message);

  let threadId: string | undefined;
  let sawFinal = false;
  let finalText = '';

  const emit = (event: ChatStreamEvent): void => {
    if (input.abortSignal.aborted) return;
    input.onEvent(event);
  };

  emit({ type: 'assistant.start' });

  const result = await spawnCli({
    bin,
    args: cliArgs,
    abortSignal: input.abortSignal,
    onStderrLine: (line) => emit({ type: 'phase', phase: 'stderr', detail: line }),
    onJsonLine: (line) => {
      try {
        translateCodexLine(
          line,
          emit,
          (id) => {
            threadId = id;
          },
          (text) => {
            sawFinal = true;
            finalText = text;
          },
        );
      } catch {
        // ignore translation errors
      }
    },
  });

  if (input.abortSignal.aborted) {
    emit({ type: 'aborted' });
  } else if (result.exitCode !== 0 && !sawFinal) {
    emit({
      type: 'error',
      message: `codex exec exited ${result.exitCode ?? 'null'}${
        result.stderrTail ? `\n${result.stderrTail}` : ''
      }`,
    });
  } else if (!sawFinal) {
    emit({ type: 'final', text: finalText });
  }

  return threadId ? { threadId } : {};
}

/**
 * Best-effort translation of one JSON line from `codex exec --json` into
 * a `ChatStreamEvent`. We accept several near-equivalent event names so
 * the adapter survives small schema drifts; unknown lines fall through as
 * `phase` events.
 */
function translateCodexLine(
  line: Record<string, unknown>,
  emit: (e: ChatStreamEvent) => void,
  onThreadId: (id: string) => void,
  onFinal: (text: string) => void,
): void {
  const type = String(line.type ?? line.event ?? '');

  // Thread id capture — codex emits this on the first turn of a new session.
  if (line.threadId && typeof line.threadId === 'string') onThreadId(line.threadId);
  if (line.thread_id && typeof line.thread_id === 'string') onThreadId(line.thread_id);
  if (type === 'thread.assigned' || type === 'session.created') {
    const id =
      typeof line.threadId === 'string'
        ? line.threadId
        : typeof line.sessionId === 'string'
          ? line.sessionId
          : undefined;
    if (id) onThreadId(id);
    return;
  }

  // Assistant text deltas (multiple shapes).
  if (type === 'item.assistant_delta' || type === 'assistant.delta' || type === 'text.delta') {
    const delta = String(line.delta ?? line.text ?? '');
    if (delta) emit({ type: 'assistant.delta', delta });
    return;
  }
  if (type === 'item.reasoning_delta' || type === 'reasoning.delta') {
    const delta = String(line.delta ?? line.text ?? '');
    if (delta) emit({ type: 'reasoning.delta', delta });
    return;
  }
  if (type === 'item.tool_call' || type === 'tool.start' || type === 'tool_call.start') {
    const toolCallId = String(line.id ?? line.callId ?? '');
    const toolName = String(line.name ?? line.toolName ?? 'tool');
    const args = (line.arguments ?? line.args ?? line.params) as
      | Record<string, unknown>
      | undefined;
    const sql =
      args && typeof args === 'object' && typeof args.sql === 'string'
        ? (args.sql as string)
        : undefined;
    emit({
      type: 'tool.start',
      toolCallId,
      toolName,
      args,
      ...(sql ? { sql } : {}),
    });
    return;
  }
  if (type === 'item.tool_result' || type === 'tool.result' || type === 'tool_call.end') {
    const toolCallId = String(line.id ?? line.callId ?? '');
    const toolName = String(line.name ?? line.toolName ?? 'tool');
    const ok = line.isError !== true && line.is_error !== true;
    const output = line.output ?? line.result ?? line.content;
    const errorText = ok
      ? undefined
      : typeof line.error === 'string'
        ? (line.error as string)
        : typeof line.errorText === 'string'
          ? (line.errorText as string)
          : undefined;
    emit({
      type: 'tool.result',
      toolCallId,
      toolName,
      ok,
      result: output,
      ...(errorText ? { errorText } : {}),
    });
    return;
  }
  if (type === 'item.final' || type === 'turn.end' || type === 'message.completed') {
    const text =
      typeof line.text === 'string'
        ? line.text
        : typeof line.content === 'string'
          ? (line.content as string)
          : '';
    onFinal(text);
    emit({ type: 'final', text });
    return;
  }
  if (type === 'error' || type === 'turn.error') {
    const message =
      typeof line.message === 'string'
        ? line.message
        : typeof line.error === 'string'
          ? line.error
          : 'unknown codex error';
    emit({ type: 'error', message });
    return;
  }
  emit({ type: 'phase', phase: type || 'unknown', detail: line });
}
