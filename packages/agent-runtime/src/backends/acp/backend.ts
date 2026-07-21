/*
 * Generic ACP (Agent Client Protocol) backend — the ONE integration path
 * for every runner kind (issue #479).
 *
 * This module is the turn orchestrator: it plans the launch, spawns the
 * agent, drives one turn over JSON-RPC on stdio, and tears everything down.
 * The pieces it composes each own one concern and carry the protocol facts
 * they depend on:
 *
 *   - `./types.ts`          — the public turn contract + adapter spec
 *   - `./launch.ts`         — what process to spawn, with what env
 *   - `./json-rpc.ts`       — newline-framed JSON-RPC 2.0 over stdio
 *   - `./session-config.ts` — handshake, session/new vs load, model pinning
 *   - `./stream-events.ts`  — session/update → `TurnStreamEvent`
 *   - `./permissions.ts`    — session/request_permission auto-allow
 *   - `./turn-vault-tools.ts` — the per-turn loopback MCP endpoint
 *   - `./usage.ts`          — one usage event per turn
 *
 * Turn wire shapes this module owns (verified against the public ACP spec at
 * https://agentclientprotocol.com):
 *
 *   - turn: `session/prompt` { sessionId, prompt: ContentBlock[] } →
 *     { stopReason: end_turn|max_tokens|max_turn_requests|refusal|cancelled }.
 *   - cancel: `session/cancel` { sessionId } notification; the pending
 *     `session/prompt` then resolves with stopReason 'cancelled'.
 *
 * We advertise NO client fs/terminal capabilities, so `fs/read_text_file`,
 * `fs/write_text_file`, and `terminal/*` server requests are answered with
 * a polite JSON-RPC method-not-found error.
 *
 * Attachments: mapped to ACP content blocks by `../../multimodal.ts`, gated
 * on the `promptCapabilities` the agent advertised. Only what it genuinely
 * can't take produces a notice, and the notice names it.
 *
 * Auth: an agent that hasn't been signed in answers session creation with
 * `AUTH_REQUIRED` (-32000). We keep the JSON-RPC error code (see
 * `AcpRpcError`) so that case can be answered with the registry's own
 * install hint instead of a raw RPC string — the per-kind text stays in
 * `registry.ts`, never in here.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import type { TurnStreamEvent } from '@centraid/app-engine';
import { lowPriorityCommand } from '../../low-priority.js';
import {
  acpAttachmentBlocks,
  type ContentBlock,
  type PromptCapabilities,
} from '../../multimodal.js';
import { isObject } from './content.js';
import {
  ACP_PROTOCOL_VERSION,
  AUTH_REQUIRED_CODE,
  AcpRpcError,
  createAcpConnection,
} from './json-rpc.js';
import { planLaunch } from './launch.js';
import { pickPermissionOption, readPermissionOptions } from './permissions.js';
import {
  modeAvailable,
  pinModel,
  readConfigOptions,
  SET_MODE,
  type InitializeResult,
  type SessionConfigOption,
  type SessionModes,
  type SessionSetupResult,
} from './session-config.js';
import { createSessionUpdateMapper } from './stream-events.js';
import { startTurnVaultTools } from './turn-vault-tools.js';
import { buildUsageEvent } from './usage.js';
import type { AcpTurnConfig, AcpTurnInput, AcpTurnResult } from './types.js';

export type { AcpAdapterSpec, AcpTurnConfig, AcpTurnInput, AcpTurnResult } from './types.js';

export async function runAcpTurn(
  input: AcpTurnInput,
  config: AcpTurnConfig,
): Promise<AcpTurnResult> {
  // Launch plan differs by flavour but nothing downstream cares which we used.
  // `pendingNotices` are queued here and flushed once the session exists, so
  // launch-time findings still reach the transcript in turn order.
  const pendingNotices: TurnStreamEvent[] = [];
  let launch: { bin: string; args: string[]; env: NodeJS.ProcessEnv };
  try {
    launch = planLaunch(config, input.extraPath, pendingNotices);
  } catch (err) {
    input.onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    return {};
  }

  await fs.mkdir(input.cwd, { recursive: true });

  const command = lowPriorityCommand(launch.bin, launch.args);
  const child = spawn(command.bin, command.args, {
    cwd: input.cwd,
    env: launch.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessByStdio<Writable, Readable, Readable>;

  let sessionId: string | undefined;
  // Turn state.
  let promptStarted = false; // gate: swallow session/load replay updates
  /** Per-turn vault MCP endpoint; torn down with the child in `finally`. */
  let vaultMcp: Awaited<ReturnType<typeof startTurnVaultTools>>['handle'];
  /** The model actually in effect — pinned by us, or the agent's current value. */
  let activeModel: string | undefined;

  const emit = (event: TurnStreamEvent): void => {
    if (input.abortSignal.aborted) return;
    input.onEvent(event);
  };

  const stream = createSessionUpdateMapper(emit);

  const conn = createAcpConnection(child, {
    onServerRequest: (id, method, params) => {
      if (method === 'session/request_permission') {
        // Headless policy parity with codex/claude: auto-allow the least
        // destructive option. If the turn was cancelled, decline per spec.
        if (input.abortSignal.aborted) {
          conn.respond(id, { outcome: { outcome: 'cancelled' } });
          return;
        }
        const optionId = pickPermissionOption(readPermissionOptions(params));
        if (optionId) conn.respond(id, { outcome: { outcome: 'selected', optionId } });
        else conn.respond(id, { outcome: { outcome: 'cancelled' } });
        return;
      }
      // We advertised no fs/terminal client capabilities — decline politely.
      conn.respondMethodNotFound(id, method);
    },
    onNotification: (method, params) => {
      if (method !== 'session/update') return;
      if (!promptStarted) return; // session/load history replay — not this turn
      stream.handleSessionUpdate(params);
    },
  });

  const abortHandler = (): void => {
    if (sessionId && !conn.hasExited()) {
      try {
        conn.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      } catch {
        // ignore — we kill the process below
      }
    }
    if (!child.killed) child.kill('SIGTERM');
  };
  if (input.abortSignal.aborted) abortHandler();
  else input.abortSignal.addEventListener('abort', abortHandler, { once: true });

  try {
    const init = await conn.request<InitializeResult>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'centraid-local-runner', title: 'Centraid', version: '0.1.0' },
    });
    const canLoad = init?.agentCapabilities?.loadSession === true;
    const promptCaps: PromptCapabilities = isObject(init?.agentCapabilities?.promptCapabilities)
      ? (init.agentCapabilities.promptCapabilities as PromptCapabilities)
      : {};
    const httpMcp = init?.agentCapabilities?.mcpCapabilities?.http === true;

    // Launch-time findings (adapter env caveats) reach the transcript now
    // that the handshake proved the agent is alive.
    for (const notice of pendingNotices) emit(notice);

    const vaultTools = await startTurnVaultTools({
      toolContext: input.toolContext,
      httpMcp,
      emit,
      agentStreamsTool: stream.agentStreamsTool,
    });
    vaultMcp = vaultTools.handle;
    const mcpServers = vaultTools.mcpServers;

    let configOptions: SessionConfigOption[] = [];
    let modes: SessionModes | undefined;
    let freshSession = true;
    if (input.prevSessionId && canLoad) {
      try {
        const loaded = await conn.request<SessionSetupResult>('session/load', {
          sessionId: input.prevSessionId,
          cwd: input.cwd,
          mcpServers,
        });
        configOptions = readConfigOptions(loaded);
        modes = loaded?.modes ?? undefined;
        sessionId = input.prevSessionId;
        freshSession = false;
      } catch {
        // Resume rejected — fall back to a fresh session (mirrors how
        // runner-core degrades when resume is unavailable).
        sessionId = undefined;
      }
    }
    if (!sessionId) {
      const created = await conn.request<SessionSetupResult>('session/new', {
        cwd: input.cwd,
        mcpServers,
      });
      const id = typeof created?.sessionId === 'string' ? created.sessionId : undefined;
      if (!id) throw new Error('acp agent did not return a sessionId');
      configOptions = readConfigOptions(created);
      modes = created?.modes ?? undefined;
      sessionId = id;
      freshSession = true;
    }

    // Headless policy for adapter-backed kinds that express it as a session
    // mode (claude: `bypassPermissions`). Codex's equivalent rides in as a
    // launch env var, so it never reaches this branch.
    const wantMode = config.adapter?.sessionModeId;
    if (wantMode) {
      if (modeAvailable(modes, wantMode)) {
        await conn.request(SET_MODE, { sessionId, modeId: wantMode }).catch(() => undefined);
      } else {
        emit({
          type: 'notice',
          level: 'warn',
          code: 'permission_mode_unavailable',
          message:
            `This runner didn’t offer its non-interactive permission mode (${wantMode}), ` +
            `so tool use may stall waiting for an approval this surface can’t show.`,
        });
      }
    }

    activeModel = await pinModel({
      request: conn.request,
      emit,
      sessionId,
      configOptions,
      requested: input.model,
      resolveModel: config.resolveModel,
    });

    const prompt: ContentBlock[] = [];
    if (freshSession && input.extraSystemPrompt) {
      prompt.push({ type: 'text', text: input.extraSystemPrompt });
    }
    prompt.push({ type: 'text', text: input.message });

    // Attachments ride the prompt as real content blocks, gated on what the
    // agent advertised. Only what it genuinely can't take gets a notice —
    // and the notice names it, so "my screenshot vanished" is never a
    // mystery.
    if (input.attachments?.length) {
      const mapped = acpAttachmentBlocks(input.attachments, promptCaps);
      prompt.push(...mapped.blocks);
      if (mapped.skipped.length) {
        emit({
          type: 'notice',
          level: 'warn',
          code: 'attachment_unsupported',
          message:
            `This runner can’t read ${mapped.skipped.length === 1 ? 'this attachment' : 'these attachments'}, ` +
            `so ${mapped.skipped.length === 1 ? 'it was' : 'they were'} skipped: ${mapped.skipped.join(', ')}.`,
        });
      }
    }

    promptStarted = true;
    const promptResult = await conn.request<{ usage?: unknown }>('session/prompt', {
      sessionId,
      prompt,
    });

    // `PromptResponse.usage` is the authoritative token breakdown; anything
    // scraped off `usage_update` is a fallback for agents that predate it.
    if (isObject(promptResult?.usage)) stream.foldTokenUsage(promptResult.usage);
    const folded = stream.usage();
    const usageEvent = buildUsageEvent(config.kind, activeModel, folded.tokens, folded.cost);
    if (usageEvent) emit(usageEvent);

    if (!input.abortSignal.aborted) emit({ type: 'final', text: stream.finalText() });
  } catch (err) {
    if (!input.abortSignal.aborted) {
      if (err instanceof AcpRpcError && err.code === AUTH_REQUIRED_CODE) {
        // The single most common first-run failure. A raw
        // "acp rpc 1: Authentication required" tells the owner nothing they
        // can act on; the registry's own install hint does.
        emit({ type: 'error', message: authRequiredMessage(config) });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        const stderr = conn.stderrTail();
        emit({
          type: 'error',
          message: `${msg}${stderr ? `\n${stderr.trim().slice(-2000)}` : ''}`,
        });
      }
    }
  } finally {
    // The vault endpoint dies with the turn that opened it — before the
    // child, so a still-running agent can't dial it during teardown. This
    // runs on every exit path, abort included.
    await vaultMcp?.close();
    // Always end stdin: a graceful EOF lets a well-behaved agent shut down
    // even when it ignores SIGTERM, and is a no-op once the stream is gone.
    try {
      child.stdin.end();
    } catch {
      // ignore — stream already destroyed
    }
    if (!child.killed) child.kill('SIGTERM');
    await conn.exited;
    input.abortSignal.removeEventListener('abort', abortHandler);
  }

  // Terminal events bypass the abort-gated `emit` — the whole point of
  // `aborted` is to fire *because* the signal aborted.
  const spawnError = conn.spawnError();
  if (input.abortSignal.aborted) input.onEvent({ type: 'aborted' });
  else if (spawnError) input.onEvent({ type: 'error', message: spawnError.message });

  return sessionId ? { sessionId } : {};
}

/**
 * Turn an `AUTH_REQUIRED` into something the owner can act on.
 *
 * The per-kind "how to sign in" string is the registry's `installHint`, not
 * a table in here: this client must stay kind-agnostic, and the hint already
 * exists next to the kind's other metadata.
 */
function authRequiredMessage(config: AcpTurnConfig): string {
  const label = config.label ?? config.kind;
  const hint = config.installHint ? ` ${config.installHint}` : '';
  return `${label} isn’t signed in, so it refused to start a session.${hint}`;
}
