/*
 * governance: allow-repo-hygiene file-size-limit (#567) the generic ACP lifecycle is one ordered initialize/configure/resume/prompt/settle state machine; splitting its transaction would scatter failure cleanup and confirmed-state accounting
 *
 * Generic ACP (Agent Client Protocol) backend — the ONE integration path
 * for every harness kind (#479).
 *
 * Turn flow: launch (or warm reuse) → initialize → session resume|load|new →
 * pin mode/model → session/prompt → stopReason handling → warm park or kill.
 */

import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import { promises as fs } from "node:fs";
import type { Readable, Writable } from "node:stream";

import { methods } from "@agentclientprotocol/sdk";
import type {
  AgentRequestMethod,
  AgentRequestParamsByMethod,
  AgentRequestResponsesByMethod,
  LoadSessionRequest,
  McpServer,
  NewSessionRequest,
  ResumeSessionRequest,
  SessionConfigOption,
  SessionModeState,
  SendRequestOptions,
} from "@agentclientprotocol/sdk";

import type { TurnStreamEvent } from "@centraid/server/engine";

import { unrefTimer } from "../../../lib/unref-timer.js";
import { lowPriorityCommand } from "../../low-priority.js";
import { acpAttachmentBlocks } from "../../multimodal.js";
import type { ContentBlock, PromptCapabilities } from "../../multimodal.js";
import { ACP_PROTOCOL_VERSION, createAcpConnection } from "./connection.js";
import type { AcpConnectionOwner, AcpTurnHandlers } from "./connection.js";
import { classifyHarnessFailureDetail } from "./harness-errors.js";
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
import type { AcpBuiltinRequest } from "./session-config.js";
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
const EXIT_CLASSIFICATION_GRACE_MS = 250;

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
    unrefTimer(timer);
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
    const failure = classifyHarnessFailureDetail(error, "", config);
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
  let child!: ChildProcessByStdio<Writable, Readable, Readable>;
  let conn!: AcpConnectionOwner;
  let releaseTurnOwner = (): void => undefined;
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
  let modes: SessionModeState | undefined;
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
    unrefTimer(promptIdleTimer);
  };

  const emit = (event: TurnStreamEvent): void => {
    if (input.abortSignal.aborted) return;
    input.onEvent(event);
  };

  const stream = createSessionUpdateMapper(emit);

  const makeHandlers = (): AcpTurnHandlers => ({
    requestPermission: (params) => {
      touchPromptIdleWatchdog();
      if (input.abortSignal.aborted) {
        return { outcome: { outcome: "cancelled" } };
      }
      const toolTitle = readPermissionToolTitle(params);
      const options = readPermissionOptions(params);
      if (input.permissionPolicy === "deny") {
        emit(permissionDeniedNotice(toolTitle));
        const rejectId = pickRejectPermissionOption(options);
        return rejectId
          ? { outcome: { outcome: "selected", optionId: rejectId } }
          : { outcome: { outcome: "cancelled" } };
      }
      const optionId = pickPermissionOption(options);
      if (optionId) {
        emit(permissionAutoAllowNotice(optionId, options, toolTitle));
        return { outcome: { outcome: "selected", optionId } };
      }
      return { outcome: { outcome: "cancelled" } };
    },
    sessionUpdate: (params) => {
      touchPromptIdleWatchdog();
      const optionUpdate = readConfigOptionUpdate(params);
      if (optionUpdate) {
        configOptions = optionUpdate;
        activeModel = readCurrentConfigValue(configOptions, "model");
        activeEffort = readCurrentConfigValue(configOptions, "thought_level");
      }
      if (!promptStarted) return;
      stream.handleSessionUpdate(params);
    },
  });

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
      promptCaps = warm.promptCaps;
      continuity = "warm";
      releaseTurnOwner = conn.bindTurn(makeHandlers());
    }
  }

  if (!reusedWarm) {
    const command = lowPriorityCommand(launch.bin, launch.args);
    child = spawn(command.bin, command.args, {
      cwd: input.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessByStdio<Writable, Readable, Readable>;
    conn = createAcpConnection(child);
    releaseTurnOwner = conn.bindTurn(makeHandlers());
  }

  const abortHandler = (): void => {
    parkWarm = false;
    if (sessionId && !conn.hasExited()) {
      try {
        void conn
          .notify(methods.agent.session.cancel, { sessionId })
          .catch(() => undefined);
      } catch {
        // Intentionally empty.
      }
    }
    if (!child.killed) child.kill("SIGTERM");
  };
  if (input.abortSignal.aborted) abortHandler();
  else
    input.abortSignal.addEventListener("abort", abortHandler, { once: true });

  const additionalDirectories = (): string[] | undefined =>
    canAdditional && input.additionalDirectories?.length
      ? input.additionalDirectories
      : undefined;
  const newSessionRequest = (mcpServers: McpServer[]): NewSessionRequest => ({
    cwd: input.cwd,
    mcpServers,
    ...(additionalDirectories()
      ? { additionalDirectories: additionalDirectories() }
      : {}),
  });
  const loadSessionRequest = (
    requestedSessionId: string,
    mcpServers: McpServer[]
  ): LoadSessionRequest => ({
    sessionId: requestedSessionId,
    cwd: input.cwd,
    mcpServers,
    ...(additionalDirectories()
      ? { additionalDirectories: additionalDirectories() }
      : {}),
  });
  const resumeSessionRequest = (
    requestedSessionId: string,
    mcpServers: McpServer[]
  ): ResumeSessionRequest => ({
    sessionId: requestedSessionId,
    cwd: input.cwd,
    mcpServers,
    ...(additionalDirectories()
      ? { additionalDirectories: additionalDirectories() }
      : {}),
  });

  try {
    if (reusedWarm) {
      for (const notice of pendingNotices) emit(notice);
      const vaultTools = await startTurnVaultTools({
        toolContext: input.toolContext,
        httpMcp,
        emit,
        harnessStreamsTool: stream.harnessStreamsTool,
      });
      vaultMcp = vaultTools.handle;
      const mcpServers = vaultTools.mcpServers;
      const sid = sessionId!;
      try {
        if (canResume) {
          const resumed = await requestWithTimeout(
            conn.request(
              methods.agent.session.resume,
              resumeSessionRequest(sid, mcpServers)
            ),
            stageTimeoutMs,
            "session/resume"
          );
          configOptions = readConfigOptions(resumed);
          modes = resumed?.modes ?? undefined;
        } else if (canLoad) {
          const loaded = await requestWithTimeout(
            conn.request(
              methods.agent.session.load,
              loadSessionRequest(sid, mcpServers)
            ),
            stageTimeoutMs,
            "session/load"
          );
          configOptions = readConfigOptions(loaded);
          modes = loaded?.modes ?? undefined;
        }
      } catch {
        const created = await requestWithTimeout(
          conn.request(
            methods.agent.session.new,
            newSessionRequest(mcpServers)
          ),
          stageTimeoutMs,
          "session/new after resume failure"
        );
        const freshId =
          typeof created?.sessionId === "string"
            ? created.sessionId
            : undefined;
        if (!freshId)
          throw new Error(
            "ACP harness did not return a sessionId after resume failure"
          );
        configOptions = readConfigOptions(created);
        modes = created?.modes ?? undefined;
        sessionId = freshId;
        continuity = "fresh";
        emit({
          type: "notice",
          level: "warn",
          code: "session_resume_self_heal",
          message:
            "The harness lost its saved session — Centraid restored the conversation from its ledger.",
        });
      }
    } else {
      const init = await requestWithTimeout(
        conn.request(methods.agent.initialize, {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "centraid-local-harness",
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
      promptCaps = init.agentCapabilities?.promptCapabilities ?? {};
      httpMcp = init?.agentCapabilities?.mcpCapabilities?.http === true;

      for (const notice of pendingNotices) emit(notice);

      const vaultTools = await startTurnVaultTools({
        toolContext: input.toolContext,
        httpMcp,
        emit,
        harnessStreamsTool: stream.harnessStreamsTool,
      });
      vaultMcp = vaultTools.handle;
      const mcpServers = vaultTools.mcpServers;

      if (input.prevSessionId && canResume) {
        try {
          const resumed = await requestWithTimeout(
            conn.request(
              methods.agent.session.resume,
              resumeSessionRequest(input.prevSessionId, mcpServers)
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
            conn.request(
              methods.agent.session.load,
              loadSessionRequest(input.prevSessionId, mcpServers)
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
          conn.request(
            methods.agent.session.new,
            newSessionRequest(mcpServers)
          ),
          stageTimeoutMs,
          "session/new"
        );
        const id =
          typeof created?.sessionId === "string"
            ? created.sessionId
            : undefined;
        if (!id) throw new Error("ACP harness did not return a sessionId");
        configOptions = readConfigOptions(created);
        modes = created?.modes ?? undefined;
        sessionId = id;
        continuity = "fresh";
        if (selfHealed) {
          emit({
            type: "notice",
            level: "warn",
            code: "session_resume_self_heal",
            message:
              "The harness lost its saved session — Centraid restored the conversation from its ledger.",
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
          "This harness does not advertise scoped additional directories, so the selected folders were not shared.",
      });
    }

    const wantMode = config.adapter?.sessionModeId;
    const timedRequest: AcpBuiltinRequest = <Method extends AgentRequestMethod>(
      method: Method,
      params: AgentRequestParamsByMethod[Method],
      options?: SendRequestOptions
    ): Promise<AgentRequestResponsesByMethod[Method]> =>
      requestWithTimeout(
        conn.request(method, params, options),
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
            `This harness didn’t offer its non-interactive permission mode (${wantMode}), ` +
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
            ? "The prior harness session could not resume — context restored from the conversation ledger."
            : "Switched harnesses and restored context from the conversation ledger.",
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
              `This harness can’t re-attach ${mapped.skipped.join(", ")}. ` +
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
            `This harness can’t read ${mapped.skipped.length === 1 ? "this attachment" : "these attachments"}, ` +
            `so ${mapped.skipped.length === 1 ? "it was" : "they were"} skipped: ${mapped.skipped.join(", ")}.`,
        });
      }
    }

    const resumeBaseline =
      continuity !== "fresh" &&
      input.prevSessionId !== undefined &&
      sessionId === input.prevSessionId
        ? input.prevUsageSnapshot
        : undefined;
    usageSnapshot = resumeBaseline;

    promptStarted = true;
    const idleWatchdog = new Promise<never>((_resolve, reject) => {
      rejectPromptIdle = reject;
      touchPromptIdleWatchdog();
    });
    const promptResult = await Promise.race([
      conn.request(methods.agent.session.prompt, {
        sessionId: sessionId!,
        prompt,
      }),
      idleWatchdog,
    ]).finally(() => {
      rejectPromptIdle = undefined;
      clearPromptIdleWatchdog();
    });

    if (promptResult.usage) stream.foldTokenUsage(promptResult.usage);
    const folded = stream.usage();
    const delta = deltaCumulativeUsage(
      folded.tokens,
      folded.cost,
      resumeBaseline,
      folded.context
    );
    const usageEvent = buildUsageEvent(
      config.kind,
      activeModel,
      activeEffort,
      delta.tokens,
      delta.cost
    );
    if (usageEvent) input.onEvent(usageEvent);
    usageSnapshot = delta.snapshot;

    if (!input.abortSignal.aborted) {
      const stop = outcomeForStopReason(promptResult.stopReason);
      const rawJson = JSON.stringify(promptResult);
      const stopReason = promptResult.stopReason;
      if (stop.notice) emit(stop.notice);
      if (stop.error) {
        emit({
          ...stop.error,
          stopReason,
          rawJson,
        });
      } else if (stop.emitFinal) {
        emit({
          type: "final",
          text: stream.finalText(),
          stopReason,
          rawJson,
        });
      }
      parkWarm =
        Boolean(sessionId) &&
        (canResume || canLoad) &&
        !stop.error &&
        (promptResult.stopReason === "end_turn" ||
          promptResult.stopReason === "max_tokens" ||
          promptResult.stopReason === "max_turn_requests");
    }
  } catch (error) {
    parkWarm = false;
    if (!input.abortSignal.aborted) {
      let failure = classifyHarnessFailureDetail(
        error,
        conn.stderrTail(),
        config
      );
      if (failure.failureClass === "unknown" && !conn.hasExited()) {
        await Promise.race([
          conn.exited,
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, EXIT_CLASSIFICATION_GRACE_MS);
            unrefTimer(timer);
          }),
        ]);
      }
      if (failure.failureClass === "unknown" && conn.hasExited()) {
        const spawnError = conn.spawnError();
        if (spawnError) {
          const spawnFailure = classifyHarnessFailureDetail(
            spawnError,
            conn.stderrTail(),
            config
          );
          failure =
            spawnFailure.failureClass === "unknown"
              ? { ...spawnFailure, failureClass: "spawn" }
              : spawnFailure;
        } else {
          failure = { ...failure, failureClass: "exit" };
        }
      }
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
    releaseTurnOwner();

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
        promptCaps,
      });
    } else {
      if (canClose && sessionId && !conn.hasExited()) {
        try {
          await requestWithTimeout(
            conn.request(methods.agent.session.close, { sessionId }),
            stageTimeoutMs,
            "session/close"
          );
        } catch {
          // Intentionally empty.
        }
      }
      try {
        child.stdin.end();
      } catch {
        // Intentionally empty.
      }
      if (!child.killed) child.kill("SIGTERM");
      const exited = await requestWithTimeout(
        conn.exited.then(
          () => true,
          () => true
        ),
        stageTimeoutMs,
        "process exit"
      ).catch(() => false);
      if (!exited) {
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
