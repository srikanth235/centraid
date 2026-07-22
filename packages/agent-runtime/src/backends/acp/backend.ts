/*
 * Generic ACP (Agent Client Protocol) backend — the ONE integration path
 * for every runner kind (issue #479).
 *
 * Turn flow: launch (or warm reuse) → initialize → session resume|load|new →
 * pin mode/model → session/prompt → stopReason handling → warm park or kill.
 *
 * See ./stop-reason.ts, ./agent-errors.ts, ./session-warm.ts, ./turn-vault-tools.ts.
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
import { classifyAgentFailure } from './agent-errors.js';
import { isObject } from './content.js';
import {
  ACP_PROTOCOL_VERSION,
  createAcpConnection,
  type AcpConnection,
  type AcpConnectionHandlers,
} from './json-rpc.js';
import { planLaunch } from './launch.js';
import {
  permissionAutoAllowNotice,
  pickPermissionOption,
  readPermissionOptions,
  readPermissionToolTitle,
} from './permissions.js';
import {
  hasSessionCapability,
  modeAvailable,
  pinModel,
  readConfigOptions,
  SET_MODE,
  type InitializeResult,
  type SessionConfigOption,
  type SessionModes,
  type SessionSetupResult,
} from './session-config.js';
import { putWarmSlot, takeWarmSlot } from './session-warm.js';
import { createSessionUpdateMapper } from './stream-events.js';
import { outcomeForStopReason } from './stop-reason.js';
import { startTurnVaultTools } from './turn-vault-tools.js';
import { buildUsageEvent } from './usage.js';
import type { AcpTurnConfig, AcpTurnInput, AcpTurnResult } from './types.js';

export type { AcpAdapterSpec, AcpTurnConfig, AcpTurnInput, AcpTurnResult } from './types.js';

type Continuity = 'fresh' | 'resumed' | 'loaded' | 'warm';

export async function runAcpTurn(
  input: AcpTurnInput,
  config: AcpTurnConfig,
): Promise<AcpTurnResult> {
  const pendingNotices: TurnStreamEvent[] = [];
  let launch: { bin: string; args: string[]; env: NodeJS.ProcessEnv };
  try {
    launch = planLaunch(config, input.extraPath, pendingNotices);
  } catch (err) {
    input.onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    return {};
  }

  await fs.mkdir(input.cwd, { recursive: true });

  let sessionId: string | undefined;
  let promptStarted = false;
  let vaultMcp: Awaited<ReturnType<typeof startTurnVaultTools>>['handle'];
  let activeModel: string | undefined;
  // Assigned on warm take or fresh spawn before any use; definite assignment
  // assertion keeps the dual-path structure readable for tsc.
  let child!: ChildProcessByStdio<Writable, Readable, Readable>;
  let conn!: AcpConnection;
  let canClose = false;
  let canResume = false;
  let canLoad = false;
  let canAdditional = false;
  let httpMcp = false;
  let promptCaps: PromptCapabilities = {};
  let continuity: Continuity = 'fresh';
  let parkWarm = false;
  let reusedWarm = false;
  let configOptions: SessionConfigOption[] = [];
  let modes: SessionModes | undefined;

  const emit = (event: TurnStreamEvent): void => {
    if (input.abortSignal.aborted) return;
    input.onEvent(event);
  };

  const stream = createSessionUpdateMapper(emit);

  const makeHandlers = (): AcpConnectionHandlers => ({
    onServerRequest: (id, method, params) => {
      if (method === 'session/request_permission') {
        if (input.abortSignal.aborted) {
          conn.respond(id, { outcome: { outcome: 'cancelled' } });
          return;
        }
        const options = readPermissionOptions(params);
        const optionId = pickPermissionOption(options);
        const toolTitle = readPermissionToolTitle(params);
        if (optionId) {
          emit(permissionAutoAllowNotice(optionId, options, toolTitle));
          conn.respond(id, { outcome: { outcome: 'selected', optionId } });
        } else {
          conn.respond(id, { outcome: { outcome: 'cancelled' } });
        }
        return;
      }
      conn.respondMethodNotFound(id, method);
    },
    onNotification: (method, params) => {
      if (method !== 'session/update') return;
      if (!promptStarted) return;
      stream.handleSessionUpdate(params);
    },
  });

  // ---- Warm reuse ---------------------------------------------------------
  if (input.prevSessionId) {
    const warm = takeWarmSlot(config.kind, input.cwd, input.prevSessionId);
    if (warm) {
      reusedWarm = true;
      child = warm.child;
      conn = warm.conn;
      sessionId = warm.sessionId;
      canClose = warm.canClose;
      canResume = warm.canResume;
      canLoad = warm.canLoad;
      httpMcp = warm.httpMcp;
      promptCaps = warm.promptCaps as PromptCapabilities;
      continuity = 'warm';
      conn.setHandlers(makeHandlers());
    }
  }

  if (!reusedWarm) {
    const command = lowPriorityCommand(launch.bin, launch.args);
    child = spawn(command.bin, command.args, {
      cwd: input.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
    conn = createAcpConnection(child, makeHandlers());
  }

  const abortHandler = (): void => {
    parkWarm = false;
    if (sessionId && !conn.hasExited()) {
      try {
        conn.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
      } catch {
        // ignore
      }
    }
    if (!child.killed) child.kill('SIGTERM');
  };
  if (input.abortSignal.aborted) abortHandler();
  else input.abortSignal.addEventListener('abort', abortHandler, { once: true });

  const sessionParams = (sid?: string): Record<string, unknown> => {
    const base: Record<string, unknown> = {
      cwd: input.cwd,
      ...(sid ? { sessionId: sid } : {}),
    };
    if (canAdditional && input.additionalDirectories?.length) {
      base.additionalDirectories = input.additionalDirectories;
    }
    return base;
  };

  try {
    if (!reusedWarm) {
      const init = await conn.request<InitializeResult>('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'centraid-local-runner', title: 'Centraid', version: '0.1.0' },
      });
      canLoad = init?.agentCapabilities?.loadSession === true;
      const sc = init?.agentCapabilities?.sessionCapabilities;
      canResume = hasSessionCapability(sc, 'resume');
      canClose = hasSessionCapability(sc, 'close');
      canAdditional = hasSessionCapability(sc, 'additionalDirectories');
      promptCaps = isObject(init?.agentCapabilities?.promptCapabilities)
        ? (init.agentCapabilities.promptCapabilities as PromptCapabilities)
        : {};
      httpMcp = init?.agentCapabilities?.mcpCapabilities?.http === true;

      for (const notice of pendingNotices) emit(notice);

      const vaultTools = await startTurnVaultTools({
        toolContext: input.toolContext,
        httpMcp,
        emit,
        agentStreamsTool: stream.agentStreamsTool,
      });
      vaultMcp = vaultTools.handle;
      const mcpServers = vaultTools.mcpServers;

      const withMcp = (sid?: string): Record<string, unknown> => ({
        ...sessionParams(sid),
        mcpServers,
      });

      if (input.prevSessionId && canResume) {
        try {
          const resumed = await conn.request<SessionSetupResult>(
            'session/resume',
            withMcp(input.prevSessionId),
          );
          configOptions = readConfigOptions(resumed);
          modes = resumed?.modes ?? undefined;
          sessionId = input.prevSessionId;
          continuity = 'resumed';
        } catch {
          sessionId = undefined;
        }
      }
      if (!sessionId && input.prevSessionId && canLoad) {
        try {
          const loaded = await conn.request<SessionSetupResult>(
            'session/load',
            withMcp(input.prevSessionId),
          );
          configOptions = readConfigOptions(loaded);
          modes = loaded?.modes ?? undefined;
          sessionId = input.prevSessionId;
          continuity = 'loaded';
        } catch {
          sessionId = undefined;
        }
      }
      if (!sessionId) {
        const created = await conn.request<SessionSetupResult>('session/new', withMcp());
        const id = typeof created?.sessionId === 'string' ? created.sessionId : undefined;
        if (!id) throw new Error('acp agent did not return a sessionId');
        configOptions = readConfigOptions(created);
        modes = created?.modes ?? undefined;
        sessionId = id;
        continuity = 'fresh';
      }
    } else {
      for (const notice of pendingNotices) emit(notice);
      const vaultTools = await startTurnVaultTools({
        toolContext: input.toolContext,
        httpMcp,
        emit,
        agentStreamsTool: stream.agentStreamsTool,
      });
      vaultMcp = vaultTools.handle;
      const mcpServers = vaultTools.mcpServers;
      const sid = sessionId!;
      try {
        if (canResume) {
          const resumed = await conn.request<SessionSetupResult>('session/resume', {
            ...sessionParams(sid),
            mcpServers,
          });
          configOptions = readConfigOptions(resumed);
          modes = resumed?.modes ?? undefined;
        } else if (canLoad) {
          const loaded = await conn.request<SessionSetupResult>('session/load', {
            ...sessionParams(sid),
            mcpServers,
          });
          configOptions = readConfigOptions(loaded);
          modes = loaded?.modes ?? undefined;
        }
      } catch {
        emit({
          type: 'notice',
          level: 'warn',
          code: 'session_warm_reattach_failed',
          message: 'Could not reattach the warm agent session; continuing with the existing id.',
        });
      }
    }

    emit({
      type: 'notice',
      level: 'info',
      code: 'session_continuity',
      message:
        continuity === 'fresh'
          ? 'Started a new agent session for this turn.'
          : continuity === 'resumed'
            ? 'Resumed the prior agent session (no history replay).'
            : continuity === 'loaded'
              ? 'Loaded the prior agent session.'
              : 'Reused a warm agent process for this turn.',
    });

    const wantMode = config.adapter?.sessionModeId;
    if (wantMode && sessionId) {
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
      sessionId: sessionId!,
      configOptions,
      requested: input.model,
      resolveModel: config.resolveModel,
    });

    const prompt: ContentBlock[] = [];
    if (input.extraSystemPrompt) {
      prompt.push({ type: 'text', text: input.extraSystemPrompt });
    }
    prompt.push({ type: 'text', text: input.message });

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
    const promptResult = await conn.request<{ usage?: unknown; stopReason?: unknown }>(
      'session/prompt',
      { sessionId, prompt },
    );

    if (isObject(promptResult?.usage)) stream.foldTokenUsage(promptResult.usage);
    const folded = stream.usage();
    const usageEvent = buildUsageEvent(config.kind, activeModel, folded.tokens, folded.cost);
    if (usageEvent) emit(usageEvent);

    if (!input.abortSignal.aborted) {
      const stop = outcomeForStopReason(promptResult?.stopReason);
      if (stop.notice) emit(stop.notice);
      if (stop.error) emit(stop.error);
      else if (stop.emitFinal) emit({ type: 'final', text: stream.finalText() });
      parkWarm =
        Boolean(sessionId) &&
        (canResume || canLoad) &&
        !stop.error &&
        (promptResult?.stopReason === 'end_turn' ||
          promptResult?.stopReason === undefined ||
          promptResult?.stopReason === 'max_tokens' ||
          promptResult?.stopReason === 'max_turn_requests');
    }
  } catch (err) {
    parkWarm = false;
    if (!input.abortSignal.aborted) {
      emit({
        type: 'error',
        message: classifyAgentFailure(err, conn.stderrTail(), config),
      });
    }
  } finally {
    await vaultMcp?.close();

    if (parkWarm && sessionId && !input.abortSignal.aborted && !conn.hasExited()) {
      putWarmSlot({
        kind: config.kind,
        cwd: input.cwd,
        sessionId,
        child,
        conn,
        canResume,
        canLoad,
        canClose,
        httpMcp,
        promptCaps: promptCaps as Record<string, unknown>,
      });
    } else {
      if (canClose && sessionId && !conn.hasExited()) {
        try {
          await conn.request('session/close', { sessionId });
        } catch {
          // ignore
        }
      }
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      if (!child.killed) child.kill('SIGTERM');
      await conn.exited;
    }

    input.abortSignal.removeEventListener('abort', abortHandler);
  }

  const spawnError = conn.spawnError();
  if (input.abortSignal.aborted) input.onEvent({ type: 'aborted' });
  else if (spawnError) input.onEvent({ type: 'error', message: spawnError.message });

  return sessionId ? { sessionId } : {};
}
