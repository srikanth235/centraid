/*
 * Codex CLI adapter.
 *
 * Empirically verified against `codex-cli 0.128.0`. The event schema is
 * pinned in `MIN_CODEX_VERSION` (see preflight.ts).
 *
 * Tooling: instead of an MCP server, we teach codex about a small local
 * `centraid` CLI bin (shipped by this package) that codex invokes via
 * its normal shell tool. The CLI operates on `./data.sqlite` (cwd =
 * appId data dir), so we spawn codex with `-C <appsDir>/<id>` to pin
 * the workspace. AppId is the cwd; the model can't escape the scope.
 *
 * Mode handling: codex always runs `--sandbox workspace-write`. The
 * "data mode" toggle is a no-op for codex — codex's sandbox model
 * doesn't support a clean read-only-with-loopback-writes regime, so we
 * don't pretend to enforce one. OpenClaw's data mode (which DOES
 * intersect tool allowlists) remains the place to get strict lockdown.
 *
 * Verified codex CLI shape (0.128.0):
 *   - `codex exec --json [--sandbox …] [-C <cwd>] [-m <model>] <prompt>`
 *   - `codex exec resume --json <SESSION_ID> [-m <model>] <prompt>`
 *     (sandbox/approval/cwd are inherited from the initial session)
 *   - `--skip-git-repo-check` lets us run inside non-git workspaces.
 *   - No `--system-prompt` / `--allowed-tools` / `--session` flag —
 *     extra system context is prepended to the user message.
 *
 * Verified event schema:
 *   {"type":"thread.started","thread_id":"<uuid>"}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_N","type":"<kind>",…}}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *   {"type":"item.completed","item":{"type":"command_execution",
 *      "command":"…","aggregated_output":"…","exit_code":N,"status":"completed"|"failed"}}
 *   {"type":"turn.completed","usage":{…}}
 *   {"type":"turn.failed","error":{…}}        (best-effort)
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { ChatStreamEvent } from '@centraid/runtime-core';
import { spawnCli } from './spawn-cli.js';
import type { RunOneTurnArgs } from './types.js';

export interface CodexAdapterResult {
  threadId?: string;
}

export interface CodexAdapterEnv {
  /**
   * Directory containing the per-app SQLite files
   * (`<appsDir>/<appId>/data.sqlite`). Codex is launched with cwd pinned
   * to `<appsDir>/<appId>` so the centraid CLI sees `./data.sqlite`.
   */
  appsDir: string;
  /**
   * Directory the `centraid` CLI is installed in. Prepended to PATH so
   * codex can invoke it without an absolute path. Defaults to the
   * sibling `dist/` of the calling module.
   */
  centraidCliDir: string;
}

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

export async function runCodexTurn(
  args: RunOneTurnArgs,
  prevThreadId: string | undefined,
  env: CodexAdapterEnv,
): Promise<CodexAdapterResult> {
  const { ctx, input } = args;
  const bin = ctx.prefs.binPath ?? 'codex';

  const appWorkspace = path.join(env.appsDir, input.appId);
  await fs.mkdir(appWorkspace, { recursive: true });

  // Splice extraSystemPrompt (built by runtime-core) plus the CLI
  // preamble into the user message — codex has no --system-prompt flag.
  const prompt = [
    CENTRAID_PROMPT_PREAMBLE,
    '',
    input.extraSystemPrompt || '',
    '',
    '---',
    '',
    input.message,
  ].join('\n');

  // Resume requires the subcommand form; sandbox/cwd/approval are
  // inherited from the initial exec and cannot be re-set on resume.
  let cliArgs: string[];
  if (prevThreadId) {
    cliArgs = ['exec', 'resume', '--json', '--skip-git-repo-check'];
    if (input.model) cliArgs.push('--model', input.model);
    if (ctx.prefs.extraArgs?.length) cliArgs.push(...ctx.prefs.extraArgs);
    cliArgs.push(prevThreadId, prompt);
  } else {
    cliArgs = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-C',
      appWorkspace,
      '--sandbox',
      'workspace-write',
    ];
    if (input.model) cliArgs.push('--model', input.model);
    if (ctx.prefs.extraArgs?.length) cliArgs.push(...ctx.prefs.extraArgs);
    cliArgs.push(prompt);
  }

  let threadId: string | undefined;
  let sawFinal = false;
  let finalText = '';
  const seenStarts = new Set<string>();

  const emit = (event: ChatStreamEvent): void => {
    if (input.abortSignal.aborted) return;
    input.onEvent(event);
  };

  emit({ type: 'assistant.start' });

  // Prepend the centraid CLI dir to PATH so codex can shell out to
  // `centraid` by bare name. We don't mutate the original env object.
  const spawnEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${env.centraidCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
  };

  const result = await spawnCli({
    bin,
    args: cliArgs,
    env: spawnEnv,
    // Codex reads "additional input" from stdin even when the prompt is
    // positional. Close stdin immediately so it doesn't block.
    stdin: '',
    abortSignal: input.abortSignal,
    onStderrLine: (line) => emit({ type: 'phase', phase: 'stderr', detail: line }),
    onJsonLine: (line) => {
      try {
        translateCodexLine(
          line,
          emit,
          seenStarts,
          (id) => {
            threadId = id;
          },
          (text) => {
            sawFinal = true;
            finalText = text;
          },
        );
      } catch {
        // Translation errors are non-fatal.
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
 * Translate one JSON event line from `codex exec --json` into a
 * `ChatStreamEvent`. Schema confirmed against codex-cli 0.128.0;
 * unknown lines fall through as generic `phase` events so a small
 * upgrade doesn't break the adapter.
 */
export function translateCodexLine(
  line: Record<string, unknown>,
  emit: (e: ChatStreamEvent) => void,
  seenStarts: Set<string>,
  onThreadId: (id: string) => void,
  onFinal: (text: string) => void,
): void {
  const type = String(line.type ?? '');

  if (type === 'thread.started') {
    const id = typeof line.thread_id === 'string' ? line.thread_id : undefined;
    if (id) onThreadId(id);
    return;
  }

  if (type === 'turn.started') {
    emit({ type: 'phase', phase: 'turn.started' });
    return;
  }

  if (type === 'item.started') {
    const item = (line.item ?? {}) as Record<string, unknown>;
    const id = String(item.id ?? '');
    const itemType = String(item.type ?? '');
    if (itemType === 'agent_message' || itemType === 'reasoning') {
      // We surface text only on `item.completed`. Skip the start marker
      // so the consumer doesn't see two events for the same item.
      return;
    }
    if (!id || seenStarts.has(id)) return;
    seenStarts.add(id);
    const toolName = describeToolName(itemType, item);
    const args = extractToolArgs(item);
    const sql = typeof args?.sql === 'string' ? (args.sql as string) : undefined;
    emit({
      type: 'tool.start',
      toolCallId: id,
      toolName,
      args,
      ...(sql ? { sql } : {}),
    });
    return;
  }

  if (type === 'item.completed') {
    const item = (line.item ?? {}) as Record<string, unknown>;
    const id = String(item.id ?? '');
    const itemType = String(item.type ?? '');

    if (itemType === 'agent_message') {
      const text = typeof item.text === 'string' ? (item.text as string) : '';
      if (text) emit({ type: 'assistant.delta', delta: text });
      onFinal(text);
      emit({ type: 'final', text });
      return;
    }
    if (itemType === 'reasoning') {
      const text = typeof item.text === 'string' ? (item.text as string) : '';
      if (text) emit({ type: 'reasoning.delta', delta: text });
      return;
    }
    // Tool/command result item — emit synthetic start when we missed it,
    // then emit tool.result.
    if (!seenStarts.has(id)) {
      seenStarts.add(id);
      emit({
        type: 'tool.start',
        toolCallId: id || `codex-${seenStarts.size}`,
        toolName: describeToolName(itemType, item),
        args: extractToolArgs(item),
      });
    }
    const ok = decideToolOk(item);
    const errorText = ok ? undefined : extractToolErrorText(item);
    emit({
      type: 'tool.result',
      toolCallId: id || `codex-${seenStarts.size}`,
      toolName: describeToolName(itemType, item),
      ok,
      result: summarizeToolResult(item),
      ...(errorText ? { errorText } : {}),
    });
    return;
  }

  if (type === 'turn.completed') {
    emit({ type: 'phase', phase: 'turn.completed', detail: line.usage ?? null });
    return;
  }

  if (type === 'turn.failed' || type === 'error') {
    const err = line.error as { message?: unknown } | undefined;
    const message =
      typeof err?.message === 'string'
        ? err.message
        : typeof line.message === 'string'
          ? (line.message as string)
          : 'codex turn failed';
    emit({ type: 'error', message });
    return;
  }

  emit({ type: 'phase', phase: type || 'unknown', detail: line });
}

function describeToolName(itemType: string, item: Record<string, unknown>): string {
  if (itemType === 'command_execution') {
    const cmd = typeof item.command === 'string' ? (item.command as string) : 'shell';
    return `exec(${cmd.slice(0, 40)}${cmd.length > 40 ? '…' : ''})`;
  }
  return itemType || 'tool';
}

function extractToolArgs(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const args = item.args ?? item.arguments ?? item.params ?? item.input;
  if (args && typeof args === 'object') return args as Record<string, unknown>;
  return undefined;
}

function decideToolOk(item: Record<string, unknown>): boolean {
  const status = typeof item.status === 'string' ? (item.status as string) : undefined;
  if (status === 'failed') return false;
  if (typeof item.exit_code === 'number' && (item.exit_code as number) !== 0) return false;
  if (item.is_error === true) return false;
  return true;
}

function extractToolErrorText(item: Record<string, unknown>): string | undefined {
  if (typeof item.error === 'string') return item.error as string;
  if (typeof item.aggregated_output === 'string') return item.aggregated_output as string;
  return undefined;
}

function summarizeToolResult(item: Record<string, unknown>): unknown {
  if (item.result !== undefined) return item.result;
  if (item.aggregated_output !== undefined) {
    return { aggregated_output: item.aggregated_output, exit_code: item.exit_code };
  }
  return null;
}
