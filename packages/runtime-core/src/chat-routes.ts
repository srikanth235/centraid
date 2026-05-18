/*
 * HTTP route handlers for the per-app chat surface.
 *
 *   POST    /centraid/<appId>/_chat                        ← send turn (SSE stream)
 *   GET     /centraid/<appId>/_chat/windows                ← list windows
 *   GET     /centraid/<appId>/_chat/windows/<windowId>/history
 *   DELETE  /centraid/<appId>/_chat/windows/<windowId>
 *
 * The runtime delegates to a host-injected `ChatRunner`. When no runner is
 * configured, every chat route 503s with a clear error — that is the M1
 * stub behavior the issue calls out.
 *
 * Concurrency: each window has at most one in-flight turn at a time. A
 * second POST against the same windowId is queued behind the first by a
 * per-window async lock. Within a single process this is the only correctness
 * gate; we don't try to coordinate across processes because the chat surface
 * is owned by one runtime per appsDir.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson, readBody, MAX_BODY_BYTES } from './http-utils.js';
import { readAppSchema } from './schema.js';
import { buildExtraPrompt } from './build-extra-prompt.js';
import { ChatStore, chatDir, isValidWindowId, chatSessionFile } from './chat-store.js';
import type { ChatMode, ChatRunInput, ChatRunner, ChatStreamEvent } from './chat-runner.js';
import type { Registry } from './registry.js';
import { appDataDir } from './app-paths.js';
import type { RegistryEntry } from './types.js';

/**
 * Dependencies injected from `Runtime`. Pulled out so the chat routes don't
 * need to know about `Runtime` directly (avoids a circular module shape).
 */
export interface ChatRouteContext {
  registry: Registry;
  runner?: ChatRunner;
  /**
   * Optional per-app metadata reader. Used to populate `appName` / `appDescription`
   * in the extra-system-prompt. Returns undefined when the app has no
   * authored `app.json` yet (path-mode apps, freshly registered uploads).
   */
  appMeta?: (entry: RegistryEntry) => Promise<{ name?: string; description?: string }>;
}

type ParsedChatRoute =
  | { kind: 'post'; appId: string }
  | { kind: 'list-windows'; appId: string }
  | { kind: 'history'; appId: string; windowId: string }
  | { kind: 'delete-window'; appId: string; windowId: string };

/**
 * Match the chat sub-routes under `/centraid/<appId>/_chat`. The caller
 * (router.ts) has already established the URL is under `/centraid/<id>/_chat...`.
 *
 * Returns undefined when the sub-path is not a chat route — the caller
 * keeps falling through to static asset handling.
 */
export function parseChatSubRoute(
  appId: string,
  segments: string[],
  method: string,
): ParsedChatRoute | undefined {
  const m = method.toUpperCase();
  // segments here are the path under /centraid/<appId>/ starting with "_chat"
  // segments[0] === "_chat"
  if (segments.length === 1) {
    if (m === 'POST') return { kind: 'post', appId };
    return undefined;
  }
  if (segments[1] === 'windows') {
    if (segments.length === 2) {
      if (m === 'GET') return { kind: 'list-windows', appId };
      return undefined;
    }
    const windowId = segments[2] ?? '';
    if (!windowId) return undefined;
    if (segments.length === 3) {
      if (m === 'DELETE') return { kind: 'delete-window', appId, windowId };
      return undefined;
    }
    if (segments.length === 4 && segments[3] === 'history' && m === 'GET') {
      return { kind: 'history', appId, windowId };
    }
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
  windowLocks.set(
    key,
    previous.then(() => next),
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
    // Clear the slot only if nothing else has chained on top of us.
    if (windowLocks.get(key) === next) windowLocks.delete(key);
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
 * Dispatch one chat-route request. Returns true when the request was
 * handled (caller should stop further routing); false when the path
 * wasn't ours (caller should keep going). Errors thrown out of here are
 * caught by `Runtime.handle`'s catch-all and turned into 500s.
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

  switch (parsed.kind) {
    case 'list-windows': {
      const store = new ChatStore(appDataDir(entry));
      const list = await store.listWindows();
      sendJson(res, 200, { windows: list });
      return;
    }
    case 'history': {
      if (!isValidWindowId(parsed.windowId)) {
        sendError(res, 400, 'bad_request', 'Invalid windowId.');
        return;
      }
      const store = new ChatStore(appDataDir(entry));
      const meta = await store.getWindow(parsed.windowId);
      if (!meta) {
        sendError(res, 404, 'not_found', 'No such chat window.');
        return;
      }
      const entries = await store.readTranscript(parsed.windowId);
      sendJson(res, 200, { window: meta, entries });
      return;
    }
    case 'delete-window': {
      if (!isValidWindowId(parsed.windowId)) {
        sendError(res, 400, 'bad_request', 'Invalid windowId.');
        return;
      }
      const store = new ChatStore(appDataDir(entry));
      const removed = await store.deleteWindow(parsed.windowId);
      sendJson(res, removed ? 200 : 404, { ok: removed });
      return;
    }
    case 'post': {
      await handlePostTurn(req, res, ctx, entry);
    }
  }
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

  const desiredMode: ChatMode = body.mode === 'data' ? 'data' : 'full';
  const store = new ChatStore(appDataDir(entry));
  const meta = await store.upsertWindow(windowId, desiredMode);
  const mode: ChatMode = meta.mode;

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

  const abortController = new AbortController();
  const onClientClose = (): void => {
    if (!abortController.signal.aborted) abortController.abort();
  };
  req.on('close', onClientClose);
  req.on('error', onClientClose);

  const sessionFile = chatSessionFile(appDataDir(entry), windowId);
  // Make sure the parent dir exists before any runner writes — the OpenClaw
  // runner writes a pi session file at this path and silently no-ops if
  // the dir is missing.
  await fs.mkdir(chatDir(appDataDir(entry)), { recursive: true }).catch(() => undefined);

  // Per-turn transcript buffer. We append a normalized JSONL entry on
  // every meaningful event so the GET /history endpoint can replay the
  // conversation regardless of which adapter ran it. Lines are pushed
  // batched at the end of the turn (one write call) to avoid stalling
  // on every delta.
  const transcriptEntries: unknown[] = [{ role: 'user', text: message, ts: Date.now() }];
  let assistantBuf = '';

  const recordEvent = (event: ChatStreamEvent): void => {
    switch (event.type) {
      case 'assistant.delta':
        assistantBuf += event.delta;
        return;
      case 'tool.start':
        transcriptEntries.push({
          role: 'tool',
          phase: 'start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          sql: event.sql,
          ts: Date.now(),
        });
        return;
      case 'tool.result':
        transcriptEntries.push({
          role: 'tool',
          phase: 'result',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ok: event.ok,
          result: event.result,
          errorText: event.errorText,
          ts: Date.now(),
        });
        return;
      case 'final':
        if (assistantBuf || event.text) {
          transcriptEntries.push({
            role: 'assistant',
            text: assistantBuf || event.text,
            ts: Date.now(),
          });
          assistantBuf = '';
        }
      // Other event types (start/phase/aborted/error) flow through SSE
      // only; no transcript entry is appended for them.
    }
  };

  const compositeOnEvent = (event: ChatStreamEvent): void => {
    recordEvent(event);
    writeEvent(event);
  };

  const input: ChatRunInput = {
    appId: entry.id,
    windowId,
    sessionFile,
    mode,
    message,
    extraSystemPrompt,
    abortSignal: abortController.signal,
    onEvent: compositeOnEvent,
    ...(body.model ? { model: body.model } : {}),
    ...(body.thinking ? { thinking: body.thinking } : {}),
    ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
  };

  await withWindowLock(entry.id, windowId, async () => {
    let runResult: { adapterSessionId?: string; adapterKind?: string } | undefined;
    try {
      const out = await ctx.runner!.run(input);
      runResult = out ?? undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeEvent({ type: 'error', message: msg });
    } finally {
      clearInterval(heartbeat);
      req.off('close', onClientClose);
      req.off('error', onClientClose);
      // Flush any straggler assistant text (no `final` arrived) as an
      // assistant entry so the transcript is complete.
      if (assistantBuf) {
        transcriptEntries.push({ role: 'assistant', text: assistantBuf, ts: Date.now() });
      }
      await appendTranscript(sessionFile, transcriptEntries).catch(() => undefined);
      await store
        .noteTurn(
          windowId,
          runResult?.adapterKind
            ? {
                kind: runResult.adapterKind,
                ...(runResult.adapterSessionId ? { sessionId: runResult.adapterSessionId } : {}),
              }
            : undefined,
        )
        .catch(() => undefined);
      if (!res.writableEnded) {
        res.write(`event: end\ndata: {}\n\n`);
        res.end();
      }
    }
  });
}

async function appendTranscript(file: string, entries: unknown[]): Promise<void> {
  if (entries.length === 0) return;
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fs.appendFile(file, body, { mode: 0o600 });
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
