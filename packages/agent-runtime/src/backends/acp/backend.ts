/*
 * governance: allow-repo-hygiene file-size-limit (#567) the generic ACP lifecycle is one ordered initialize/configure/resume/prompt/settle state machine; splitting its transaction would scatter failure cleanup and confirmed-state accounting
 *
 * Generic ACP (Agent Client Protocol) backend — the ONE integration path
 * for every runner kind (issue #479).
 *
 * Turn flow: launch (or warm reuse) → initialize → session resume|load|new →
 * pin mode/model → session/prompt → stopReason handling → warm park or kill.
 *
 * See ./stop-reason.ts, ./agent-errors.ts, ./session-warm.ts, ./turn-vault-tools.ts.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { promises as fs } from "node:fs";
import type { Readable, Writable } from "node:stream";

import type { TurnStreamEvent } from "@centraid/app-engine";

import { lowPriorityCommand } from "../../low-priority.js";
import { acpAttachmentBlocks } from "../../multimodal.js";
import type { ContentBlock, PromptCapabilities } from "../../multimodal.js";
import { classifyAgentFailureDetail } from "./agent-errors.js";
import { isObject } from "./content.js";
import { ACP_PROTOCOL_VERSION, createAcpConnection } from "./json-rpc.js";
import type { AcpConnection, AcpConnectionHandlers } from "./json-rpc.js";
import { planLaunch } from "./launch.js";
import {
  permissionAutoAllowNotice,
  permissionDeniedNotice,
  pickPermissionOption,
  pickRejectPermissionOption,
  readPermissionOptions,
  readPermissionToolTitle,
} from "./permissions.js";
import {
  hasSessionCapability,
  modeAvailable,
  pinModel,
  pinThoughtLevel,
  readConfigOptions,
  readConfigOptionUpdate,
  readCurrentConfigValue,
  SET_MODE,
} from "./session-config.js";
import type {
  InitializeResult,
  SessionConfigOption,
  SessionModes,
  SessionSetupResult,
} from "./session-config.js";
import { putWarmSlot, takeWarmSlot } from "./session-warm.js";
import { outcomeForStopReason } from "./stop-reason.js";
import { createSessionUpdateMapper } from "./stream-events.js";
import { startTurnVaultTools } from "./turn-vault-tools.js";
import type { AcpTurnConfig, AcpTurnInput, AcpTurnResult } from "./types.js";
import { buildUsageEvent, deltaCumulativeUsage } from "./usage.js";

export type {
  AcpAdapterSpec,
  AcpTurnConfig,
  AcpTurnInput,
  AcpTurnResult,
} from "./types.js";

type Continuity = "fresh" | "resumed" | "loaded" | "warm";

const DEFAULT_STAGE_TIMEOUT_MS = 20_000;
const DEFAULT_PROMPT_IDLE_TIMEOUT_MS = 120_000;

function requestWithTimeout<T>(
  request: Promise<T>,
  timeoutMs: number,
  stage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`ACP ${stage} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    timer.unref?.();
  });
  return Promise.race([request, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function runAcpTurn(
  input: AcpTurnInput,
  config: AcpTurnConfig
): Promise<AcpTurnResult> {
  const pendingNotices: TurnStreamEvent[] = [];
  let launch: { bin: string; args: string[]; env: NodeJS.ProcessEnv };
  try {
    launch = planLaunch(config, input.extraPath, pendingNotices);
  } catch (error) {
    const failure = classifyAgentFailureDetail(error, "", config);
    input.onEvent({
      type: "error",
      message: failure.message,
      failureClass:
        failure.failureClass === "unknown" ? "spawn" : failure.failureClass,
    });
    return {};
  }

  await fs.mkdir(input.cwd, { recursive: true });

  let sessionId: string | undefined;
  let promptStarted = false;
  let vaultMcp: Awaited<ReturnType<typeof startTurnVaultTools>>["handle"];
  let activeModel: string | undefined;
  let activeEffort: string | undefined;
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
  let continuity: Continuity = "fresh";
  let parkWarm = false;
  let reusedWarm = false;
  let configOptions: SessionConfigOption[] = [];
  let modes: SessionModes | undefined;
  let usageSnapshot: AcpTurnResult["usageSnapshot"];
  let hydrated = false;
  let hydrationKind: "handoff" | "recovery" | undefined;
  let promptIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectPromptIdle: ((error: Error) => void) | undefined;
  const stageTimeoutMs = config.stageTimeoutMs ?? DEFAULT_STAGE_TIMEOUT_MS;
  const promptIdleTimeoutMs =
    config.promptIdleTimeoutMs ?? DEFAULT_PROMPT_IDLE_TIMEOUT_MS;

  const clearPromptIdleWatchdog = (): void => {
    if (promptIdleTimer) clearTimeout(promptIdleTimer);
    promptIdleTimer = undefined;
  };
  const touchPromptIdleWatchdog = (): void => {
    if (!rejectPromptIdle) return;
    clearPromptIdleWatchdog();
    promptIdleTimer = setTimeout(() => {
      rejectPromptIdle?.(
        new Error(
          `ACP prompt idle watchdog timed out after ${promptIdleTimeoutMs}ms (wedge)`
        )
      );
    }, promptIdleTimeoutMs);
    promptIdleTimer.unref?.();
  };

  const emit = (event: TurnStreamEvent): void => {
    if (input.abortSignal.aborted) return;
    input.onEvent(event);
  };

  const stream = createSessionUpdateMapper(emit);

  const makeHandlers = (): AcpConnectionHandlers => ({
    onServerRequest: (id, method, params) => {
      touchPromptIdleWatchdog();
      if (method === "session/request_permission") {
        if (input.abortSignal.aborted) {
          conn.respond(id, { outcome: { outcome: "cancelled" } });
          return;
        }
        const toolTitle = readPermissionToolTitle(params);
        const options = readPermissionOptions(params);
        if (input.permissionPolicy === "deny") {
          emit(permissionDeniedNotice(toolTitle));
          // Refuse THIS request, not the turn: `cancelled` is the wire's
          // "the prompt turn was cancelled before an answer", and an agent
          // that honours it unwinds everything — contradicting the notice
          // above ("this turn may use only its pre-granted tools"). Only an
          // agent offering no reject option leaves us with `cancelled`.
          const rejectId = pickRejectPermissionOption(options);
          conn.respond(
            id,
            rejectId
              ? { outcome: { outcome: "selected", optionId: rejectId } }
              : { outcome: { outcome: "cancelled" } }
          );
          return;
        }
        const optionId = pickPermissionOption(options);
        if (optionId) {
          emit(permissionAutoAllowNotice(optionId, options, toolTitle));
          conn.respond(id, { outcome: { outcome: "selected", optionId } });
        } else {
          conn.respond(id, { outcome: { outcome: "cancelled" } });
        }
        return;
      }
      conn.respondMethodNotFound(id, method);
    },
    onNotification: (method, params) => {
      touchPromptIdleWatchdog();
      if (method !== "session/update") return;
      const optionUpdate = readConfigOptionUpdate(params);
      if (optionUpdate) {
        // `ConfigOptionUpdate.configOptions` is "the full set" per the ACP
        // schema — REPLACE, never merge, so an option the agent dropped stops
        // being a pin target and stops feeding accounting.
        configOptions = optionUpdate;
        // The agent just told us what is actually in effect, which is exactly
        // the D4 "ACP-confirmed" evidence the usage stamp needs. A mid-turn
        // model/effort switch has to book the rest of the turn under the new
        // identity instead of the value pinned before the prompt started.
        activeModel = readCurrentConfigValue(configOptions, "model");
        activeEffort = readCurrentConfigValue(configOptions, "thought_level");
      }
      if (!promptStarted) return;
      stream.handleSessionUpdate(params);
    },
  });

  // ---- Warm reuse ---------------------------------------------------------
  if (input.prevSessionId) {
    const warm = takeWarmSlot(
      config.kind,
      input.cwd,
      input.prevSessionId,
      input.conversationId
    );
    if (warm) {
      reusedWarm = true;
      child = warm.child;
      conn = warm.conn;
      sessionId = warm.sessionId;
      canClose = warm.canClose;
      canResume = warm.canResume;
      canLoad = warm.canLoad;
      canAdditional = warm.canAdditional;
      httpMcp = warm.httpMcp;
      promptCaps = warm.promptCaps as PromptCapabilities;
      continuity = "warm";
      conn.setHandlers(makeHandlers());
    }
  }

  if (!reusedWarm) {
    const command = lowPriorityCommand(launch.bin, launch.args);
    child = spawn(command.bin, command.args, {
      cwd: input.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
    conn = createAcpConnection(child, makeHandlers());
  }

  const abortHandler = (): void => {
    parkWarm = false;
    if (sessionId && !conn.hasExited()) {
      try {
        conn.send({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId },
        });
      } catch {
        // ignore
      }
    }
    if (!child.killed) child.kill("SIGTERM");
  };
  if (input.abortSignal.aborted) abortHandler();
  else
    input.abortSignal.addEventListener("abort", abortHandler, { once: true });

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
    if (reusedWarm) {
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
          const resumed = await requestWithTimeout(
            conn.request<SessionSetupResult>("session/resume", {
              ...sessionParams(sid),
              mcpServers,
            }),
            stageTimeoutMs,
            "session/resume"
          );
          configOptions = readConfigOptions(resumed);
          modes = resumed?.modes ?? undefined;
        } else if (canLoad) {
          const loaded = await requestWithTimeout(
            conn.request<SessionSetupResult>("session/load", {
              ...sessionParams(sid),
              mcpServers,
            }),
            stageTimeoutMs,
            "session/load"
          );
          configOptions = readConfigOptions(loaded);
          modes = loaded?.modes ?? undefined;
        }
      } catch {
        const created = await requestWithTimeout(
          conn.request<SessionSetupResult>("session/new", {
            ...sessionParams(),
            mcpServers,
          }),
          stageTimeoutMs,
          "session/new after resume failure"
        );
        const freshId =
          typeof created?.sessionId === "string"
            ? created.sessionId
            : undefined;
        if (!freshId)
          throw new Error(
            "acp agent did not return a sessionId after resume failure"
          );
        configOptions = readConfigOptions(created);
        modes = created?.modes ?? undefined;
        sessionId = freshId;
        continuity = "fresh";
        // Announced only after the replacement session exists (see above).
        emit({
          type: "notice",
          level: "warn",
          code: "session_resume_self_heal",
          message:
            "The agent no longer recognized its saved session. Started a fresh session and restored the conversation from Centraid’s ledger.",
        });
      }
    } else {
      const init = await requestWithTimeout(
        conn.request<InitializeResult>("initialize", {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "centraid-local-runner",
            title: "Centraid",
            version: "0.1.0",
          },
        }),
        stageTimeoutMs,
        "initialize"
      );
      canLoad = init?.agentCapabilities?.loadSession === true;
      const sc = init?.agentCapabilities?.sessionCapabilities;
      canResume = hasSessionCapability(sc, "resume");
      canClose = hasSessionCapability(sc, "close");
      canAdditional = hasSessionCapability(sc, "additionalDirectories");
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
          const resumed = await requestWithTimeout(
            conn.request<SessionSetupResult>(
              "session/resume",
              withMcp(input.prevSessionId)
            ),
            stageTimeoutMs,
            "session/resume"
          );
          configOptions = readConfigOptions(resumed);
          modes = resumed?.modes ?? undefined;
          sessionId = input.prevSessionId;
          continuity = "resumed";
        } catch {
          sessionId = undefined;
        }
      }
      if (!sessionId && input.prevSessionId && canLoad) {
        try {
          const loaded = await requestWithTimeout(
            conn.request<SessionSetupResult>(
              "session/load",
              withMcp(input.prevSessionId)
            ),
            stageTimeoutMs,
            "session/load"
          );
          configOptions = readConfigOptions(loaded);
          modes = loaded?.modes ?? undefined;
          sessionId = input.prevSessionId;
          continuity = "loaded";
        } catch {
          sessionId = undefined;
        }
      }
      if (!sessionId) {
        const selfHealed =
          Boolean(input.prevSessionId) && (canResume || canLoad);
        const created = await requestWithTimeout(
          conn.request<SessionSetupResult>("session/new", withMcp()),
          stageTimeoutMs,
          "session/new"
        );
        const id =
          typeof created?.sessionId === "string"
            ? created.sessionId
            : undefined;
        if (!id) throw new Error("acp agent did not return a sessionId");
        configOptions = readConfigOptions(created);
        modes = created?.modes ?? undefined;
        sessionId = id;
        continuity = "fresh";
        // Only claim the self-heal once the fresh session really exists — a
        // failing `session/new` must not leave the owner told we recovered.
        if (selfHealed) {
          emit({
            type: "notice",
            level: "warn",
            code: "session_resume_self_heal",
            message:
              "The agent no longer recognized its saved session. Started a fresh session and restored the conversation from Centraid’s ledger.",
          });
        }
      }
    }

    if (input.additionalDirectories?.length && !canAdditional) {
      emit({
        type: "notice",
        level: "warn",
        code: "additional_directories_unsupported",
        message:
          "This runner does not advertise scoped additional directories, so the selected folders were not shared.",
      });
    }

    const wantMode = config.adapter?.sessionModeId;
    const timedRequest = <T = unknown>(
      method: string,
      params: unknown
    ): Promise<T> =>
      requestWithTimeout(
        conn.request<T>(method, params),
        stageTimeoutMs,
        method
      );
    if (wantMode && sessionId) {
      if (modeAvailable(modes, wantMode)) {
        await timedRequest(SET_MODE, { sessionId, modeId: wantMode }).catch(
          () => undefined
        );
      } else {
        emit({
          type: "notice",
          level: "warn",
          code: "permission_mode_unavailable",
          message:
            `This runner didn’t offer its non-interactive permission mode (${wantMode}), ` +
            `so tool use may stall waiting for an approval this surface can’t show.`,
        });
      }
    }

    const requestedModel = input.configPins?.model ?? input.model;
    activeModel = await pinModel({
      request: timedRequest,
      emit,
      sessionId: sessionId!,
      configOptions,
      requested: requestedModel,
      resolveModel: config.resolveModel,
    });
    activeEffort = await pinThoughtLevel({
      request: timedRequest,
      emit,
      sessionId: sessionId!,
      configOptions,
      requested: input.configPins?.thought_level,
    });

    const prompt: ContentBlock[] = [];
    if (input.extraSystemPrompt) {
      prompt.push({ type: "text", text: input.extraSystemPrompt });
    }
    const hydrationContext =
      continuity === "fresh" && input.prevSessionId
        ? (input.recoveryHydrationContext ?? input.hydrationContext)
        : input.hydrationContext;
    const shouldHydrate =
      Boolean(hydrationContext) &&
      (input.forceHydration === true ||
        (input.prevSessionId !== undefined && continuity === "fresh"));
    if (shouldHydrate && hydrationContext) {
      prompt.push({ type: "text", text: hydrationContext });
      hydrated = true;
      hydrationKind =
        continuity === "fresh" && input.prevSessionId ? "recovery" : "handoff";
      emit({
        type: "notice",
        level: "info",
        code: "session_hydrated",
        message:
          continuity === "fresh" && input.prevSessionId
            ? "The prior agent session could not resume. Started fresh and restored context from the conversation ledger."
            : "Switched agents and restored context from the conversation ledger.",
      });
      const historicalAttachments =
        hydrationKind === "recovery"
          ? input.recoveryHydrationAttachments
          : input.hydrationAttachments;
      if (historicalAttachments?.length) {
        const mapped = acpAttachmentBlocks(historicalAttachments, promptCaps);
        prompt.push(...mapped.blocks);
        if (mapped.skipped.length) {
          emit({
            type: "notice",
            level: "info",
            code: "hydration_attachment_described",
            message:
              `This runner can’t re-attach ${mapped.skipped.join(", ")}. ` +
              "Their names and media types remain in the conversation handoff.",
          });
        }
      }
    }
    prompt.push({ type: "text", text: input.message });

    if (input.attachments?.length) {
      const mapped = acpAttachmentBlocks(input.attachments, promptCaps);
      prompt.push(...mapped.blocks);
      if (mapped.skipped.length) {
        emit({
          type: "notice",
          level: "warn",
          code: "attachment_unsupported",
          message:
            `This runner can’t read ${mapped.skipped.length === 1 ? "this attachment" : "these attachments"}, ` +
            `so ${mapped.skipped.length === 1 ? "it was" : "they were"} skipped: ${mapped.skipped.join(", ")}.`,
        });
      }
    }

    // The persisted cumulative counters only apply when this turn really
    // continues the session they were recorded against.
    const resumeBaseline =
      continuity !== "fresh" &&
      input.prevSessionId !== undefined &&
      sessionId === input.prevSessionId
        ? input.prevUsageSnapshot
        : undefined;
    // Keep that baseline if the prompt never reports a total (killed child,
    // transport failure). Returning NO snapshot would CLEAR the stored
    // counters, so the next turn on this session would book the whole session
    // total a second time.
    usageSnapshot = resumeBaseline;

    promptStarted = true;
    const idleWatchdog = new Promise<never>((_resolve, reject) => {
      rejectPromptIdle = reject;
      touchPromptIdleWatchdog();
    });
    const promptResult = await Promise.race([
      conn.request<{ usage?: unknown; stopReason?: unknown }>(
        "session/prompt",
        {
          sessionId,
          prompt,
        }
      ),
      idleWatchdog,
    ]).finally(() => {
      rejectPromptIdle = undefined;
      clearPromptIdleWatchdog();
    });

    if (isObject(promptResult?.usage))
      stream.foldTokenUsage(promptResult.usage);
    const folded = stream.usage();
    const delta = deltaCumulativeUsage(
      folded.tokens,
      folded.cost,
      resumeBaseline,
      folded.context
    );
    // Only the session's live config option / confirmed pin is authoritative.
    // A requested model may be ignored or refused and must never be stamped.
    const usageEvent = buildUsageEvent(
      config.kind,
      activeModel,
      activeEffort,
      delta.tokens,
      delta.cost
    );
    // Accounting is NOT cancellable. ACP session usage is cumulative, so the
    // booked delta and the persisted snapshot have to advance together or not
    // at all: dropping the event on an aborted turn while still advancing the
    // snapshot would book the cancelled turn's tokens to nobody, and every
    // later turn would subtract a baseline it was never charged for. Bypass
    // `emit`'s abort gate — the consumer folds post-abort events (it still
    // receives the `aborted` event below through the same channel).
    if (usageEvent) input.onEvent(usageEvent);
    usageSnapshot = delta.snapshot;

    if (!input.abortSignal.aborted) {
      const stop = outcomeForStopReason(promptResult?.stopReason);
      const rawJson = JSON.stringify(promptResult ?? {});
      const stopReason =
        typeof promptResult?.stopReason === "string"
          ? promptResult.stopReason
          : undefined;
      if (stop.notice) emit(stop.notice);
      if (stop.error) {
        emit({
          ...stop.error,
          ...(stopReason === undefined ? {} : { stopReason }),
          rawJson,
        });
      } else if (stop.emitFinal) {
        emit({
          type: "final",
          text: stream.finalText(),
          ...(stopReason === undefined ? {} : { stopReason }),
          rawJson,
        });
      }
      parkWarm =
        Boolean(sessionId) &&
        (canResume || canLoad) &&
        !stop.error &&
        (promptResult?.stopReason === "end_turn" ||
          promptResult?.stopReason === undefined ||
          promptResult?.stopReason === "max_tokens" ||
          promptResult?.stopReason === "max_turn_requests");
    }
  } catch (error) {
    parkWarm = false;
    if (!input.abortSignal.aborted) {
      const failure = classifyAgentFailureDetail(
        error,
        conn.stderrTail(),
        config
      );
      emit({
        type: "error",
        message: failure.message,
        failureClass: failure.failureClass,
      });
    }
  } finally {
    rejectPromptIdle = undefined;
    clearPromptIdleWatchdog();
    await vaultMcp?.close();

    if (
      parkWarm &&
      sessionId &&
      !input.abortSignal.aborted &&
      !conn.hasExited()
    ) {
      putWarmSlot({
        kind: config.kind,
        ...(input.conversationId
          ? { conversationId: input.conversationId }
          : {}),
        cwd: input.cwd,
        sessionId,
        child,
        conn,
        canResume,
        canLoad,
        canClose,
        canAdditional,
        httpMcp,
        promptCaps: promptCaps as Record<string, unknown>,
      });
    } else {
      if (canClose && sessionId && !conn.hasExited()) {
        try {
          await requestWithTimeout(
            conn.request("session/close", { sessionId }),
            stageTimeoutMs,
            "session/close"
          );
        } catch {
          // ignore
        }
      }
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      if (!child.killed) child.kill("SIGTERM");
      const exited = await requestWithTimeout(
        // A rejected `exited` still means the process is gone.
        conn.exited.then(
          () => true,
          () => true
        ),
        stageTimeoutMs,
        "process exit"
      ).catch(() => false);
      if (!exited) {
        // SIGTERM is a request. An agent that ignores it would otherwise leak
        // one child per turn for the lifetime of the gateway.
        child.kill("SIGKILL");
        await conn.exited.catch(() => undefined);
      }
    }

    input.abortSignal.removeEventListener("abort", abortHandler);
  }

  const spawnError = conn.spawnError();
  if (input.abortSignal.aborted) input.onEvent({ type: "aborted" });
  else if (spawnError) {
    input.onEvent({
      type: "error",
      message: spawnError.message,
      failureClass: "spawn",
    });
  }

  return sessionId
    ? {
        sessionId,
        ...(usageSnapshot ? { usageSnapshot } : {}),
        ...(hydrated ? { hydrated: true } : {}),
        ...(hydrationKind ? { hydrationKind } : {}),
      }
    : {};
}
