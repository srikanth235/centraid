/*
 * governance: allow-repo-hygiene file-size-limit (#567) the SSE transport, durable lock, hydration, artifact fold, and atomic ledger settlement form one turn transaction whose cleanup ordering must remain visible together
 *
 * The SSE turn driver — the transport-and-ledger half of a chat turn,
 * shared by every `_turn`-shaped route. Extracted from `turn-routes.ts`
 * (the per-app surface keeps its app lookups, manifest reads and prompt
 * assembly) so the vault assistant's shell-level turn route drives the
 * SAME stream shape, accumulator, run-ledger fold, and resume-handle
 * bookkeeping without duplicating them.
 *
 * What it owns, start to finish:
 *   - SSE headers, banner comment, 30s heartbeats, client-abort wiring;
 *   - the event accumulator that folds `TurnStreamEvent`s into `runs` /
 *     `run_nodes` (assistant text, tool trace, usage, error);
 *   - the per-(appId, conversationId) async lock;
 *   - `recordTurn` + `noteTurn` against the conversation store;
 *   - the closing `event: end` frame.
 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** Same ceiling the inline-artifact path enforces — a harness-reported
 *  workspace file is no more trusted than an inline one. */
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
  // Containment first, and silently: a path outside the turn's roots is a
  // boundary decision, not a failure the owner needs told about.
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
  // Past containment the file was meant to be captured, so a miss is a real
  // dropped artifact — surface it rather than swallowing it. Stat BEFORE
  // reading: the old order slurped whole directories' worth of bytes into
  // memory (and any size at all) before deciding it wanted them.
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
  /** Ledger scope the turn records under (an app id, or `_assistant`). */
  appId: string;
  conversationId: string;
  message: string;
  /** Working dir handed to the harness as `dataDir`. */
  dataDir: string;
  /** Canonical host-resolved root chosen from the Centraid workspace selector. */
  workspaceDirectory?: string;
  workspaceKind?: TypeImport_wkgbyq.ConversationWorkspaceKind;
  /** The route-assembled system-prompt preamble. */
  extraSystemPrompt: string;
  runner: ConversationRunner;
  conversationStore?: ConversationHistoryStore | undefined;
  /** Central scratch dir for harness-owned `<conversationId>.jsonl` files. */
  conversationHarnessSessionDir: string;
  conversationLocks: Map<string, Promise<void>>;
  /** Leading SSE comment, e.g. `chat <appId> session <id>`. */
  banner: string;
  /** Chat register the turn belongs to (`'ask'` = app copilot). */
  register?: "ask" | "build" | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  harnessKind?: TypeImport_nu6ai6.HarnessKind | undefined;
  /** One provider, or the whole set the client has accumulated (issue #567). */
  providerConsent?:
    | TypeImport_nu6ai6.HarnessKind
    | readonly TypeImport_nu6ai6.HarnessKind[]
    | undefined;
  additionalDirectories?: string[];
  idempotencyKey?: string | undefined;
  /**
   * Modest per-vault turn-concurrency gate (issue #420). When set and already
   * at capacity, the driver writes a `429` + `Retry-After` and never opens the
   * SSE stream. The slot is held for the whole drive and released when the
   * stream ends. Absent in hermetic tests → unbounded (the old behavior).
   */
  limiter?: TurnLimiter | undefined;
  /** When set, this turn is a regenerate of the given turn id — recorded as
   *  `turns.retry_of` so the transcript collapses it into a sibling pager
   *  (issue #420). */
  retryOf?: string | undefined;
  prevHarnessSessionId?: string | undefined;
  prevHarnessKind?: string | undefined;
  prevHarnessUsageSnapshot?: TypeImport_nu6ai6.HarnessUsageSnapshot | undefined;
  /** CAS refs recorded on the turn's `message_in` item. */
  attachmentRefs?: TurnAttachmentRef[];
  /** Resolved blob paths handed to the harness for multimodal blocks. */
  turnAttachments?: { path: string; mime: string; filename?: string }[];
  /**
   * Fire-and-forget LLM auto-title hook (issue #420). Invoked once, ONLY after
   * the FIRST successful turn of a still-unnamed conversation, with the turn's
   * user message and assistant answer. The callback owns the cheap-tier
   * inference and the "apply only if the title is still the derived truncation"
   * guard; the driver just decides *when* to fire it. Never awaited — a title
   * miss must never affect the turn.
   */
  generateTitle?: (args: {
    conversationId: string;
    userMessage: string;
    assistantText: string;
  }) => void;
}

/**
 * Drive one chat turn over an SSE response, folding the stream into the
 * run ledger. Resolves when the stream has ended (the response is closed
 * here, always).
 */
export async function driveTurnOverSse(opts: DriveTurnOptions): Promise<void> {
  const { res } = opts;

  // Backpressure (issue #420): a modest per-vault ceiling on running turns.
  // Beyond it, 429 + Retry-After BEFORE any SSE header — the client retries
  // (with the same idempotency key, so a retry can only ever replay). The slot
  // is held for the whole drive and released in the finally below.
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

  // Start the SSE stream up-front so the harness sees `connected` even if
  // the harness takes a while to spin up. Heartbeats every 30s keep proxies
  // from timing out a long quiet stretch (model thinking, big tool call).
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Bounded writer (issue #659 G6): a client that stops draining a turn stream
  // is dropped instead of buffering the whole run in gateway memory. The turn
  // itself keeps running and is recorded in the ledger, so a reconnect replays
  // it from there — nothing is lost by dropping the socket.
  const stream = new SseStream(res);
  stream.comment(opts.banner);
  const heartbeat = setInterval(() => {
    stream.comment("ping");
  }, 30_000);
  heartbeat.unref?.();

  const writeEvent = (event: TurnStreamEvent): void => {
    stream.event(event.type, JSON.stringify(event));
  };

  // Turn accumulator — folds the harness's `TurnStreamEvent`s into the
  // `runs` / `run_nodes` audit trace (issue #90). The harness's `usage`
  // event (when emitted) is folded into the turn's `step` node so the
  // ledger carries real token + cost accounting for chat turns.
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
        // Keep cost + provenance for the ledger (issue #514) — do not strip.
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
      // No ledger state to fold for these; the SSE write still happens via
      // `writeEvent`. Listed explicitly (not a default) so a newly added
      // event type fails the exhaustiveness check instead of slipping through.
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
    // Prefer harness/ACP cost; fill catalog estimate only when missing (#514).
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

  // Harness-owned scratch file in the central scratch dir. Make sure the
  // parent dir exists before any harness writes to it.
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
      lockLeaseHeartbeat?.unref?.();
      try {
        // Idempotency (issue #420): a duplicate POST with a key that already names a
        // recorded turn on this conversation replays the recorded answer instead of
        // re-running the model. The per-conversation lock makes the in-flight case
        // fall out for free — a duplicate that arrives while the first turn is still
        // running QUEUES behind this same lock, so by the time it acquires the lock
        // the first turn has recorded and this branch replays it (no 409 needed, no
        // double-run). Replay skips the harness AND recordTurn, so no duplicate row.
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
        // The harness's failover ladder can land on a provider this route never
        // targeted, and every provider has its OWN binding and its OWN hydration
        // watermark. So resume + hydration are resolved PER RUNG, on demand,
        // through `resumeForKind` — one planned-once-per-kind memo. Resolving it
        // eagerly against the primary target and reusing that plan down the
        // ladder silently dropped the whole conversation whenever rung 0 was
        // skipped (breaker open), and folded the full ledger on every turn even
        // when no rung ever needed it.
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
            // Retire a binding the harness had to abandon (D9). `hydrationKind:
            // 'recovery'` means the resume handle we handed this harness was
            // rejected and it self-healed onto a fresh session. Left `active`,
            // that dead handle would be re-offered on every subsequent turn,
            // paying a failed resume + a full-ledger recovery fold each time.
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
            // Whether this conversation is still unnamed BEFORE we record — an
            // empty title is the "first turn of a new thread" signal (recordTurn
            // sets the derived truncation below). Read once here so the auto-title
            // hook fires exactly on the naming turn (issue #420).
            const wasUnnamed =
              conversationStore.getSessionMeta(appId, conversationId)?.title ===
              "";
            // Persist the turn as a `runs` row + its `run_nodes` trace. The
            // assistant reply (or the turn error) is one `step` node ordered
            // after the turn's `tool` nodes — matching the transcript shape
            // `getSession` reconstructs.
            try {
              const endedAt = Date.now();
              const roots = [
                opts.workspaceDirectory ?? opts.dataDir,
                ...(opts.additionalDirectories ?? []),
              ];
              // Candidate nodes are ledger-ordered. Attach each node before the
              // next so optional upload failures keep their notices aligned with
              // the originating tool item.
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
                    // A malformed optional ACP artifact never fails the turn.
                  }
                  return uploadNextInline(inlineIndex + 1);
                };
                await uploadNextInline(0);
                if (artifacts.length > 0) candidate.node.artifacts = artifacts;
                return attachNextCandidate(index + 1);
              };
              await attachNextCandidate(0);
              const nodes: TurnNode[] = [...acc.toolNodes];
              // The turn consumed tokens whether it ended in a reply or an
              // error, so the `usage` totals apply to either step node.
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
                // The harness's surface decides the ledger kind: the builder-capable
                // unified runner reports `'build'`, the data-only runner leaves it
                // unset → recorded as `'chat'` (issue #181). Read statically off the
                // runner so an errored turn (no `ConversationTurnResult`) is still tagged.
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
              /* best-effort — a ledger miss never fails the turn */
            }
            // LLM auto-title (issue #420): only on the naming turn of a new thread,
            // only when the turn actually produced an answer. Fire-and-forget — the
            // callback owns the cheap inference and the rename guard.
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
                /* best-effort — a title miss never fails the turn */
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
