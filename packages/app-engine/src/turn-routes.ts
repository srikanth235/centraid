// governance: allow-repo-hygiene file-size-limit #190 — attachment ingestion
// wiring (issue #190) tips this cohesive route handler just over the cap.
/*
 * HTTP route handler for the per-app chat surface.
 *
 *   POST    /centraid/<appId>/_turn                        ← send turn (SSE stream)
 *
 * Surface A is now POST-only. The `conversationId` in the POST body is the
 * `conversations` row id in the per-app runtime SQLite. The desktop persists
 * the transcript itself via Surface B (`/_centraid-conversations`); this route only
 * drives the model turn and records turn completion + the runner-resume
 * handle against the session row.
 *
 * The runtime delegates to a host-injected `ConversationRunner`. When no runner is
 * configured, the chat route 503s with a clear error — that is the M1
 * stub behavior the issue calls out.
 *
 * Concurrency: each session has at most one in-flight turn at a time. A
 * second POST against the same conversationId is queued behind the first by a
 * per-session async lock. Within a single process this is the only correctness
 * gate; we don't try to coordinate across processes because the chat surface
 * is owned by one runtime per appsDir.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, readBody, MAX_BODY_BYTES } from './http-utils.js';
import { readAppSchema } from './schema.js';
import { buildExtraPrompt } from './build-extra-prompt.js';
import type {
  ConversationTurnInput,
  ConversationRunner,
  TurnStreamEvent,
} from './conversation-runner.js';
import type { ConversationHistoryStore, TurnNode } from './conversation-history.js';
import type { Registry } from './registry.js';
import { appDataDir } from './app-paths.js';
import type { RegistryEntry } from './types.js';
import { APP_MANIFEST_FILE, parseManifest, type Manifest } from './manifest.js';

/**
 * Validate a chat-session id. Reject anything that could escape a
 * directory (the runner scratch dir uses the id verbatim as a filename) or
 * exceed a sane length. Chat-session ids are caller-supplied — the renderer
 * mints a stable id per chat pane (it's the chat session UUID).
 */
export function isValidConversationId(id: string): boolean {
  if (!id || id.length > 128) return false;
  if (id === 'index.json') return false;
  if (id.startsWith('.')) return false;
  return /^[A-Za-z0-9_\-:]+$/.test(id);
}

/**
 * Dependencies injected from `Runtime`. Pulled out so the chat routes don't
 * need to know about `Runtime` directly (avoids a circular module shape).
 */
export interface TurnRouteContext {
  registry: Registry;
  /**
   * Resolve an app's live code dir, honoring the git-store override
   * (issue #137): under the store backend there is no legacy `current.json`,
   * so a version-based lookup always misses. The chat route reads the
   * manifest from here to splice the declared handler catalog into the
   * system prompt. Returns undefined when the app has no live code.
   */
  resolveCodeDir: (entry: RegistryEntry) => Promise<string | undefined>;
  runner?: ConversationRunner;
  /**
   * Optional central chat store. When set, the route reads the session's
   * runner-resume handle from it and records turn completion back into it.
   * When unset, the route still works — no resume handle is threaded, so
   * each turn starts the adapter fresh.
   */
  conversationStore?: ConversationHistoryStore;
  /**
   * Central scratch base dir for runner-owned session files. The route
   * passes `<conversationRunnerSessionDir>/<conversationId>.jsonl` as `ConversationTurnInput.sessionFile`.
   */
  conversationRunnerSessionDir: string;
  /**
   * Optional per-app metadata reader. Used to populate `appName` / `appDescription`
   * in the extra-system-prompt. Returns undefined when the app has no
   * authored `app.json` yet (freshly registered uploads with no
   * committed version).
   */
  appMeta?: (entry: RegistryEntry) => Promise<{ name?: string; description?: string }>;
  /**
   * Per-runtime chat-session lock map. The `Runtime` instance owns one of
   * these and threads it in here so the `(appId, conversationId)` serialization
   * map is scoped to one gateway. A module-level map would silently collide
   * across gateways that share an appId — two profiles can both install the
   * same template and end up with the same id.
   */
  conversationLocks: Map<string, Promise<void>>;
}

export type ParsedTurnRoute = { kind: 'post'; appId: string };

/**
 * Match the chat sub-routes under `/centraid/<appId>/_turn`. The caller
 * (router.ts) has already established the URL is under `/centraid/<id>/_turn...`.
 *
 * Surface A is POST-only — anything else (including the old `windows...`
 * sub-paths) returns undefined and the caller 404s.
 */
export function parseTurnSubRoute(
  appId: string,
  segments: string[],
  method: string,
): ParsedTurnRoute | undefined {
  // segments here are the path under /centraid/<appId>/ starting with "_turn"
  // segments[0] === "_turn"
  if (segments.length === 1 && method.toUpperCase() === 'POST') {
    return { kind: 'post', appId };
  }
  return undefined;
}

/**
 * Serialize work on `(appId, conversationId)` so a second POST queues behind the
 * first. The route handler awaits the previous tail before scheduling its
 * own. The lock entry is cleared lazily once the current task settles.
 *
 * The lock map is per-runtime — held on the `Runtime` instance and threaded
 * through `TurnRouteContext`. A module-level map would collide across
 * gateways that share an `appId` (two profiles can install the same
 * template). See issue #113.
 */
async function withConversationLock<T>(
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

/** A file uploaded to the blob CAS before the turn, referenced by its hash. */
interface AttachmentRef {
  hash: string;
  mime: string;
  filename?: string;
  sizeBytes?: number;
}

interface PostBody {
  conversationId?: string;
  message?: string;
  model?: string;
  thinking?: string;
  idempotencyKey?: string;
  /** Attachments uploaded ahead of this turn (issue #190). */
  attachments?: AttachmentRef[];
}

const HASH_RE = /^[a-f0-9]{64}$/;

/**
 * Dispatch one chat-route request. Errors thrown out of here are caught by
 * `Runtime.handle`'s catch-all and turned into 500s.
 */
export async function handleTurnRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TurnRouteContext,
  parsed: ParsedTurnRoute,
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
  ctx: TurnRouteContext,
  entry: RegistryEntry,
): Promise<void> {
  if (!ctx.runner) {
    sendError(
      res,
      503,
      'no_conversation_runner',
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

  const conversationId = body.conversationId;
  const message = body.message;
  if (!conversationId || !message) {
    sendError(res, 400, 'bad_request', 'Body must include { conversationId, message }.');
    return;
  }
  if (!isValidConversationId(conversationId)) {
    sendError(res, 400, 'bad_request', 'Invalid conversationId.');
    return;
  }

  // Resolve runner-resume handles from the central session row when a
  // chat store is wired. The chat surface is now one mode — the agent
  // always has the three structured tools plus the `_sql` built-in — so
  // there is no per-session mode toggle to read.
  let prevAdapterSessionId: string | undefined;
  let prevAdapterKind: string | undefined;
  if (ctx.conversationStore) {
    const session = ctx.conversationStore.getSessionMeta(entry.id, conversationId);
    if (!session) {
      sendError(res, 404, 'not_found', 'No such chat session.');
      return;
    }
    prevAdapterSessionId = session.adapterSessionId ?? undefined;
    prevAdapterKind = session.adapterKind ?? undefined;
  }

  // Attachments uploaded ahead of the turn (issue #190): the bytes already
  // live in the per-app blob CAS, keyed by sha256. We resolve each to its
  // on-disk path so the adapter can build an image/document content block, and
  // keep the refs to record `attachments` rows on the turn's `message_in` item.
  const attachmentRefs: AttachmentRef[] = Array.isArray(body.attachments)
    ? body.attachments.filter(
        (a): a is AttachmentRef =>
          !!a && typeof a.hash === 'string' && HASH_RE.test(a.hash) && typeof a.mime === 'string',
      )
    : [];
  const turnAttachments =
    ctx.conversationStore && attachmentRefs.length > 0
      ? attachmentRefs.map((a) => ({
          path: ctx.conversationStore!.blobPathFor(entry.id, a.hash),
          mime: a.mime,
          ...(a.filename !== undefined ? { filename: a.filename } : {}),
        }))
      : [];

  const appMeta = ctx.appMeta ? await ctx.appMeta(entry).catch(() => ({}) as never) : undefined;
  const schema = safeReadSchema(entry);
  const manifest = await safeReadManifest(entry, ctx.resolveCodeDir);
  const extraSystemPrompt = buildExtraPrompt({
    appId: entry.id,
    ...(appMeta?.name ? { appName: appMeta.name } : {}),
    ...(appMeta?.description ? { appDescription: appMeta.description } : {}),
    schema,
    ...(manifest ? { manifest } : {}),
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
  res.write(`: chat ${entry.id} session ${conversationId}\n\n`);
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
  // parent dir exists before any runner writes — the OpenClaw runner hands
  // this path to `runEmbeddedAgent` as its session file and silently no-ops
  // if the parent dir is missing.
  const sessionFile = path.join(ctx.conversationRunnerSessionDir, `${conversationId}.jsonl`);
  await fs.mkdir(ctx.conversationRunnerSessionDir, { recursive: true }).catch(() => undefined);

  const input: ConversationTurnInput = {
    appId: entry.id,
    dataDir: appDataDir(entry),
    conversationId,
    sessionFile,
    message,
    ...(turnAttachments.length > 0 ? { attachments: turnAttachments } : {}),
    extraSystemPrompt,
    abortSignal: abortController.signal,
    onEvent,
    ...(body.model ? { model: body.model } : {}),
    ...(body.thinking ? { thinking: body.thinking } : {}),
    ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
    ...(prevAdapterSessionId ? { prevAdapterSessionId } : {}),
    ...(prevAdapterKind ? { prevAdapterKind } : {}),
  };

  await withConversationLock(ctx.conversationLocks, entry.id, conversationId, async () => {
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
      if (ctx.conversationStore) {
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
          ctx.conversationStore.recordTurn(entry.id, {
            conversationId: conversationId,
            // The runner's surface decides the ledger kind: the builder-capable
            // unified runner reports `'build'`, the data-only runner leaves it
            // unset → recorded as `'chat'` (issue #181). Read statically off the
            // runner so an errored turn (no `ConversationTurnResult`) is still tagged.
            ...(ctx.runner?.runKind ? { kind: ctx.runner.runKind } : {}),
            userMessage: message,
            ...(attachmentRefs.length > 0
              ? {
                  attachments: attachmentRefs.map((a) => ({
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
        // claude-code; the OpenClaw runner resumes via `sessionFile` and
        // returns void).
        try {
          ctx.conversationStore.noteTurn(
            entry.id,
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

/**
 * Read the app's manifest from disk, returning `undefined` when the app
 * has no live code dir or the file is unreadable. The system prompt still
 * works without it — agents are steered to `_sql` — but with the manifest
 * the prompt includes the declared catalog so the agent reaches for the
 * right handler.
 *
 * Resolution goes through the runtime's code-dir resolver so it honors the
 * git-store override (issue #137): the materialized `main` worktree under
 * the store backend has no legacy `current.json`, so resolving by active
 * version would always miss and silently drop the catalog.
 */
async function safeReadManifest(
  entry: RegistryEntry,
  resolveCodeDir: (entry: RegistryEntry) => Promise<string | undefined>,
): Promise<Manifest | undefined> {
  try {
    const codeDir = await resolveCodeDir(entry);
    if (!codeDir) return undefined;
    const text = await fs.readFile(path.join(codeDir, APP_MANIFEST_FILE), 'utf8');
    return parseManifest(text);
  } catch {
    return undefined;
  }
}
