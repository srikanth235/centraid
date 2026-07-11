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

/** A file uploaded to the blob CAS before the turn, referenced by its hash. */
export interface TurnAttachmentRef {
  hash: string;
  mime: string;
  filename?: string;
  sizeBytes?: number;
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
  prevAdapterSessionId?: string | undefined;
  prevAdapterKind?: string | undefined;
  /** CAS refs recorded on the turn's `message_in` item. */
  attachmentRefs?: TurnAttachmentRef[];
  /** Resolved blob paths handed to the runner for multimodal blocks. */
  turnAttachments?: { path: string; mime: string; filename?: string }[];
}

/**
 * Drive one chat turn over an SSE response, folding the stream into the
 * run ledger. Resolves when the stream has ended (the response is closed
 * here, always).
 */
export async function driveTurnOverSse(opts: DriveTurnOptions): Promise<void> {
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
      case 'webhooks':
        break;
    }
  };
  const onEvent = (event: TurnStreamEvent): void => {
    accumulate(event);
    writeEvent(event);
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
