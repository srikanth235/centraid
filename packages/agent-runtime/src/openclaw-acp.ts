/*
 * OpenClaw ACP backend.
 *
 * Spawns `openclaw acp` and drives one agent turn over the Agent Client
 * Protocol (JSON-RPC 2.0 on stdio, framed as newline-delimited JSON).
 * The `@agentclientprotocol/sdk` `ClientSideConnection` owns the wire
 * format; this module owns the process lifecycle, the
 * `session/update` → `ChatStreamEvent` translation (see
 * `openclaw-acp-events.ts`), and abort.
 *
 * Handshake: `initialize` → `session/new` (with `cwd` = the turn's
 * workdir) → `session/prompt`. We spawn a fresh `openclaw acp` per turn,
 * so the ACP session id is process-scoped: it's returned for shape
 * parity with the codex/claude adapters but isn't resumable across turns
 * (centraid's own `ChatHistoryStore` is the durable record). `--no-prefix-cwd`
 * keeps openclaw from prepending the workdir to the prompt — the agent
 * still keys file/exec tools off the session `cwd` we pass.
 *
 * Auth: unlike codex (scoped `CODEX_HOME`) and claude (`ANTHROPIC_*`
 * env), `openclaw` self-authenticates from the user's shell — the model
 * provider is configured inside OpenClaw, not injected here. We forward
 * `process.env` untouched and only prepend `extraPath` to PATH so the
 * agent's shell tool can invoke the bundled `centraid` CLI by bare name
 * (the same data surface the builder agent uses).
 *
 * Tools: openclaw reaches centraid data through that `centraid` CLI on
 * PATH, not through an inline tool dispatcher — so unlike the codex/claude
 * backends this one takes no `toolContext`.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type { ChatStreamEvent } from '@centraid/app-engine';
import { AcpStreamTranslator } from './openclaw-acp-events.js';

export interface OpenClawAcpInput {
  /** Working directory the agent operates in. Passed as the ACP session `cwd`. */
  cwd: string;
  message: string;
  /**
   * Grounding instructions. ACP has no system-prompt field, so when set
   * we prepend it to the user message as a leading block.
   */
  extraSystemPrompt: string;
  model?: string;
  /**
   * Directories prepended to PATH in the spawned process so the agent's
   * shell tool can invoke the bundled `centraid` CLI by bare name.
   */
  extraPath?: string;
  abortSignal: AbortSignal;
  onEvent: (event: ChatStreamEvent) => void;
}

export interface OpenClawAcpConfig {
  /** Override the openclaw binary; defaults to a PATH lookup of `openclaw`. */
  binPath?: string;
  /** Extra args appended to `openclaw acp` (rare). */
  extraArgs?: string[];
}

export interface OpenClawAcpResult {
  /** ACP session id for this turn. Process-scoped — not resumable across turns. */
  sessionId?: string;
}

export async function runOpenClawAcpTurn(
  input: OpenClawAcpInput,
  config: OpenClawAcpConfig = {},
): Promise<OpenClawAcpResult> {
  const bin = config.binPath ?? 'openclaw';
  await fs.mkdir(input.cwd, { recursive: true });

  const args = ['acp', '--no-prefix-cwd', ...(config.extraArgs ?? [])];
  const child = spawn(bin, args, {
    cwd: input.cwd,
    env: buildSpawnEnv(input.extraPath),
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  const emit = (event: ChatStreamEvent): void => {
    if (input.abortSignal.aborted && event.type !== 'aborted') return;
    input.onEvent(event);
  };

  const translator = new AcpStreamTranslator();
  let stderrBuf = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrBuf = (stderrBuf + chunk).slice(-64 * 1024);
  });

  let processExited = false;
  let exitError: Error | undefined;
  const exitPromise = new Promise<void>((resolve) => {
    child.on('error', (err) => {
      exitError = err;
      processExited = true;
      resolve();
    });
    child.on('exit', () => {
      processExited = true;
      resolve();
    });
  });

  // The client handler receives `session/update` notifications (translated
  // to ChatStreamEvents) and auto-allows permission requests — the turn
  // already runs in a scoped workdir under the host's authority.
  const handler: Client = {
    async sessionUpdate(params: SessionNotification): Promise<void> {
      for (const ev of translator.onUpdate(params.update)) emit(ev);
    },
    async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      if (input.abortSignal.aborted) return { outcome: { outcome: 'cancelled' } };
      const allow =
        params.options.find((o) => o.kind === 'allow_once') ??
        params.options.find((o) => o.kind === 'allow_always') ??
        params.options[0];
      if (!allow) return { outcome: { outcome: 'cancelled' } };
      return { outcome: { outcome: 'selected', optionId: allow.optionId } };
    },
  };

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const conn = new ClientSideConnection((_agent: Agent) => handler, stream);

  let sessionId: string | undefined;
  let cancelled = false;
  const abortHandler = (): void => {
    cancelled = true;
    if (sessionId && !processExited) {
      void conn.cancel({ sessionId }).catch(() => undefined);
    }
    if (!child.killed) child.kill('SIGTERM');
  };
  if (input.abortSignal.aborted) abortHandler();
  else input.abortSignal.addEventListener('abort', abortHandler, { once: true });

  emit({ type: 'assistant.start' });

  try {
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });

    const session = await conn.newSession({ cwd: input.cwd, mcpServers: [] });
    sessionId = session.sessionId;

    const promptText = input.extraSystemPrompt
      ? `${input.extraSystemPrompt}\n\n${input.message}`
      : input.message;
    const response = await conn.prompt({
      sessionId,
      prompt: [{ type: 'text', text: promptText }],
    });

    if (response.stopReason === 'cancelled') {
      cancelled = true;
    } else {
      emit({ type: 'final', text: translator.finalText });
    }
    emit({ type: 'phase', phase: 'turn.completed' });
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

  if (input.abortSignal.aborted || cancelled) emit({ type: 'aborted' });
  if (exitError && !input.abortSignal.aborted) {
    emit({ type: 'error', message: exitError.message });
  }

  return sessionId ? { sessionId } : {};
}

/**
 * Clone `process.env` (never mutate it — concurrent turns must not race on
 * PATH) and prepend `extraPath` so the agent's shell tool can find the
 * bundled `centraid` CLI. Provider auth is left to the user's shell.
 */
function buildSpawnEnv(extraPath?: string): NodeJS.ProcessEnv {
  if (!extraPath) return process.env;
  const env: NodeJS.ProcessEnv = { ...process.env };
  const current = process.env.PATH ?? '';
  env.PATH = current ? `${extraPath}${path.delimiter}${current}` : extraPath;
  return env;
}
