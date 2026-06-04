// governance: allow-repo-hygiene file-size-limit codex-jsonrpc-adapter pending split codex-event-translator helpers (describeStartedTool, extractArgs, readAgentMessageText, extractErrorText, summarizeToolResult) into a sibling module
/*
 * Codex app-server backend.
 *
 * Spawns `codex app-server` and drives one agent turn over JSON-RPC 2.0
 * on stdio. The handshake is `initialize` (with `experimentalApi: true`)
 * → `initialized` notification → `thread/start` (or `thread/resume`) →
 * `turn/start`. We translate server notifications into the normalized
 * `TurnStreamEvent` shape both surfaces (chat + builder) consume.
 *
 * Why app-server and not `codex exec`: app-server gives us token deltas
 * (`item/agentMessage/delta`), structured tool-call lifecycle, and a
 * stable thread/resume mechanism. The cost is the JSON-RPC protocol —
 * which is why this file exists.
 *
 * Config: per-invocation config (cwd, developerInstructions, sandbox,
 * approvalPolicy, model) is passed directly inside `thread/start` params
 * — it's inherently per-turn, so the RPC is the natural home for it.
 *
 * Auth: codex reads `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`).
 * The user is expected to run `codex login` once before this runs. Centraid
 * never touches that file — it's codex's own business how it authenticates.
 *
 * Sandbox: we pin `sandbox: 'workspace-write'` and `approvalPolicy: 'never'`
 * so the agent can write files inside `cwd` without prompting. The
 * caller already scopes `cwd` to a per-app dir. Enum strings
 * are kebab-case per codex's `SandboxMode` serde definition — camelCase
 * (e.g. `workspaceWrite`) is rejected at `thread/start` with
 * `unknown variant`.
 *
 * Schema reference: `codex-rs/app-server-protocol/src/protocol/v2/{thread,turn,item,notification}.rs`.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { TurnStreamEvent, TurnAttachment } from '@centraid/app-engine';
import type { ToolContext } from '../runtime.js';
import { centraidDynamicToolSpecs, handleCentraidToolCall } from './codex-centraid-tools.js';
import { codexImageItems } from '../multimodal.js';

export interface CodexAppServerInput {
  cwd: string;
  message: string;
  /** Image attachments on the inbound message — sent as `localImage` input
   *  items so codex reads them itself (issue #190). PDFs aren't supported. */
  attachments?: TurnAttachment[];
  /**
   * Spliced as `developerInstructions` on `thread/start`. Scope is the
   * thread, not per-turn — but since we spawn one thread per turn in
   * v0, that's equivalent.
   */
  extraSystemPrompt: string;
  model?: string;
  /** Codex thread id from a prior turn; triggers `thread/resume` instead of `thread/start`. */
  prevThreadId?: string;
  /**
   * Path-delimited list of directories prepended to PATH in the spawned
   * codex process's env. Used so the agent's shell tool can invoke the
   * `centraid` CLI by bare name. Set per-spawn instead of mutating the
   * host's `process.env` (which would race between concurrent turns).
   */
  extraPath?: string;
  /**
   * When provided, codex receives `dynamicTools: [...]` on `thread/start`
   * declaring three first-class tools — `centraid_sql_describe`,
   * `centraid_sql_read`, `centraid_sql_write` — and we dispatch the
   * resulting `item/tool/call` server requests in-process against the
   * supplied `dataFile`. Writes fire `emitChange` precisely.
   */
  toolContext?: ToolContext;
  abortSignal: AbortSignal;
  onEvent: (event: TurnStreamEvent) => void;
}

export interface CodexAppServerConfig {
  /** Override the codex binary; defaults to PATH lookup of `codex`. */
  binPath?: string;
  /** Extra args passed to `codex app-server` (rare). */
  extraArgs?: string[];
}

export interface CodexAppServerResult {
  threadId?: string;
}

interface PendingResponse {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

interface RpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export async function runCodexAppServerTurn(
  input: CodexAppServerInput,
  config: CodexAppServerConfig = {},
): Promise<CodexAppServerResult> {
  const bin = config.binPath ?? 'codex';
  await fs.mkdir(input.cwd, { recursive: true });

  const args = ['app-server', ...(config.extraArgs ?? [])];
  const childEnv = buildSpawnEnv(input.extraPath ? { extraPath: input.extraPath } : {});
  const child = spawn(bin, args, {
    cwd: input.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  let nextId = 0;
  const pending = new Map<number, PendingResponse>();
  const messageListeners = new Set<(msg: RpcMessage) => void>();
  let buffer = '';
  let stderrBuf = '';
  let threadId: string | undefined = input.prevThreadId;
  let sawFinal = false;
  let finalText = '';
  let processExited = false;
  let exitError: Error | undefined;

  const emit = (event: TurnStreamEvent): void => {
    if (input.abortSignal.aborted) return;
    input.onEvent(event);
  };

  const send = (msg: object): void => {
    if (!child.stdin.writable) return;
    child.stdin.write(JSON.stringify(msg) + '\n');
  };

  const request = <T = unknown>(method: string, params: unknown): Promise<T> => {
    const id = nextId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      send({ jsonrpc: '2.0', id, method, params });
    });
  };

  const notify = (method: string, params: unknown): void => {
    send({ jsonrpc: '2.0', method, params });
  };

  const handleMessage = (msg: RpcMessage): void => {
    for (const listener of messageListeners) {
      try {
        listener(msg);
      } catch {
        // listener errors must not break the dispatch loop
      }
    }

    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`codex rpc ${msg.id}: ${msg.error.message}`));
      else p.resolve(msg.result);
      return;
    }

    if (typeof msg.id === 'number' && msg.method) {
      handleServerRequest(msg.id, msg.method, msg.params);
      return;
    }

    if (msg.method) {
      handleNotification(msg.method, msg.params);
    }
  };

  const handleServerRequest = (id: number, method: string, params: unknown): void => {
    // The only server→client requests we expect under approvalPolicy:'never'
    // are still-possible approval prompts (e.g. fileChange/requestApproval
    // when grantRoot is needed). Auto-accept so the turn doesn't stall.
    if (method.endsWith('/requestApproval')) {
      send({ jsonrpc: '2.0', id, result: { decision: 'accept' } });
      return;
    }
    if (method === 'item/tool/call' && input.toolContext) {
      // Dispatcher calls are async (manifest IO, SQLite); fire-and-await
      // off the synchronous event handler so the RPC loop stays responsive.
      void (async () => {
        try {
          const outcome = await handleCentraidToolCall(id, params, input.toolContext!);
          send(outcome.response);
          for (const ev of outcome.events) emit(ev);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          send({
            jsonrpc: '2.0',
            id,
            result: { success: false, contentItems: [{ type: 'inputText', text: msg }] },
          });
        }
      })();
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    });
    void params;
  };

  const handleNotification = (method: string, params: unknown): void => {
    const p = params as Record<string, unknown> | undefined;
    if (!p) return;

    if (method === 'thread/started') {
      const thread = p.thread as { id?: string } | undefined;
      if (thread?.id) threadId = thread.id;
      return;
    }

    if (method === 'turn/started') {
      emit({ type: 'phase', phase: 'turn.started' });
      return;
    }

    if (method === 'item/agentMessage/delta') {
      const text = typeof p.text === 'string' ? p.text : '';
      if (text) emit({ type: 'assistant.delta', delta: text });
      return;
    }

    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      const text = typeof p.text === 'string' ? p.text : '';
      if (text) emit({ type: 'reasoning.delta', delta: text });
      return;
    }

    if (method === 'item/started') {
      const item = (p.item ?? {}) as Record<string, unknown>;
      const type = String(item.type ?? '');
      const id = String(item.id ?? '');
      if (
        type === 'agentMessage' ||
        type === 'reasoning' ||
        type === 'userMessage' ||
        type === 'dynamicToolCall'
      )
        return;
      const toolName = describeStartedTool(type, item);
      emit({
        type: 'tool.start',
        toolCallId: id || `codex-${Date.now()}`,
        toolName,
        args: extractArgs(item),
      });
      return;
    }

    if (method === 'item/completed') {
      const item = (p.item ?? {}) as Record<string, unknown>;
      const type = String(item.type ?? '');
      const id = String(item.id ?? '');

      if (type === 'agentMessage') {
        const text = readAgentMessageText(item);
        if (text) {
          sawFinal = true;
          finalText = text;
          emit({ type: 'final', text });
        }
        return;
      }
      if (type === 'reasoning' || type === 'userMessage' || type === 'dynamicToolCall') return;

      const status = typeof item.status === 'string' ? (item.status as string) : 'completed';
      const ok = status === 'completed';
      const errorText = ok ? undefined : extractErrorText(item);
      emit({
        type: 'tool.result',
        toolCallId: id || `codex-${Date.now()}`,
        toolName: describeStartedTool(type, item),
        ok,
        result: summarizeToolResult(item),
        ...(errorText ? { errorText } : {}),
      });
      return;
    }

    if (method === 'turn/completed') {
      const turn = (p.turn ?? {}) as Record<string, unknown>;
      const status = typeof turn.status === 'string' ? (turn.status as string) : 'completed';
      if (status === 'failed' || status === 'interrupted') {
        const err = (turn.error as { message?: string } | undefined)?.message ?? `turn ${status}`;
        emit({ type: 'error', message: err });
      } else if (!sawFinal) {
        emit({ type: 'final', text: finalText });
      }
      const usage = readCodexUsage(turn);
      if (usage) {
        emit({
          type: 'usage',
          provider: 'codex',
          ...(input.model ? { model: input.model } : {}),
          ...usage,
        });
      }
      emit({ type: 'phase', phase: 'turn.completed' });
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line && line.startsWith('{')) {
        try {
          handleMessage(JSON.parse(line) as RpcMessage);
        } catch {
          // unparseable line — skip
        }
      }
      nl = buffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-64 * 1024);
  });

  const exitPromise = new Promise<void>((resolve) => {
    child.on('error', (err) => {
      exitError = err;
      processExited = true;
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      resolve();
    });
    child.on('exit', () => {
      processExited = true;
      const err = new Error('codex app-server exited');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      resolve();
    });
  });

  const abortHandler = (): void => {
    if (threadId && !processExited) {
      try {
        notify('turn/interrupt', { threadId });
      } catch {
        // ignore — we kill the process below
      }
    }
    if (!child.killed) child.kill('SIGTERM');
  };
  if (input.abortSignal.aborted) abortHandler();
  else input.abortSignal.addEventListener('abort', abortHandler, { once: true });

  emit({ type: 'assistant.start' });

  try {
    await request('initialize', {
      clientInfo: { name: 'centraid-local-runner', title: 'Centraid', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    notify('initialized', {});

    if (input.prevThreadId) {
      await request('thread/resume', {
        threadId: input.prevThreadId,
        ...(input.model ? { model: input.model } : {}),
        cwd: input.cwd,
      });
    } else {
      const startResult = (await request('thread/start', {
        ...(input.model ? { model: input.model } : {}),
        cwd: input.cwd,
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        ...(input.extraSystemPrompt ? { developerInstructions: input.extraSystemPrompt } : {}),
        ...(input.toolContext ? { dynamicTools: centraidDynamicToolSpecs() } : {}),
      })) as { thread?: { id?: string } } | undefined;
      if (startResult?.thread?.id) threadId = startResult.thread.id;
    }

    if (!threadId) {
      throw new Error('codex app-server did not return a thread id');
    }

    const completion = waitForTurnCompleted(input.abortSignal);

    await request('turn/start', {
      threadId,
      input: [
        { type: 'text', text: input.message },
        ...(input.attachments?.length ? codexImageItems(input.attachments) : []),
      ],
    });

    await completion;
  } catch (err) {
    if (!input.abortSignal.aborted) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({
        type: 'error',
        message: `${msg}${stderrBuf ? `\n${stderrBuf.trim().slice(-2000)}` : ''}`,
      });
    }
  } finally {
    if (!child.killed) {
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      child.kill('SIGTERM');
    }
    await exitPromise;
    input.abortSignal.removeEventListener('abort', abortHandler);
  }

  if (input.abortSignal.aborted) emit({ type: 'aborted' });
  if (exitError && !input.abortSignal.aborted) {
    emit({ type: 'error', message: exitError.message });
  }

  return threadId ? { threadId } : {};

  function waitForTurnCompleted(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        messageListeners.delete(listener);
        resolve();
      };
      const listener = (msg: RpcMessage): void => {
        if (msg.method === 'turn/completed' || msg.method === 'turn/failed') {
          finish();
        }
      };
      messageListeners.add(listener);
      child.once('exit', finish);
      signal.addEventListener('abort', finish, { once: true });
    });
  }
}

/**
 * Pull per-turn token usage out of a codex `turn/completed` payload.
 * The usage object lives at `turn.usage` and varies slightly across
 * codex versions, so every field is read defensively under several
 * candidate names. Returns `undefined` when no usage is present.
 */
function readCodexUsage(turn: Record<string, unknown>):
  | {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | undefined {
  const raw = (turn.usage ?? turn.token_usage ?? turn.total_token_usage) as
    | Record<string, unknown>
    | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const num = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = raw[k];
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
  const input = num('input_tokens', 'inputTokens', 'prompt_tokens');
  const output = num('output_tokens', 'outputTokens', 'completion_tokens');
  const cacheRead = num('cached_input_tokens', 'cache_read_input_tokens', 'cacheReadInputTokens');
  const cacheWrite = num('cache_creation_input_tokens', 'cacheCreationInputTokens');
  if (input !== undefined) out.inputTokens = input;
  if (output !== undefined) out.outputTokens = output;
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) out.cacheWriteTokens = cacheWrite;
  return Object.keys(out).length > 0 ? out : undefined;
}

function describeStartedTool(type: string, item: Record<string, unknown>): string {
  if (type === 'commandExecution') {
    const cmd = typeof item.command === 'string' ? (item.command as string) : 'shell';
    return `exec(${cmd.slice(0, 40)}${cmd.length > 40 ? '…' : ''})`;
  }
  if (type === 'fileChange') {
    const ops = (item.changes as Array<{ path?: string }> | undefined) ?? [];
    const first = ops[0]?.path ?? 'file';
    return `edit(${first})`;
  }
  if (type === 'mcpToolCall') {
    const name = typeof item.name === 'string' ? (item.name as string) : 'mcp';
    return `mcp:${name}`;
  }
  if (type === 'webSearch') return 'web_search';
  return type || 'tool';
}

function extractArgs(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const candidate = item.arguments ?? item.args ?? item.params ?? item.input;
  if (candidate && typeof candidate === 'object') return candidate as Record<string, unknown>;
  return undefined;
}

function readAgentMessageText(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text;
  const content = item.content;
  if (Array.isArray(content)) {
    let s = '';
    for (const c of content) {
      if (c && typeof c === 'object' && 'text' in (c as Record<string, unknown>)) {
        const t = (c as Record<string, unknown>).text;
        if (typeof t === 'string') s += t;
      }
    }
    return s;
  }
  return '';
}

function extractErrorText(item: Record<string, unknown>): string | undefined {
  if (typeof item.error === 'string') return item.error;
  const err = item.error as { message?: unknown } | undefined;
  if (err && typeof err.message === 'string') return err.message;
  if (typeof item.aggregated_output === 'string') return item.aggregated_output;
  return undefined;
}

interface SpawnEnvOptions {
  extraPath?: string;
}

function buildSpawnEnv(opts: SpawnEnvOptions): NodeJS.ProcessEnv {
  const { extraPath } = opts;
  if (!extraPath) return process.env;
  // Clone so we never mutate `process.env` — concurrent turns must not race
  // on PATH.
  const env: NodeJS.ProcessEnv = { ...process.env };
  const current = process.env.PATH ?? '';
  env.PATH = current ? `${extraPath}${path.delimiter}${current}` : extraPath;
  return env;
}

function summarizeToolResult(item: Record<string, unknown>): unknown {
  if (item.result !== undefined) return item.result;
  if (item.output !== undefined) return item.output;
  if (item.aggregated_output !== undefined) {
    return { aggregated_output: item.aggregated_output, exit_code: item.exit_code };
  }
  return null;
}
