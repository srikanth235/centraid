/*
 * HTTP route handler for the per-app chat surface.
 *
 *   POST    /centraid/<appId>/_chat                        ← send turn (SSE stream)
 *
 * Surface A is now POST-only. A chat session IS the chat window — the
 * `windowId` in the POST body is the `chat_sessions` row id in the central
 * gateway SQLite. The desktop persists the transcript itself via Surface B
 * (`/_centraid-chat`); this route only drives the model turn and records
 * turn completion + the runner-resume handle against the session row.
 *
 * The runtime delegates to a host-injected `ChatRunner`. When no runner is
 * configured, the chat route 503s with a clear error — that is the M1
 * stub behavior the issue calls out.
 *
 * Concurrency: each session has at most one in-flight turn at a time. A
 * second POST against the same windowId is queued behind the first by a
 * per-window async lock. Within a single process this is the only correctness
 * gate; we don't try to coordinate across processes because the chat surface
 * is owned by one runtime per appsDir.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, readBody, MAX_BODY_BYTES } from './http-utils.js';
import { readAppSchema } from './schema.js';
import { buildExtraPrompt } from './build-extra-prompt.js';
import type { ChatMode, ChatRunInput, ChatRunner, ChatStreamEvent } from './chat-runner.js';
import type { ChatHistoryStore, ChatTurnNode } from './chat-history.js';
import type { Registry } from './registry.js';
import { appDataDir } from './app-paths.js';
import type { RegistryEntry } from './types.js';

/**
 * Validate a window/session id. Reject anything that could escape a
 * directory (the runner scratch dir uses the id verbatim as a filename) or
 * exceed a sane length. Window ids are caller-supplied — the renderer mints
 * a stable id per chat pane (it's the chat session UUID).
 */
export function isValidWindowId(id: string): boolean {
  if (!id || id.length > 128) return false;
  if (id === 'index.json') return false;
  if (id.startsWith('.')) return false;
  return /^[A-Za-z0-9_\-:]+$/.test(id);
}

/**
 * Dependencies injected from `Runtime`. Pulled out so the chat routes don't
 * need to know about `Runtime` directly (avoids a circular module shape).
 */
export interface ChatRouteContext {
  registry: Registry;
  runner?: ChatRunner;
  /**
   * Optional central chat store. When set, the route reads the session's
   * sticky mode + runner-resume handles from it and records turn completion
   * back into it. When unset, the route still works — mode comes from the
   * POST body and no resume handle is threaded.
   */
  chatStore?: ChatHistoryStore;
  /**
   * Central scratch base dir for runner-owned session files. The route
   * passes `<chatRunnerSessionDir>/<windowId>.jsonl` as `ChatRunInput.sessionFile`.
   */
  chatRunnerSessionDir: string;
  /**
   * Optional per-app metadata reader. Used to populate `appName` / `appDescription`
   * in the extra-system-prompt. Returns undefined when the app has no
   * authored `app.json` yet (freshly registered uploads with no
   * committed version).
   */
  appMeta?: (entry: RegistryEntry) => Promise<{ name?: string; description?: string }>;
}

export type ParsedChatRoute = { kind: 'post'; appId: string };

/**
 * Match the chat sub-routes under `/centraid/<appId>/_chat`. The caller
 * (router.ts) has already established the URL is under `/centraid/<id>/_chat...`.
 *
 * Surface A is POST-only — anything else (including the old `windows...`
 * sub-paths) returns undefined and the caller 404s.
 */
export function parseChatSubRoute(
  appId: string,
  segments: string[],
  method: string,
): ParsedChatRoute | undefined {
  // segments here are the path under /centraid/<appId>/ starting with "_chat"
  // segments[0] === "_chat"
  if (segments.length === 1 && method.toUpperCase() === 'POST') {
    return { kind: 'post', appId };
  }
  return undefined;
}

const windowLocks = new Map<string, Promise<void>>();

/**
 * Serialize work on `(appId, windowId)` so a second POST queues behind the
 * first. The route handler awaits the previous tail before scheduling its
 * own. The lock entry is cleared lazily once the current task settles.
 */
async function withWindowLock<T>(
  appId: string,
  windowId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${appId}::${windowId}`;
  const previous = windowLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => (release = resolve));
  // The map holds the *chained* tail (previous → next) so newer callers
  // await everything ahead of them. Keep a reference to that exact promise
  // so the cleanup branch can identify "nobody else queued after me".
  const chained = previous.then(() => next);
  windowLocks.set(key, chained);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (windowLocks.get(key) === chained) windowLocks.delete(key);
  }
}

interface PostBody {
  windowId?: string;
  message?: string;
  mode?: ChatMode;
  model?: string;
  thinking?: string;
  idempotencyKey?: string;
}

/**
 * Dispatch one chat-route request. Errors thrown out of here are caught by
 * `Runtime.handle`'s catch-all and turned into 500s.
 */
export async function handleChatRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ChatRouteContext,
  parsed: ParsedChatRoute,
): Promise<void> {
  const entry = ctx.registry.get(parsed.appId);
  if (!entry) {
    sendError(res, 404, 'not_found', 'App not registered.');
    return;
  }
  await handlePostTurn(req, res, ctx, entry);
}

async function handlePostTurn(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ChatRouteContext,
  entry: RegistryEntry,
): Promise<void> {
  if (!ctx.runner) {
    sendError(
      res,
      503,
      'no_chat_runner',
      'No chat runner is configured for this runtime. The host must inject one.',
    );
    return;
  }

  let body: PostBody;
  try {
    const raw = await readBody(req);
    body = raw.length === 0 ? {} : (JSON.parse(raw.toString('utf8')) as PostBody);
  } catch (err) {
    const message =
      err instanceof Error && err.message.includes('1 MiB')
        ? `Request body exceeds ${MAX_BODY_BYTES} bytes.`
        : 'Invalid JSON body.';
    sendError(res, 400, 'bad_request', message);
    return;
  }

  const windowId = body.windowId;
  const message = body.message;
  if (!windowId || !message) {
    sendError(res, 400, 'bad_request', 'Body must include { windowId, message }.');
    return;
  }
  if (!isValidWindowId(windowId)) {
    sendError(res, 400, 'bad_request', 'Invalid windowId.');
    return;
  }

  // Resolve sticky mode + runner-resume handles from the central session
  // row when a chat store is wired. Without it, fall back to the body mode.
  let mode: ChatMode = body.mode === 'data' ? 'data' : 'full';
  let prevAdapterSessionId: string | undefined;
  let prevAdapterKind: string | undefined;
  if (ctx.chatStore) {
    const session = ctx.chatStore.getSessionMeta(entry.id, windowId);
    if (!session) {
      sendError(res, 404, 'not_found', 'No such chat session.');
      return;
    }
    mode = session.mode;
    prevAdapterSessionId = session.adapterSessionId ?? undefined;
    prevAdapterKind = session.adapterKind ?? undefined;
  }

  const appMeta = ctx.appMeta ? await ctx.appMeta(entry).catch(() => ({}) as never) : undefined;
  const schema = safeReadSchema(entry);
  const extraSystemPrompt = buildExtraPrompt({
    appId: entry.id,
    appName: appMeta?.name,
    appDescription: appMeta?.description,
    mode,
    schema,
  });

  // Start the SSE stream up-front so the harness sees `connected` even if
  // the runner takes a while to spin up. Heartbeats every 30s keep proxies
  // from timing out a long quiet stretch (model thinking, big tool call).
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`: chat ${entry.id} window ${windowId} mode ${mode}\n\n`);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: ping\n\n`);
  }, 30_000);
  heartbeat.unref?.();

  const writeEvent = (event: ChatStreamEvent): void => {
    if (res.writableEnded) return;
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Turn accumulator — folds the runner's `ChatStreamEvent`s into the
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
    toolNodes: [] as ChatTurnNode[],
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
  const accumulate = (event: ChatStreamEvent): void => {
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
          appId: entry.id,
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
      // assistant.start / reasoning.delta / phase / aborted — no ledger
      // state to fold; the SSE write still happens via `writeEvent`.
    }
  };
  const onEvent = (event: ChatStreamEvent): void => {
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
  // parent dir exists before any runner writes — the OpenClaw runner writes
  // a pi session file at this path and silently no-ops if the dir is missing.
  const sessionFile = path.join(ctx.chatRunnerSessionDir, `${windowId}.jsonl`);
  await fs.mkdir(ctx.chatRunnerSessionDir, { recursive: true }).catch(() => undefined);

  const input: ChatRunInput = {
    appId: entry.id,
    dataDir: appDataDir(entry),
    windowId,
    sessionFile,
    mode,
    message,
    extraSystemPrompt,
    abortSignal: abortController.signal,
    onEvent,
    ...(body.model ? { model: body.model } : {}),
    ...(body.thinking ? { thinking: body.thinking } : {}),
    ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    ...(prevAdapterSessionId ? { prevAdapterSessionId } : {}),
    ...(prevAdapterKind ? { prevAdapterKind } : {}),
  };

  await withWindowLock(entry.id, windowId, async () => {
    let runResult: { adapterSessionId?: string; adapterKind?: string } | undefined;
    try {
      const out = await ctx.runner!.run(input);
      runResult = out ?? undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ type: 'error', message: msg });
    } finally {
      clearInterval(heartbeat);
      req.off('close', onClientClose);
      req.off('error', onClientClose);
      if (ctx.chatStore) {
        // Persist the turn as a `runs` row + its `run_nodes` trace. The
        // assistant reply (or the turn error) is one `step` node ordered
        // after the turn's `tool` nodes — matching the transcript shape
        // `getSession` reconstructs.
        try {
          const endedAt = Date.now();
          const nodes: ChatTurnNode[] = [...acc.toolNodes];
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
          ctx.chatStore.recordTurn(entry.id, {
            chatSessionId: windowId,
            userMessage: message,
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
        // claude-code; the OpenClaw runner resumes via `sessionFile` and
        // returns void).
        try {
          ctx.chatStore.noteTurn(
            entry.id,
            windowId,
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

/**
 * Read the live schema, falling back to an empty schema if the app has
 * no `data.sqlite` yet. The data file is created on first use elsewhere;
 * during chat-prompt assembly we want a no-throw read.
 */
function safeReadSchema(entry: RegistryEntry): ReturnType<typeof readAppSchema> {
  try {
    return readAppSchema(path.join(entry.path, 'data.sqlite'));
  } catch {
    return { schemaVersion: 0, tables: [], indexes: [], views: [] };
  }
}
