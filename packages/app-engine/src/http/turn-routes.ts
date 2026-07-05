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
 * The stream/ledger half of the turn — SSE framing, the event accumulator,
 * the per-session lock, recordTurn/noteTurn — lives in `turn-sse.ts`
 * (shared with the vault assistant's shell-level turn route). This module
 * keeps what is app-shaped: registry lookup, manifest + schema reads, the
 * data/handler system-prompt preamble, and attachment blob resolution.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, readBody, MAX_BODY_BYTES } from './http-utils.js';
import { readAppSchema } from '../data/schema.js';
import { buildExtraPrompt } from '../handlers/build-extra-prompt.js';
import type { ConversationRunner } from '../conversation/runner.js';
import type { ConversationHistoryStore } from '../conversation/history.js';
import { driveTurnOverSse, type TurnAttachmentRef } from './turn-sse.js';
import type { Registry } from '../registry/registry.js';
import { appDataDir } from '../registry/app-paths.js';
import type { RegistryEntry } from '../types.js';
import { APP_MANIFEST_FILE, parseManifest, type Manifest } from '../registry/manifest.js';

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

interface PostBody {
  conversationId?: string;
  message?: string;
  /** Chat register: 'ask' = the app copilot; absent/'build' = builder chat. */
  register?: string;
  model?: string;
  thinking?: string;
  idempotencyKey?: string;
  /** Attachments uploaded ahead of this turn (issue #190). */
  attachments?: TurnAttachmentRef[];
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
  const attachmentRefs: TurnAttachmentRef[] = Array.isArray(body.attachments)
    ? body.attachments.filter(
        (a): a is TurnAttachmentRef =>
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

  await driveTurnOverSse({
    req,
    res,
    appId: entry.id,
    conversationId,
    message,
    dataDir: appDataDir(entry),
    extraSystemPrompt,
    runner: ctx.runner,
    conversationStore: ctx.conversationStore,
    conversationRunnerSessionDir: ctx.conversationRunnerSessionDir,
    conversationLocks: ctx.conversationLocks,
    banner: `chat ${entry.id} session ${conversationId}`,
    register: body.register === 'ask' ? 'ask' : body.register === 'build' ? 'build' : undefined,
    model: body.model,
    thinking: body.thinking,
    idempotencyKey: body.idempotencyKey,
    prevAdapterSessionId,
    prevAdapterKind,
    ...(attachmentRefs.length > 0 ? { attachmentRefs } : {}),
    ...(turnAttachments.length > 0 ? { turnAttachments } : {}),
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
