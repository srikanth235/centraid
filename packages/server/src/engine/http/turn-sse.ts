/*
 * governance: allow-repo-hygiene file-size-limit (#567) transport, durable lock, hydration, artifact fold, and ledger settlement form one turn transaction whose cleanup ordering must stay visible together
 *
 * The transport-and-ledger half of every `_turn`-shaped route: the stream, the
 * accumulator, the per-(appId, conversationId) lock, `recordTurn`, the `end`
 * frame. Routes keep only their own lookups and prompt assembly.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { unrefTimer } from "../../lib/unref-timer.js";
import { HarnessSessions } from "../conversation/harness-sessions.js";
import type {
  ConversationHistoryStore,
  ConversationTurnAttachment,
  TurnNode,
} from "../conversation/history.js";
import type {
  ConversationTurnInput,
  ConversationRunner,
  TurnStreamEvent,
} from "../conversation/runner.js";
import type * as TypeImport_wkgbyq from "../conversation/schema.js";
import type * as TypeImport_nu6ai6 from "../conversation/turn.js";
import { costForUsage } from "../model-pricing.js";
import { SseStream } from "./sse-stream.js";
import { writeTurnBusy } from "./turn-limiter.js";
import type { TurnLimiter } from "./turn-limiter.js";
import { buildReplayEvents } from "./turn-replay.js";
import { withConversationLock } from "./turn-sse-support.js";
import type { TurnAttachmentRef } from "./turn-sse-support.js";

type ToolTurnNode = Extract<TurnNode, { kind: "tool" }>;

function pathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

async function workspaceArtifact(
  reportedPath: string,
  roots: readonly string[],
  onSkipped: (workspacePath: string, reason: string) => void
): Promise<
  | {
      hash: string;
      mime: string;
      sizeBytes: number;
      source: "harness";
      filename: string;
      workspacePath: string;
    }
  | undefined
> {
  const decoded = reportedPath.startsWith("file:")
    ? fileURLToPath(reportedPath)
    : reportedPath;
  const base = roots[0] ?? process.cwd();
  const requested = path.isAbsolute(decoded)
    ? decoded
    : path.resolve(base, decoded);
  let candidate: string;
  try {
    candidate = await fs.realpath(requested);
    const allowedRoots = await Promise.all(
      roots.map((root) => fs.realpath(root).catch(() => path.resolve(root)))
    );
    if (!allowedRoots.some((root) => pathInside(candidate, root)))
      return undefined;
  } catch {
    return undefined;
  }
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return undefined;
    if (stat.size > MAX_ARTIFACT_BYTES) {
      onSkipped(
        candidate,
        `it is larger than the ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MiB cap`
      );
      return undefined;
    }
    const bytes = await fs.readFile(candidate);
    return {
      hash: createHash("sha256").update(bytes).digest("hex"),
      mime: "application/octet-stream",
      sizeBytes: stat.size,
      source: "harness",
      filename: path.basename(candidate),
      workspacePath: candidate,
    };
  } catch (error) {
    onSkipped(
      candidate,
      error instanceof Error ? error.message : String(error)
    );
    return undefined;
  }
}

export {
  parseAdditionalDirectories,
  parseWorkspaceKind,
  parseTurnAttachmentRefs,
  resolveTurnAttachments,
  validateTurnAttachmentRefs,
  withConversationLock,
} from "./turn-sse-support.js";
export type { TurnAttachmentRef } from "./turn-sse-support.js";

export interface DriveTurnOptions {
  req: IncomingMessage;
  res: ServerResponse;
  appId: string;
  conversationId: string;
  message: string;
  dataDir: string;
  workspaceDirectory?: string;
  workspaceKind?: TypeImport_wkgbyq.ConversationWorkspaceKind;
  extraSystemPrompt: string;
  runner: ConversationRunner;
  conversationStore?: ConversationHistoryStore | undefined;
  conversationHarnessSessionDir: string;
  conversationLocks: Map<string, Promise<void>>;
  banner: string;
  register?: "ask" | "build" | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  harnessKind?: TypeImport_nu6ai6.HarnessKind | undefined;
  providerConsent?:
    | TypeImport_nu6ai6.HarnessKind
    | readonly TypeImport_nu6ai6.HarnessKind[]
    | undefined;
  additionalDirectories?: string[];
  idempotencyKey?: string | undefined;
  limiter?: TurnLimiter | undefined;
  retryOf?: string | undefined;
  prevHarnessSessionId?: string | undefined;
  prevHarnessKind?: string | undefined;
  prevHarnessUsageSnapshot?: TypeImport_nu6ai6.HarnessUsageSnapshot | undefined;
  attachmentRefs?: TurnAttachmentRef[];
  turnAttachments?: { path: string; mime: string; filename?: string }[];
  generateTitle?: (args: {
    conversationId: string;
    userMessage: string;
    assistantText: string;
  }) => void;
}

export async function driveTurnOverSse(opts: DriveTurnOptions): Promise<void> {
  const { res } = opts;

  const releaseSlot = opts.limiter?.tryAcquire();
  if (opts.limiter && !releaseSlot) {
    writeTurnBusy(res);
    return;
  }
  try {
    await driveTurnInner(opts);
  } finally {
    releaseSlot?.();
  }
}

async function driveTurnInner(opts: DriveTurnOptions): Promise<void> {
  const {
    req,
    res,
    appId,
    conversationId,
    message,
    runner,
    conversationStore,
  } = opts;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const stream = new SseStream(res);
  stream.comment(opts.banner);
  const heartbeat = setInterval(() => {
    stream.comment("ping");
  }, 30_000);
  unrefTimer(heartbeat);

  const writeEvent = (event: TurnStreamEvent): void => {
    stream.event(event.type, JSON.stringify(event));
  };

  const turnStartedAt = Date.now();
  const acc = {
    aiText: "",
    finalText: undefined as string | undefined,
    errorMessage: undefined as string | undefined,
    consentRequired: false,
    pending: new Map<
      string,
      { toolName: string; sql?: string; args?: unknown; startedAt: number }
    >(),
    toolNodes: [] as TurnNode[],
    artifactCandidates: [] as Array<{
      node: ToolTurnNode;
      locations: Array<{ path: string; line?: number }>;
      inline: Array<{ dataBase64: string; mime: string; filename?: string }>;
    }>,
    usage: undefined as
      | {
          model?: string;
          harness?: string;
          effort?: string;
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          costUsd?: number;
          costSource?: "harness" | "estimated";
        }
      | undefined,
  };
  const accumulate = (event: TurnStreamEvent): void => {
    switch (event.type) {
      case "assistant.delta":
        acc.aiText += event.delta;
        return;
      case "tool.start":
        acc.pending.set(event.toolCallId, {
          toolName: event.toolName,
          ...(event.sql === undefined ? {} : { sql: event.sql }),
          ...(event.args === undefined ? {} : { args: event.args }),
          startedAt: Date.now(),
        });
        return;
      case "tool.result": {
        const pending = acc.pending.get(event.toolCallId);
        acc.pending.delete(event.toolCallId);
        const node: ToolTurnNode = {
          kind: "tool",
          toolName: event.toolName || pending?.toolName || "tool",
          ...(pending?.sql === undefined ? {} : { sql: pending.sql }),
          ...(pending?.args === undefined ? {} : { args: pending.args }),
          ok: event.ok,
          ...(event.result === undefined ? {} : { result: event.result }),
          ...(event.ok ? {} : { errorText: event.errorText ?? "Tool failed." }),
          appId,
          startedAt: pending?.startedAt ?? Date.now(),
          endedAt: Date.now(),
        };
        acc.toolNodes.push(node);
        if (event.locations?.length || event.artifacts?.length) {
          acc.artifactCandidates.push({
            node,
            locations: event.locations ?? [],
            inline: event.artifacts ?? [],
          });
        }
        return;
      }
      case "final":
        acc.finalText = acc.aiText || event.text;
        return;
      case "usage":
        acc.usage = {
          ...(event.model === undefined ? {} : { model: event.model }),
          ...(event.harness === undefined ? {} : { harness: event.harness }),
          ...(event.effort === undefined ? {} : { effort: event.effort }),
          ...(event.inputTokens === undefined
            ? {}
            : { inputTokens: event.inputTokens }),
          ...(event.outputTokens === undefined
            ? {}
            : { outputTokens: event.outputTokens }),
          ...(event.cacheReadTokens === undefined
            ? {}
            : { cacheReadTokens: event.cacheReadTokens }),
          ...(event.cacheWriteTokens === undefined
            ? {}
            : { cacheWriteTokens: event.cacheWriteTokens }),
          ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
          ...(event.costSource === undefined
            ? {}
            : { costSource: event.costSource }),
        };
        return;
      case "error":
        acc.errorMessage = event.message;
        break;
      case "consent.required":
        acc.consentRequired = true;
        break;
      case "notice": {
        const at = Date.now();
        acc.toolNodes.push({
          kind: "step",
          text: event.message,
          notice: {
            level: event.level,
            ...(event.code ? { code: event.code } : {}),
          },
          startedAt: at,
          endedAt: at,
        });
        break;
      }
      case "assistant.start":
      case "reasoning.delta":
      case "context":
      case "phase":
      case "aborted":
      case "webhooks":
        break;
    }
  };
  const onEvent = (event: TurnStreamEvent): void => {
    let priced = event;
    if (priced.type === "usage") {
      if (priced.costUsd !== undefined && priced.costSource === undefined) {
        priced = { ...priced, costSource: "harness" };
      } else if (priced.costUsd === undefined) {
        const costUsd = costForUsage(priced.model, priced);
        if (costUsd !== undefined) {
          priced = { ...priced, costUsd, costSource: "estimated" };
        }
      }
    }
    accumulate(priced);
    writeEvent(priced);
  };

  const abortController = new AbortController();
  const onClientClose = (): void => {
    if (!abortController.signal.aborted) abortController.abort();
  };
  req.on("close", onClientClose);
  req.on("error", onClientClose);

  const sessionFile = path.join(
    opts.conversationHarnessSessionDir,
    `${conversationId}.jsonl`
  );
  await fs
    .mkdir(opts.conversationHarnessSessionDir, { recursive: true })
    .catch(() => undefined);
  await withConversationLock(
    opts.conversationLocks,
    appId,
    conversationId,
    async () => {
      const lockToken = randomUUID();
      if (
        conversationStore &&
        !conversationStore.acquireTurnLock(appId, conversationId, lockToken)
      ) {
        onEvent({
          type: "error",
          message:
            "This conversation is already running a turn in another process.",
        });
        clearInterval(heartbeat);
        req.off("close", onClientClose);
        req.off("error", onClientClose);
        stream.event("end", "{}");
        stream.end();
        return;
      }
      const lockLeaseHeartbeat = conversationStore
        ? setInterval(
            () =>
              conversationStore.refreshTurnLock(
                appId,
                conversationId,
                lockToken
              ),
            60_000
          )
        : undefined;
      unrefTimer(lockLeaseHeartbeat);
      try {
        if (opts.idempotencyKey && conversationStore) {
          const recorded = conversationStore.findRecordedTurn(
            appId,
            conversationId,
            opts.idempotencyKey
          );
          if (recorded) {
            for (const ev of buildReplayEvents(recorded)) writeEvent(ev);
            clearInterval(heartbeat);
            req.off("close", onClientClose);
            req.off("error", onClientClose);
            stream.event("end", "{}");
            stream.end();
            return;
          }
        }
        const conversationMeta = conversationStore?.getSessionMeta(
          appId,
          conversationId
        );
        const targetHarnessKind =
          opts.harnessKind ?? (await runner.resolveHarnessKind?.());
        const harnessSessions = conversationStore
          ? new HarnessSessions({
              binding: (kind) => {
                const state = conversationStore.getHarnessResumeState(
                  appId,
                  conversationId,
                  kind
                );
                return state?.sessionId
                  ? {
                      sessionId: state.sessionId,
                      ...(state.bindingId
                        ? { bindingId: state.bindingId }
                        : {}),
                      ...(state.usageSnapshot
                        ? { usageSnapshot: state.usageSnapshot }
                        : {}),
                      ...(state.hydratedThroughSeq === undefined
                        ? {}
                        : { hydratedThroughSeq: state.hydratedThroughSeq }),
                    }
                  : undefined;
              },
              messages: (afterSeq) =>
                conversationStore.getHydrationDelta(
                  appId,
                  conversationId,
                  afterSeq
                )?.messages ?? [],
              attachmentPath: (hash) =>
                conversationStore.blobPathFor(appId, hash),
            })
          : undefined;
        const legacyResume =
          !targetHarnessKind && conversationStore
            ? conversationStore.getHarnessResumeState(appId, conversationId)
            : undefined;
        const resume = targetHarnessKind
          ? harnessSessions?.plan(targetHarnessKind)
          : legacyResume;
        const planFor = (kind: TypeImport_nu6ai6.HarnessKind) =>
          harnessSessions?.plan(kind);
        const input: ConversationTurnInput = {
          appId,
          dataDir: opts.dataDir,
          conversationId,
          sessionFile,
          message,
          ...(opts.register ? { register: opts.register } : {}),
          ...(opts.turnAttachments?.length
            ? { attachments: opts.turnAttachments }
            : {}),
          extraSystemPrompt: opts.extraSystemPrompt,
          abortSignal: abortController.signal,
          onEvent,
          ...(targetHarnessKind ? { harnessKind: targetHarnessKind } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.thinking ? { thinking: opts.thinking } : {}),
          ...(opts.providerConsent && opts.providerConsent.length > 0
            ? { providerConsent: opts.providerConsent }
            : {}),
          ...(opts.additionalDirectories?.length
            ? { additionalDirectories: opts.additionalDirectories }
            : {}),
          ...(opts.workspaceDirectory
            ? { workspaceDirectory: opts.workspaceDirectory }
            : {}),
          ...(opts.workspaceKind ? { workspaceKind: opts.workspaceKind } : {}),
          ...(opts.idempotencyKey
            ? { idempotencyKey: opts.idempotencyKey }
            : {}),
          ...(conversationMeta?.harnessKind
            ? { activeHarnessKind: conversationMeta.harnessKind }
            : {}),
          ...(resume?.sessionId
            ? {
                prevHarnessSessionId: resume.sessionId,
                prevBindingId: resume.bindingId,
              }
            : opts.prevHarnessSessionId
              ? { prevHarnessSessionId: opts.prevHarnessSessionId }
              : {}),
          ...((targetHarnessKind ?? legacyResume?.kind)
            ? { prevHarnessKind: targetHarnessKind ?? legacyResume?.kind }
            : opts.prevHarnessKind
              ? { prevHarnessKind: opts.prevHarnessKind }
              : {}),
          ...(resume?.usageSnapshot
            ? { prevHarnessUsageSnapshot: resume.usageSnapshot }
            : opts.prevHarnessUsageSnapshot
              ? { prevHarnessUsageSnapshot: opts.prevHarnessUsageSnapshot }
              : {}),
          ...(conversationStore ? { resumeForKind: planFor } : {}),
        };
        let runResult:
          | {
              harnessSessionId?: string;
              harnessKind?: string;
              harnessUsageSnapshot?: TypeImport_nu6ai6.HarnessUsageSnapshot;
              hydrated?: boolean;
              hydrationKind?: "handoff" | "recovery";
              hydrationTokens?: number;
            }
          | undefined;
        try {
          const out = await runner.run(input);
          runResult = out ?? undefined;
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          onEvent({ type: "error", message: msg });
        } finally {
          clearInterval(heartbeat);
          req.off("close", onClientClose);
          req.off("error", onClientClose);
          if (conversationStore && !acc.consentRequired) {
            if (
              runResult?.hydrationKind === "recovery" &&
              runResult.harnessKind
            ) {
              const dead = harnessSessions?.plan(
                runResult.harnessKind as TypeImport_nu6ai6.HarnessKind
              );
              if (
                dead?.bindingId &&
                dead.sessionId !== runResult.harnessSessionId
              ) {
                conversationStore.markAdapterBindingStale(
                  appId,
                  conversationId,
                  dead.bindingId
                );
              }
            }
            const wasUnnamed =
              conversationStore.getSessionMeta(appId, conversationId)?.title ===
              "";
            try {
              const endedAt = Date.now();
              const roots = [
                opts.workspaceDirectory ?? opts.dataDir,
                ...(opts.additionalDirectories ?? []),
              ];
              const attachNextCandidate = async (
                index: number
              ): Promise<void> => {
                const candidate = acc.artifactCandidates[index];
                if (!candidate) return;
                const artifacts: ConversationTurnAttachment[] = (
                  await Promise.all(
                    candidate.locations.map((location) =>
                      workspaceArtifact(
                        location.path,
                        roots,
                        (workspacePath, reason) =>
                          onEvent({
                            type: "notice",
                            level: "warn",
                            code: "artifact_unavailable",
                            message: `Could not attach ${path.basename(workspacePath)} to this turn: ${reason}.`,
                          })
                      )
                    )
                  )
                ).filter((artifact) => artifact !== undefined);
                const uploadNextInline = async (
                  inlineIndex: number
                ): Promise<void> => {
                  const inline = candidate.inline[inlineIndex];
                  if (!inline) return;
                  try {
                    const bytes = Buffer.from(inline.dataBase64, "base64");
                    if (
                      bytes.byteLength === 0 ||
                      bytes.byteLength > 25 * 1024 * 1024
                    )
                      return uploadNextInline(inlineIndex + 1);
                    const stored = await conversationStore.uploadBlob(
                      appId,
                      bytes
                    );
                    artifacts.push({
                      hash: stored.hash,
                      mime: inline.mime,
                      sizeBytes: stored.sizeBytes,
                      source: "harness",
                      filename: inline.filename ?? "harness-artifact",
                    });
                  } catch {
                    // Intentionally empty.
                  }
                  return uploadNextInline(inlineIndex + 1);
                };
                await uploadNextInline(0);
                if (artifacts.length > 0) candidate.node.artifacts = artifacts;
                return attachNextCandidate(index + 1);
              };
              await attachNextCandidate(0);
              const nodes: TurnNode[] = [...acc.toolNodes];
              const usage = acc.usage ?? {};
              if (acc.errorMessage !== undefined) {
                nodes.push({
                  kind: "step",
                  text: acc.errorMessage,
                  isError: true,
                  ...usage,
                  startedAt: turnStartedAt,
                  endedAt,
                });
              } else if (acc.finalText && acc.finalText.trim().length > 0) {
                nodes.push({
                  kind: "step",
                  text: acc.finalText,
                  ...usage,
                  startedAt: turnStartedAt,
                  endedAt,
                });
              }
              conversationStore.recordTurn(appId, {
                conversationId,
                ...(runner.runKind ? { kind: runner.runKind } : {}),
                ...(opts.retryOf === undefined
                  ? {}
                  : { retryOf: opts.retryOf }),
                ...(opts.idempotencyKey === undefined
                  ? {}
                  : { idempotencyKey: opts.idempotencyKey }),
                userMessage: message,
                ...(opts.attachmentRefs?.length
                  ? {
                      attachments: opts.attachmentRefs.map((a) => ({
                        hash: a.hash,
                        mime: a.mime,
                        sizeBytes: a.sizeBytes ?? 0,
                        ...(a.filename === undefined
                          ? {}
                          : { filename: a.filename }),
                      })),
                    }
                  : {}),
                startedAt: turnStartedAt,
                endedAt,
                ok: acc.errorMessage === undefined,
                ...(acc.errorMessage === undefined
                  ? {}
                  : { error: acc.errorMessage }),
                ...(acc.finalText === undefined
                  ? {}
                  : { finalText: acc.finalText }),
                nodes,
                ...(runResult?.hydrationTokens === undefined
                  ? {}
                  : { hydrationTokens: runResult.hydrationTokens }),
                ...(acc.errorMessage === undefined && runResult?.harnessKind
                  ? {
                      harnessObservation: {
                        kind: runResult.harnessKind,
                        ...(runResult.harnessSessionId
                          ? { sessionId: runResult.harnessSessionId }
                          : {}),
                        ...(runResult.harnessUsageSnapshot
                          ? { usageSnapshot: runResult.harnessUsageSnapshot }
                          : {}),
                        ...(runResult.hydrated ? { hydrated: true } : {}),
                      },
                    }
                  : {}),
                ...(acc.errorMessage !== undefined && runResult?.harnessKind
                  ? {
                      failedHarnessObservation: {
                        kind: runResult.harnessKind,
                        ...(runResult.harnessSessionId
                          ? { sessionId: runResult.harnessSessionId }
                          : {}),
                        ...(runResult.harnessUsageSnapshot
                          ? { usageSnapshot: runResult.harnessUsageSnapshot }
                          : {}),
                        ...(runResult.hydrated ? { hydrated: true } : {}),
                      },
                    }
                  : {}),
              });
            } catch {
              // Intentionally empty.
            }
            if (
              wasUnnamed &&
              opts.generateTitle &&
              acc.errorMessage === undefined &&
              acc.finalText &&
              acc.finalText.trim().length > 0
            ) {
              try {
                opts.generateTitle({
                  conversationId,
                  userMessage: message,
                  assistantText: acc.finalText,
                });
              } catch {
                // Intentionally empty.
              }
            }
          }
          stream.event("end", "{}");
          stream.end();
        }
      } finally {
        if (lockLeaseHeartbeat) clearInterval(lockLeaseHeartbeat);
        if (conversationStore) {
          conversationStore.releaseTurnLock(appId, conversationId, lockToken);
        }
      }
    }
  );
}
