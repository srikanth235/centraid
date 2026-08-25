import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
// governance: allow-repo-hygiene file-size-limit pending split into changes-feed / app-routes modules
import path from "node:path";

import { ChangeBus } from "./changes/change-bus.js";
import type { ConversationHistoryStore } from "./conversation/history.js";
import type { ConversationRunner } from "./conversation/runner.js";
import type { ConversationWorkspaceKind } from "./conversation/schema.js";
import type { HarnessKind } from "./conversation/turn.js";
import { Dispatcher, statusForToolError } from "./handlers/dispatcher.js";
import type { ToolResult } from "./handlers/dispatcher.js";
import type { VaultBridge } from "./handlers/vault-bridge.js";
import { handleAppChanges } from "./http/changes-sse.js";
import { handleLogsRoute, handleSettingsWrite } from "./http/cloud-routes.js";
import { sendJsonNegotiated } from "./http/compression.js";
import { readBody, sendError, sendJson } from "./http/http-utils.js";
import {
  COMPANION_GRANTS_HEADER,
  companionHandlerAllowed,
} from "./http/internal-headers.js";
import { parseWithDraft } from "./http/router.js";
import type { TurnLimiter } from "./http/turn-limiter.js";
import { handleTurnRoute, parseTurnSubRoute } from "./http/turn-routes.js";
import type { AskModelPrefs } from "./http/turn-routes.js";
import { appDataDir } from "./registry/app-paths.js";
import { cleanupDeregisteredApp } from "./registry/deregister-cleanup.js";
import { Registry, RegistryError } from "./registry/registry.js";
import { readAppSettings } from "./settings/app-settings.js";
import type { PrefsStore } from "./stores/prefs-store.js";
import type { AppRef, RegistryEntry } from "./types.js";

const WEB_APP_HEADER = "x-centraid-web-app";

export interface RuntimeLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export interface RuntimeOptions {
  /** A provider re-roots the whole app surface on a vault switch (#280); the
   *  runtime keeps one `Registry` per resolved dir. */
  appsDir: string | (() => string);
  logger?: RuntimeLogger;
  changeBus?: ChangeBus;
  userStore?: PrefsStore;
  conversationHistoryStore?: ConversationHistoryStore;
  conversationRunner?: ConversationRunner;
  conversationHarnessSessionDir?: string | (() => string);
  appMeta?: (
    entry: RegistryEntry
  ) => Promise<{ name?: string; description?: string }>;
  harnessStatus?: (opts?: HarnessStatusOptions) => Promise<HarnessStatus>;
  /** Separates CODE (the git worktree this resolves) from STATE (`entry.path`,
   *  which keeps logs, settings and blobs) — #137. */
  codeDirOverride?: (appId: string) => Promise<string | undefined>;
  /** `undefined` for an unknown session/app falls back to the live code dir,
   *  so the live path is unaffected when no draft resolver is wired (#141). */
  draftCodeDir?: (
    appId: string,
    sessionId: string
  ) => Promise<string | undefined>;
  conversationWorkspaceRoots?: (
    appId: string,
    conversationId: string
  ) => Promise<Partial<Record<ConversationWorkspaceKind, string>>>;
  /** Without it `ctx.vault.*` fails CLOSED with VAULT_UNAVAILABLE. */
  vaultFor?: (appId: string) => VaultBridge;
  timeModuleUrl?: string;
  /** The SAME key `resolveSubsystemModel` reads at turn time, so the picker
   *  and the actual turn always agree. */
  askModel?: AskModelPrefs;
  /** Resolved PER REQUEST, so it bounds turns per ambient vault (#420). */
  turnLimiter?: () => TurnLimiter | undefined;
}

export type ModelTier = "smart" | "balanced" | "fast";

export interface HarnessModel {
  id: string;
  name?: string;
  default?: boolean;
  tier?: ModelTier;
}

/** `ready` means a cached list exists even mid-refresh; `empty` means
 *  enumeration found nothing, CLI-unavailable included. */
export type SurfaceStatus = "loading" | "ready" | "empty";

export interface HarnessStatusOptions {
  refresh?: boolean;
}

export interface HarnessStatus {
  kind: HarnessKind | "none";
  ok: boolean;
  version?: string;
  minVersion?: string;
  versionAtLeast?: boolean;
  reason?: string;
  hint?: string;
  models?: HarnessModel[];
  modelsStatus?: SurfaceStatus;
}

const noopLogger: RuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** The transport-agnostic engine: a host constructs it, calls `bootstrap()`
 *  once, then routes requests through `handle(req, res)`. */
export class Runtime {
  readonly dispatcher: Dispatcher;
  readonly changeBus: ChangeBus;
  readonly userStore?: PrefsStore;
  readonly conversationHistoryStore?: ConversationHistoryStore;
  readonly conversationRunner?: ConversationRunner;
  readonly appMeta?: (
    entry: RegistryEntry
  ) => Promise<{ name?: string; description?: string }>;
  readonly harnessStatus?: (
    opts?: HarnessStatusOptions
  ) => Promise<HarnessStatus>;
  readonly askModel?: AskModelPrefs;
  private readonly turnLimiter?: () => TurnLimiter | undefined;
  private readonly appsDirProvider: () => string;
  private readonly sessionDirProvider: () => string;
  /** One per resolved apps dir: a vault switch lands on a different registry,
   *  loaded by the host's post-switch `bootstrap()` (#280). */
  private readonly registries = new Map<string, Registry>();
  private readonly logger: RuntimeLogger;
  private readonly codeDirOverride?: (
    appId: string
  ) => Promise<string | undefined>;
  private readonly draftCodeDir?: (
    appId: string,
    sessionId: string
  ) => Promise<string | undefined>;
  private readonly conversationWorkspaceRoots?: RuntimeOptions["conversationWorkspaceRoots"];
  /** Per-runtime, never module-level (#113): two gateways sharing an `appId`
   *  must not collide on one lock key. */
  private readonly conversationLocks = new Map<string, Promise<void>>();

  constructor(opts: RuntimeOptions) {
    this.appsDirProvider =
      typeof opts.appsDir === "string"
        ? (
            (dir) => () =>
              dir
          )(opts.appsDir)
        : opts.appsDir;
    this.logger = opts.logger ?? noopLogger;
    this.changeBus = opts.changeBus ?? new ChangeBus({ logger: this.logger });
    this.userStore = opts.userStore;
    this.conversationHistoryStore = opts.conversationHistoryStore;
    this.conversationRunner = opts.conversationRunner;
    const sessionDir =
      opts.conversationHarnessSessionDir ??
      path.join(os.tmpdir(), "centraid-conversation-harness-sessions");
    this.sessionDirProvider =
      typeof sessionDir === "string" ? () => sessionDir : sessionDir;
    this.appMeta = opts.appMeta;
    this.harnessStatus = opts.harnessStatus;
    this.askModel = opts.askModel;
    if (opts.turnLimiter) this.turnLimiter = opts.turnLimiter;
    if (opts.codeDirOverride) this.codeDirOverride = opts.codeDirOverride;
    if (opts.draftCodeDir) this.draftCodeDir = opts.draftCodeDir;
    if (opts.conversationWorkspaceRoots) {
      this.conversationWorkspaceRoots = opts.conversationWorkspaceRoots;
    }
    this.dispatcher = new Dispatcher({
      registry: () => this.registry,
      onWriteFor: (appId) => this.emitForApp(appId, "handler"),
      ...(this.codeDirOverride
        ? { codeDirOverride: this.codeDirOverride }
        : {}),
      ...(opts.vaultFor ? { vaultFor: opts.vaultFor } : {}),
      ...(opts.timeModuleUrl ? { timeModuleUrl: opts.timeModuleUrl } : {}),
    });
  }

  private get appsDir(): string {
    return this.appsDirProvider();
  }

  get registry(): Registry {
    const dir = this.appsDir;
    const cached = this.registries.get(dir);
    if (cached) return cached;
    const fresh = new Registry(dir);
    this.registries.set(dir, fresh);
    return fresh;
  }

  get conversationHarnessSessionDir(): string {
    return this.sessionDirProvider();
  }

  private emitForApp(
    appId: string,
    source: "handler" | "external"
  ): (tables: string[]) => void {
    // Empty `tables` still notifies: handler writes ride ctx.vault, so "the
    // app acted" is all the runtime knows.
    return (tables) => {
      this.changeBus.emit({ appId, tables, ts: Date.now(), source });
    };
  }

  assistantEmitForApp(
    appId: string
  ): (payload: {
    tables: string[];
    toolCallId?: string;
    turnId?: string;
  }) => void {
    return (payload) => {
      this.changeBus.emit({
        appId,
        tables: payload.tables,
        ts: Date.now(),
        source: "assistant",
        ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
        ...(payload.turnId ? { turnId: payload.turnId } : {}),
      });
    };
  }

  async bootstrap(): Promise<void> {
    await this.registry.load();
  }

  private turnRouteContext() {
    return {
      registry: this.registry,
      resolveCodeDir: (entry: RegistryEntry) => this.resolveCodeDir(entry),
      ...(this.conversationWorkspaceRoots
        ? {
            workspaceRoots: (entry: RegistryEntry, conversationId: string) =>
              this.conversationWorkspaceRoots!(entry.id, conversationId),
          }
        : {}),
      runner: this.conversationRunner,
      conversationStore: this.conversationHistoryStore,
      conversationHarnessSessionDir: this.conversationHarnessSessionDir,
      appMeta: this.appMeta,
      conversationLocks: this.conversationLocks,
      ...(this.askModel ? { askModel: this.askModel } : {}),
      ...(this.turnLimiter ? { turnLimiter: this.turnLimiter } : {}),
    };
  }

  private async resolveCodeDir(
    entry: RegistryEntry
  ): Promise<string | undefined> {
    // Mirrors `Dispatcher.resolveCodeDir`: no override ⇒ no servable code.
    return this.codeDirOverride ? this.codeDirOverride(entry.id) : undefined;
  }

  private refOf(entry: RegistryEntry): AppRef {
    return { id: entry.id, dir: appDataDir(entry) };
  }

  /** The ONLY path non-MCP callers take to invoke handlers (#505). Maps the
   *  MCP-shaped `ToolResult` to HTTP via `statusForToolError`. */
  private async handleAppRpc(
    req: IncomingMessage,
    res: ServerResponse,
    kind: "action" | "query",
    appId: string,
    handlerName: string,
    draftSessionId?: string
  ): Promise<void> {
    if (!this.enforceWebAppScope(req, res, appId)) return;

    const companionProfile = req.headers[COMPANION_GRANTS_HEADER];
    if (typeof companionProfile === "string") {
      const allowed = new Set(companionProfile.split(",").filter(Boolean));
      if (!companionHandlerAllowed(allowed, kind, appId, handlerName)) {
        sendError(
          res,
          403,
          "app_session_scope",
          "This Companion device has no grant for that module operation."
        );
        return;
      }
    }

    let body: Record<string, unknown> = {};
    try {
      const raw = (await readBody(req)).toString("utf8");
      if (raw.length > 0) {
        const parsed = JSON.parse(raw) as unknown;
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed)
        ) {
          sendError(
            res,
            400,
            "bad_request",
            "Request body must be a JSON object."
          );
          return;
        }
        body = parsed as Record<string, unknown>;
      }
    } catch (error) {
      sendError(
        res,
        400,
        "bad_request",
        `request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    const overrideCodeDir = await this.draftOverride(appId, draftSessionId);
    const result =
      kind === "action"
        ? await this.dispatcher.write(
            {
              app: appId,
              action: handlerName,
              input: body.input,
              ...(typeof body.intentId === "string"
                ? { intentId: body.intentId }
                : {}),
            },
            overrideCodeDir
          )
        : await this.dispatcher.read(
            { app: appId, query: handlerName, input: body.input },
            overrideCodeDir
          );
    await this.sendToolResult(req, res, result);
  }

  private async handleAppDescribe(
    req: IncomingMessage,
    res: ServerResponse,
    appId: string,
    query: Record<string, string>,
    draftSessionId?: string
  ): Promise<void> {
    if (!this.enforceWebAppScope(req, res, appId)) return;
    const overrideCodeDir = await this.draftOverride(appId, draftSessionId);
    const result = await this.dispatcher.describe(
      {
        app: appId,
        ...(typeof query.action === "string" ? { action: query.action } : {}),
        ...(typeof query.query === "string" ? { query: query.query } : {}),
      },
      overrideCodeDir
    );
    await this.sendToolResult(req, res, result);
  }

  private enforceWebAppScope(
    req: IncomingMessage,
    res: ServerResponse,
    appId: string
  ): boolean {
    const webApp = req.headers[WEB_APP_HEADER];
    if (typeof webApp === "string" && webApp !== appId) {
      sendError(
        res,
        403,
        "app_session_scope",
        "This browser session is scoped to another app."
      );
      return false;
    }
    return true;
  }

  private async draftOverride(
    appId: string,
    draftSessionId?: string
  ): Promise<string | undefined> {
    return draftSessionId && this.draftCodeDir && appId
      ? this.draftCodeDir(appId, draftSessionId)
      : undefined;
  }

  /** Negotiates br/gzip off Accept-Encoding (#404); the PWA service-worker
   *  path never forwards it, so it receives raw JSON. */
  private async sendToolResult(
    req: IncomingMessage,
    res: ServerResponse,
    result: ToolResult
  ): Promise<void> {
    if (result.isError) {
      await sendJsonNegotiated(
        req,
        res,
        statusForToolError(result.structuredContent.code),
        result.structuredContent
      );
      return;
    }
    await sendJsonNegotiated(req, res, 200, result.structuredContent ?? null);
  }

  /** Assumes the host has ALREADY authenticated the caller: app-engine
   *  enforces no auth of its own. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { route, draftSessionId } = parseWithDraft(
      req.method ?? "GET",
      req.url ?? "/"
    );

    try {
      switch (route.kind) {
        case "registry-list": {
          sendJson(
            res,
            200,
            this.registry.list().map((e) => ({
              id: e.id,
              path: e.path,
              registeredAt: e.registeredAt,
            }))
          );
          return;
        }

        case "registry-deregister": {
          const removed = await this.registry.deregister(route.appId);
          if (!removed) {
            sendError(res, 404, "not_found", "App not registered.");
            return;
          }
          await cleanupDeregisteredApp(this.appsDir, removed, this.logger);
          sendJson(res, 200, { id: route.appId });
          return;
        }

        case "app-settings-read": {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, "not_found", "App not registered.");
            return;
          }
          sendJson(res, 200, { settings: readAppSettings(entry.path) });
          return;
        }

        case "app-settings-write": {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, "not_found", "App not registered.");
            return;
          }
          await handleSettingsWrite(req, res, entry.path);
          return;
        }

        case "app-changes": {
          await handleAppChanges(req, res, this.changeBus, route.appId);
          return;
        }

        case "app-logs": {
          await handleLogsRoute(res, this.registry, route.appId, route.query);
          return;
        }

        case "app-action": {
          await this.handleAppRpc(
            req,
            res,
            "action",
            route.appId,
            route.action,
            draftSessionId
          );
          return;
        }

        case "app-query": {
          await this.handleAppRpc(
            req,
            res,
            "query",
            route.appId,
            route.query,
            draftSessionId
          );
          return;
        }

        case "app-describe": {
          await this.handleAppDescribe(
            req,
            res,
            route.appId,
            route.query,
            draftSessionId
          );
          return;
        }

        case "app-chat": {
          const parsed = parseTurnSubRoute(
            route.appId,
            route.segments,
            req.method ?? "GET"
          );
          if (!parsed) {
            sendError(res, 404, "not_found", "Unknown chat sub-route.");
            return;
          }
          await handleTurnRoute(req, res, this.turnRouteContext(), parsed);
          return;
        }

        case "app-harness-status": {
          if (!this.harnessStatus) {
            sendJson(res, 200, {
              kind: "none",
              ok: false,
              reason: "no runner configured",
            });
            return;
          }
          const status = await this.harnessStatus({ refresh: route.refresh });
          sendJson(res, 200, status);
          return;
        }

        case "not-found":
          sendError(res, 404, "not_found", "Unknown centraid path.");
      }
    } catch (error) {
      if (error instanceof RegistryError) {
        const status =
          error.code === "invalid_id"
            ? 400
            : error.code === "already_registered"
              ? 409
              : error.code === "not_a_directory"
                ? 400
                : 404;
        sendError(res, status, error.code, error.message);
        return;
      }
      sendError(
        res,
        500,
        "internal_error",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
}
