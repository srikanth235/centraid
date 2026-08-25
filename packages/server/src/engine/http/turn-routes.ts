/*
 * HTTP routes for the per-app chat surface. The stream/ledger half — SSE
 * framing, the accumulator, the per-session lock, recordTurn/noteTurn — lives
 * in `turn-sse.ts`, shared with the vault assistant's route. This module keeps
 * what is APP-shaped: registry lookup, manifest reads, the handler-catalog
 * preamble, and attachment resolution.
 */

import { promises as fs } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { ConversationHistoryStore } from "../conversation/history.js";
import type { ConversationRunner } from "../conversation/runner.js";
import type { ConversationWorkspaceKind } from "../conversation/schema.js";
import { isHarnessKind } from "../conversation/turn.js";
import type * as TypeImport_nu6ai6 from "../conversation/turn.js";
import { buildExtraPrompt } from "../handlers/build-extra-prompt.js";
import { appDataDir } from "../registry/app-paths.js";
import { APP_MANIFEST_FILE, parseManifest } from "../registry/manifest.js";
import type { Manifest } from "../registry/manifest.js";
import type { Registry } from "../registry/registry.js";
import type { RegistryEntry } from "../types.js";
import { sendError, sendJson, readBody, MAX_BODY_BYTES } from "./http-utils.js";
import type { TurnLimiter } from "./turn-limiter.js";
import {
  driveTurnOverSse,
  parseAdditionalDirectories,
  parseWorkspaceKind,
  parseTurnAttachmentRefs,
  resolveTurnAttachments,
  validateTurnAttachmentRefs,
} from "./turn-sse.js";
import type { TurnAttachmentRef } from "./turn-sse.js";

/** Ids are CALLER-supplied and used verbatim as a scratch filename. */
export function isValidConversationId(id: string): boolean {
  if (!id || id.length > 128) return false;
  if (id === "index.json") return false;
  if (id.startsWith(".")) return false;
  return /^[A-Za-z0-9_\-:]+$/u.test(id);
}

export interface AskModelOption {
  id: string;
  label: string;
}

export interface AskModelInfo {
  harnessKind: string;
  defaultModel?: string;
  current: string | null;
  catalog: AskModelOption[];
}

export interface AskModelPrefs {
  get: () => Promise<AskModelInfo>;
  set: (model: string | null) => Promise<void>;
}

/** Injected so these routes never import `Runtime` (a circular shape). */
export interface TurnRouteContext {
  registry: Registry;
  /** Honors the git-store override: there is no `current.json` (#137). */
  resolveCodeDir: (entry: RegistryEntry) => Promise<string | undefined>;
  workspaceRoots?: (
    entry: RegistryEntry,
    conversationId: string
  ) => Promise<Partial<Record<ConversationWorkspaceKind, string>>>;
  runner?: ConversationRunner;
  /** Unset ⇒ no resume handle is threaded and each turn starts fresh. */
  conversationStore?: ConversationHistoryStore;
  conversationHarnessSessionDir: string;
  appMeta?: (
    entry: RegistryEntry
  ) => Promise<{ name?: string; description?: string }>;
  /** Never module-level: two gateways can collide on appId. */
  conversationLocks: Map<string, Promise<void>>;
  /** Resolved PER REQUEST, so it bounds turns per vault, not per gateway
   *  (#420). Absent ⇒ unbounded. */
  turnLimiter?: () => TurnLimiter | undefined;
  /** Same machinery `resolveSubsystemModel` uses, so picker and turn agree. */
  askModel?: AskModelPrefs;
}

export type ParsedTurnRoute =
  | { kind: "post"; appId: string }
  | { kind: "get-model"; appId: string }
  | { kind: "put-model"; appId: string };

export function parseTurnSubRoute(
  appId: string,
  segments: string[],
  method: string
): ParsedTurnRoute | undefined {
  const m = method.toUpperCase();
  if (segments.length === 1 && m === "POST") {
    return { kind: "post", appId };
  }
  if (segments.length === 2 && segments[1] === "model") {
    if (m === "GET") return { kind: "get-model", appId };
    if (m === "PUT") return { kind: "put-model", appId };
  }
  return undefined;
}

interface PostBody {
  conversationId?: string;
  message?: string;
  register?: string;
  model?: string;
  harnessKind?: string;
  thinking?: string;
  idempotencyKey?: string;
  retryOf?: string;
  attachments?: TurnAttachmentRef[];
  providerConsent?: unknown;
  workspaceKind?: unknown;
  additionalDirectories?: unknown;
}

export async function handleTurnRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TurnRouteContext,
  parsed: ParsedTurnRoute
): Promise<void> {
  const entry = ctx.registry.get(parsed.appId);
  if (!entry) {
    sendError(res, 404, "not_found", "App not registered.");
    return;
  }
  if (parsed.kind === "get-model") {
    await handleGetAskModel(res, ctx);
    return;
  }
  if (parsed.kind === "put-model") {
    await handlePutAskModel(req, res, ctx);
    return;
  }
  await handlePostTurn(req, res, ctx, entry);
}

async function handleGetAskModel(
  res: ServerResponse,
  ctx: TurnRouteContext
): Promise<void> {
  if (!ctx.askModel) {
    sendError(
      res,
      503,
      "no_model_prefs",
      "Model preferences are not configured for this runtime."
    );
    return;
  }
  sendJson(res, 200, await ctx.askModel.get());
}

async function handlePutAskModel(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TurnRouteContext
): Promise<void> {
  if (!ctx.askModel) {
    sendError(
      res,
      503,
      "no_model_prefs",
      "Model preferences are not configured for this runtime."
    );
    return;
  }
  let body: { model?: string | null };
  try {
    const raw = await readBody(req);
    body =
      raw.length === 0
        ? {}
        : (JSON.parse(raw.toString("utf8")) as { model?: string | null });
  } catch {
    sendError(res, 400, "bad_request", "Invalid JSON body.");
    return;
  }
  if (
    body.model !== null &&
    body.model !== undefined &&
    typeof body.model !== "string"
  ) {
    sendError(
      res,
      400,
      "bad_request",
      "Body must be { model: string | null }."
    );
    return;
  }
  await ctx.askModel.set(body.model ?? null);
  sendJson(res, 200, await ctx.askModel.get());
}

async function handlePostTurn(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: TurnRouteContext,
  entry: RegistryEntry
): Promise<void> {
  if (!ctx.runner) {
    sendError(
      res,
      503,
      "no_conversation_runner",
      "No chat runner is configured for this runtime. The host must inject one."
    );
    return;
  }

  let body: PostBody;
  try {
    const raw = await readBody(req);
    body =
      raw.length === 0 ? {} : (JSON.parse(raw.toString("utf8")) as PostBody);
  } catch (error) {
    const message =
      error instanceof Error && error.message.includes("1 MiB")
        ? `Request body exceeds ${MAX_BODY_BYTES} bytes.`
        : "Invalid JSON body.";
    sendError(res, 400, "bad_request", message);
    return;
  }

  const conversationId = body.conversationId;
  const message = body.message;
  if (!conversationId || !message) {
    sendError(
      res,
      400,
      "bad_request",
      "Body must include { conversationId, message }."
    );
    return;
  }
  if (!isValidConversationId(conversationId)) {
    sendError(res, 400, "bad_request", "Invalid conversationId.");
    return;
  }
  // The client re-sends the WHOLE set, so a second cross-provider switch
  // cannot revoke the first; a bare string is a one-element set (#567).
  const providerConsent = Array.isArray(body.providerConsent)
    ? body.providerConsent
    : body.providerConsent === undefined
      ? []
      : [body.providerConsent];
  if (!providerConsent.every((kind) => isHarnessKind(kind))) {
    sendError(
      res,
      400,
      "bad_request",
      "providerConsent must name registered harnesses."
    );
    return;
  }
  if (body.harnessKind !== undefined && !isHarnessKind(body.harnessKind)) {
    sendError(
      res,
      400,
      "bad_request",
      "harnessKind must name a registered harness."
    );
    return;
  }
  const requestedWorkspaceKind = parseWorkspaceKind(body.workspaceKind);
  if (body.workspaceKind !== undefined && !requestedWorkspaceKind) {
    sendError(
      res,
      400,
      "bad_request",
      "workspaceKind must be one of vault-data, app, or draft."
    );
    return;
  }

  let prevHarnessSessionId: string | undefined;
  let prevHarnessKind: string | undefined;
  let prevHarnessUsageSnapshot:
    | TypeImport_nu6ai6.HarnessUsageSnapshot
    | undefined;
  if (ctx.conversationStore) {
    const session = ctx.conversationStore.getSessionMeta(
      entry.id,
      conversationId
    );
    if (!session) {
      sendError(res, 404, "not_found", "No such chat session.");
      return;
    }
    const resume = ctx.conversationStore.getHarnessResumeState(
      entry.id,
      conversationId,
      isHarnessKind(body.harnessKind) ? body.harnessKind : undefined
    );
    prevHarnessSessionId = resume?.sessionId;
    prevHarnessKind = resume?.kind;
    prevHarnessUsageSnapshot = resume?.usageSnapshot;
  }

  // The bytes already live in the per-app blob CAS (#190); the refs are kept
  // to record `attachments` rows on the turn's `message_in` item.
  const attachmentRefs: TurnAttachmentRef[] = validateTurnAttachmentRefs(
    ctx.conversationStore,
    entry.id,
    parseTurnAttachmentRefs(body.attachments)
  );
  const turnAttachments = resolveTurnAttachments(
    ctx.conversationStore,
    entry.id,
    attachmentRefs
  );
  const savedWorkspace = ctx.conversationStore?.getWorkspaceSelection(
    entry.id,
    conversationId
  );
  const workspaceRoots = ctx.workspaceRoots
    ? await ctx.workspaceRoots(entry, conversationId)
    : { app: appDataDir(entry) };
  const defaultWorkspaceKind: ConversationWorkspaceKind =
    body.register !== "ask" && workspaceRoots.draft ? "draft" : "app";
  const workspaceKind =
    requestedWorkspaceKind ??
    savedWorkspace?.primaryKind ??
    defaultWorkspaceKind;
  const unresolvedWorkspaceDirectory = workspaceRoots[workspaceKind];
  if (!unresolvedWorkspaceDirectory) {
    sendError(
      res,
      400,
      "bad_request",
      `The ${workspaceKind} workspace is unavailable here.`
    );
    return;
  }
  let workspaceDirectory: string;
  let additionalDirectories = savedWorkspace?.additionalDirectories ?? [];
  try {
    workspaceDirectory = await fs.realpath(unresolvedWorkspaceDirectory);
    if (body.additionalDirectories !== undefined) {
      additionalDirectories = await parseAdditionalDirectories(
        body.additionalDirectories
      );
    }
  } catch (error) {
    sendError(
      res,
      400,
      "bad_request",
      error instanceof Error ? error.message : "Invalid workspace selection."
    );
    return;
  }
  additionalDirectories = additionalDirectories.filter(
    (directory) => directory !== workspaceDirectory
  );
  if (ctx.conversationStore) {
    ctx.conversationStore.setWorkspaceSelection(
      entry.id,
      conversationId,
      workspaceKind,
      additionalDirectories
    );
  }

  const appMeta = ctx.appMeta
    ? await ctx.appMeta(entry).catch(() => ({}) as never)
    : undefined;
  const manifest = await safeReadManifest(entry, ctx.resolveCodeDir);
  const extraSystemPrompt = buildExtraPrompt({
    appId: entry.id,
    ...(appMeta?.name ? { appName: appMeta.name } : {}),
    ...(appMeta?.description ? { appDescription: appMeta.description } : {}),
    ...(manifest ? { manifest } : {}),
  });

  await driveTurnOverSse({
    req,
    res,
    appId: entry.id,
    conversationId,
    message,
    dataDir: appDataDir(entry),
    workspaceKind,
    workspaceDirectory,
    extraSystemPrompt,
    runner: ctx.runner,
    conversationStore: ctx.conversationStore,
    conversationHarnessSessionDir: ctx.conversationHarnessSessionDir,
    conversationLocks: ctx.conversationLocks,
    banner: `chat ${entry.id} session ${conversationId}`,
    register:
      body.register === "ask"
        ? "ask"
        : body.register === "build"
          ? "build"
          : undefined,
    model: body.model,
    ...(isHarnessKind(body.harnessKind)
      ? { harnessKind: body.harnessKind }
      : {}),
    thinking: body.thinking,
    ...(providerConsent.length > 0 ? { providerConsent } : {}),
    ...(additionalDirectories.length ? { additionalDirectories } : {}),
    idempotencyKey: body.idempotencyKey,
    ...(typeof body.retryOf === "string" && body.retryOf
      ? { retryOf: body.retryOf }
      : {}),
    ...(ctx.turnLimiter ? { limiter: ctx.turnLimiter() } : {}),
    prevHarnessSessionId,
    prevHarnessKind,
    prevHarnessUsageSnapshot,
    ...(attachmentRefs.length > 0 ? { attachmentRefs } : {}),
    ...(turnAttachments.length > 0 ? { turnAttachments } : {}),
  });
}

/** `undefined` when unreadable — the prompt still works, without the declared
 *  catalog. Goes through the runtime's resolver for the git-store override. */
async function safeReadManifest(
  entry: RegistryEntry,
  resolveCodeDir: (entry: RegistryEntry) => Promise<string | undefined>
): Promise<Manifest | undefined> {
  try {
    const codeDir = await resolveCodeDir(entry);
    if (!codeDir) return undefined;
    const text = await fs.readFile(
      path.join(codeDir, APP_MANIFEST_FILE),
      "utf8"
    );
    return parseManifest(text);
  } catch {
    return undefined;
  }
}
