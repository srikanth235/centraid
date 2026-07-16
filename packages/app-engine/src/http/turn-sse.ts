/*
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

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  ConversationTurnInput,
  ConversationRunner,
  TurnStreamEvent,
} from '../conversation/runner.js';
import type { ConversationHistoryStore, TurnNode } from '../conversation/history.js';
import { buildReplayEvents } from './turn-replay.js';
import { writeTurnBusy, type TurnLimiter } from './turn-limiter.js';
import { costForUsage } from '../model-pricing.js';

/** A file uploaded to the blob CAS before the turn, referenced by its hash. */
export interface TurnAttachmentRef {
  hash: string;
  mime: string;
  filename?: string;
  sizeBytes?: number;
}

const ATTACHMENT_HASH_RE = /^[a-f0-9]{64}$/;

/**
 * Parse+validate the `attachments` field of a `_turn` POST body (issue
 * #190's wire shape) — shared by every `_turn`-shaped route (the per-app
 * surface and the vault assistant's shell-level surface) so both validate
 * identically. Anything malformed is silently dropped rather than
 * rejecting the whole turn — a bad ref just means that one file doesn't ride.
 */
export function parseTurnAttachmentRefs(raw: unknown): TurnAttachmentRef[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is TurnAttachmentRef => {
    if (!a || typeof a !== 'object') return false;
    const r = a as Partial<TurnAttachmentRef>;
    return (
      typeof r.hash === 'string' && ATTACHMENT_HASH_RE.test(r.hash) && typeof r.mime === 'string'
    );
  });
}

/**
 * Resolve validated attachment refs to on-disk blob paths for the runner's
 * multimodal content blocks — the shape `ConversationTurnInput.attachments`
 * expects. `appId` scopes the blob CAS lookup (an app id, or `_assistant`).
 */
export function resolveTurnAttachments(
  conversationStore: ConversationHistoryStore | undefined,
  appId: string,
  refs: readonly TurnAttachmentRef[],
): { path: string; mime: string; filename?: string }[] {
  if (!conversationStore || refs.length === 0) return [];
  return refs.map((a) => ({
    path: conversationStore.blobPathFor(appId, a.hash),
    mime: a.mime,
    ...(a.filename !== undefined ? { filename: a.filename } : {}),
  }));
}

/**
 * Serialize work on `(appId, conversationId)` so a second POST queues behind the
 * first. The route handler awaits the previous tail before scheduling its
 * own. The lock entry is cleared lazily once the current task settles.
 *
 * The lock map is per-runtime — held on the `Runtime` instance and threaded
 * through the route context. A module-level map would collide across
 * gateways that share an `appId` (two profiles can install the same
 * template). See issue #113.
 */
export async function withConversationLock<T>(
  conversationLocks: Map<string, Promise<void>>,
  appId: string,
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${appId}::${conversationId}`;
  const previous = conversationLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => (release = resolve));
  // The map holds the *chained* tail (previous → next) so newer callers
  // await everything ahead of them. Keep a reference to that exact promise
  // so the cleanup branch can identify "nobody else queued after me".
  const chained = previous.then(() => next);
  conversationLocks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (conversationLocks.get(key) === chained) conversationLocks.delete(key);
  }
}

export interface DriveTurnOptions {
  req: IncomingMessage;
  res: ServerResponse;
  /** Ledger scope the turn records under (an app id, or `_assistant`). */
  appId: string;
  conversationId: string;
  message: string;
  /** Working dir handed to the runner as `dataDir`. */
  dataDir: string;
  /** The route-assembled system-prompt preamble. */
  extraSystemPrompt: string;
  runner: ConversationRunner;
  conversationStore?: ConversationHistoryStore | undefined;
  /** Central scratch dir for runner-owned `<conversationId>.jsonl` files. */
  conversationRunnerSessionDir: string;
  conversationLocks: Map<string, Promise<void>>;
  /** Leading SSE comment, e.g. `chat <appId> session <id>`. */
  banner: string;
  /** Chat register the turn belongs to (`'ask'` = app copilot). */
  register?: 'ask' | 'build' | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
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
  prevAdapterSessionId?: string | undefined;
  prevAdapterKind?: string | undefined;
  /** CAS refs recorded on the turn's `message_in` item. */
  attachmentRefs?: TurnAttachmentRef[];
  /** Resolved blob paths handed to the runner for multimodal blocks. */
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
  const { req, res, appId, conversationId, message, runner, conversationStore } = opts;

  // Start the SSE stream up-front so the harness sees `connected` even if
  // the runner takes a while to spin up. Heartbeats every 30s keep proxies
  // from timing out a long quiet stretch (model thinking, big tool call).
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`: ${opts.banner}\n\n`);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: ping\n\n`);
  }, 30_000);
  heartbeat.unref?.();

  const writeEvent = (event: TurnStreamEvent): void => {
    if (res.writableEnded) return;
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Turn accumulator — folds the runner's `TurnStreamEvent`s into the
  // `runs` / `run_nodes` audit trace (issue #90). The runner's `usage`
  // event (when emitted) is folded into the turn's `step` node so the
  // ledger carries real token + cost accounting for chat turns.
  const turnStartedAt = Date.now();
  const acc = {
    aiText: '',
    finalText: undefined as string | undefined,
    errorMessage: undefined as string | undefined,
    pending: new Map<
      string,
      { toolName: string; sql?: string; args?: unknown; startedAt: number }
    >(),
    toolNodes: [] as TurnNode[],
    usage: undefined as
      | {
          model?: string;
          provider?: string;
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        }
      | undefined,
  };
  const accumulate = (event: TurnStreamEvent): void => {
    switch (event.type) {
      case 'assistant.delta':
        acc.aiText += event.delta;
        return;
      case 'tool.start':
        acc.pending.set(event.toolCallId, {
          toolName: event.toolName,
          ...(event.sql !== undefined ? { sql: event.sql } : {}),
          ...(event.args !== undefined ? { args: event.args } : {}),
          startedAt: Date.now(),
        });
        return;
      case 'tool.result': {
        const pending = acc.pending.get(event.toolCallId);
        acc.pending.delete(event.toolCallId);
        acc.toolNodes.push({
          kind: 'tool',
          toolName: event.toolName || pending?.toolName || 'tool',
          ...(pending?.sql !== undefined ? { sql: pending.sql } : {}),
          ...(pending?.args !== undefined ? { args: pending.args } : {}),
          ok: event.ok,
          ...(event.result !== undefined ? { result: event.result } : {}),
          ...(!event.ok ? { errorText: event.errorText ?? 'Tool failed.' } : {}),
          appId,
          startedAt: pending?.startedAt ?? Date.now(),
          endedAt: Date.now(),
        });
        return;
      }
      case 'final':
        acc.finalText = acc.aiText || event.text;
        return;
      case 'usage':
        acc.usage = {
          ...(event.model !== undefined ? { model: event.model } : {}),
          ...(event.provider !== undefined ? { provider: event.provider } : {}),
          ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
          ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
          ...(event.cacheReadTokens !== undefined
            ? { cacheReadTokens: event.cacheReadTokens }
            : {}),
          ...(event.cacheWriteTokens !== undefined
            ? { cacheWriteTokens: event.cacheWriteTokens }
            : {}),
        };
        return;
      case 'error':
        acc.errorMessage = event.message;
        break;
      // No ledger state to fold for these; the SSE write still happens via
      // `writeEvent`. Listed explicitly (not a default) so a newly added
      // event type fails the exhaustiveness check instead of slipping through.
      case 'assistant.start':
      case 'reasoning.delta':
      case 'phase':
      case 'aborted':
      case 'notice':
      case 'webhooks':
        break;
    }
  };
  const onEvent = (event: TurnStreamEvent): void => {
    // Price the usage event at the one allowlisted seam (model-pricing.ts) so
    // clients can show a live cost without mirroring model rate tables.
    let priced = event;
    if (priced.type === 'usage' && priced.costUsd === undefined) {
      const costUsd = costForUsage(priced.model, priced);
      if (costUsd !== undefined) priced = { ...priced, costUsd };
    }
    accumulate(priced);
    writeEvent(priced);
  };

  const abortController = new AbortController();
  const onClientClose = (): void => {
    if (!abortController.signal.aborted) abortController.abort();
  };
  req.on('close', onClientClose);
  req.on('error', onClientClose);

  // Runner-owned scratch file in the central scratch dir. Make sure the
  // parent dir exists before any runner writes to it.
  const sessionFile = path.join(opts.conversationRunnerSessionDir, `${conversationId}.jsonl`);
  await fs.mkdir(opts.conversationRunnerSessionDir, { recursive: true }).catch(() => undefined);

  const input: ConversationTurnInput = {
    appId,
    dataDir: opts.dataDir,
    conversationId,
    sessionFile,
    message,
    ...(opts.register ? { register: opts.register } : {}),
    ...(opts.turnAttachments?.length ? { attachments: opts.turnAttachments } : {}),
    extraSystemPrompt: opts.extraSystemPrompt,
    abortSignal: abortController.signal,
    onEvent,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
    ...(opts.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
    ...(opts.prevAdapterSessionId ? { prevAdapterSessionId: opts.prevAdapterSessionId } : {}),
    ...(opts.prevAdapterKind ? { prevAdapterKind: opts.prevAdapterKind } : {}),
  };

  await withConversationLock(opts.conversationLocks, appId, conversationId, async () => {
    // Idempotency (issue #420): a duplicate POST with a key that already names a
    // recorded turn on this conversation replays the recorded answer instead of
    // re-running the model. The per-conversation lock makes the in-flight case
    // fall out for free — a duplicate that arrives while the first turn is still
    // running QUEUES behind this same lock, so by the time it acquires the lock
    // the first turn has recorded and this branch replays it (no 409 needed, no
    // double-run). Replay skips the runner AND recordTurn, so no duplicate row.
    if (opts.idempotencyKey && conversationStore) {
      const recorded = conversationStore.findRecordedTurn(
        appId,
        conversationId,
        opts.idempotencyKey,
      );
      if (recorded) {
        for (const ev of buildReplayEvents(recorded)) writeEvent(ev);
        clearInterval(heartbeat);
        req.off('close', onClientClose);
        req.off('error', onClientClose);
        if (!res.writableEnded) {
          res.write(`event: end\ndata: {}\n\n`);
          res.end();
        }
        return;
      }
    }
    let runResult: { adapterSessionId?: string; adapterKind?: string } | undefined;
    try {
      const out = await runner.run(input);
      runResult = out ?? undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', message: msg });
    } finally {
      clearInterval(heartbeat);
      req.off('close', onClientClose);
      req.off('error', onClientClose);
      if (conversationStore) {
        // Whether this conversation is still unnamed BEFORE we record — an
        // empty title is the "first turn of a new thread" signal (recordTurn
        // sets the derived truncation below). Read once here so the auto-title
        // hook fires exactly on the naming turn (issue #420).
        const wasUnnamed = conversationStore.getSessionMeta(appId, conversationId)?.title === '';
        // Persist the turn as a `runs` row + its `run_nodes` trace. The
        // assistant reply (or the turn error) is one `step` node ordered
        // after the turn's `tool` nodes — matching the transcript shape
        // `getSession` reconstructs.
        try {
          const endedAt = Date.now();
          const nodes: TurnNode[] = [...acc.toolNodes];
          // The turn consumed tokens whether it ended in a reply or an
          // error, so the `usage` totals apply to either step node.
          const usage = acc.usage ?? {};
          if (acc.errorMessage !== undefined) {
            nodes.push({
              kind: 'step',
              text: acc.errorMessage,
              isError: true,
              ...usage,
              startedAt: turnStartedAt,
              endedAt,
            });
          } else if (acc.finalText && acc.finalText.trim().length > 0) {
            nodes.push({
              kind: 'step',
              text: acc.finalText,
              ...usage,
              startedAt: turnStartedAt,
              endedAt,
            });
          }
          conversationStore.recordTurn(appId, {
            conversationId,
            // The runner's surface decides the ledger kind: the builder-capable
            // unified runner reports `'build'`, the data-only runner leaves it
            // unset → recorded as `'chat'` (issue #181). Read statically off the
            // runner so an errored turn (no `ConversationTurnResult`) is still tagged.
            ...(runner.runKind ? { kind: runner.runKind } : {}),
            ...(opts.retryOf !== undefined ? { retryOf: opts.retryOf } : {}),
            ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
            userMessage: message,
            ...(opts.attachmentRefs?.length
              ? {
                  attachments: opts.attachmentRefs.map((a) => ({
                    hash: a.hash,
                    mime: a.mime,
                    sizeBytes: a.sizeBytes ?? 0,
                    ...(a.filename !== undefined ? { filename: a.filename } : {}),
                  })),
                }
              : {}),
            startedAt: turnStartedAt,
            endedAt,
            ok: acc.errorMessage === undefined,
            ...(acc.errorMessage !== undefined ? { error: acc.errorMessage } : {}),
            ...(acc.finalText !== undefined ? { finalText: acc.finalText } : {}),
            nodes,
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
        // Persist the runner-resume handle. The resume-handle update only
        // happens when the runner reported an `adapterKind` (codex /
        // claude-code).
        try {
          conversationStore.noteTurn(
            appId,
            conversationId,
            runResult?.adapterKind
              ? {
                  kind: runResult.adapterKind,
                  ...(runResult.adapterSessionId ? { sessionId: runResult.adapterSessionId } : {}),
                }
              : undefined,
          );
        } catch {
          /* best-effort — a turn-count miss never fails the turn */
        }
      }
      if (!res.writableEnded) {
        res.write(`event: end\ndata: {}\n\n`);
        res.end();
      }
    }
  });
}
