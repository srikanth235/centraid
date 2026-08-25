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
  /**
   * Directory holding app folders + `_registry.json` — or a provider that
   * resolves it per call. The gateway wires "the ACTIVE vault's workspace
   * apps dir" (#280: apps are vault assets), so a vault switch re-roots the
   * whole app surface; the runtime keeps one `Registry` per resolved dir.
   */
  appsDir: string | (() => string);
  logger?: RuntimeLogger;
  /**
   * Optional change bus. When omitted the runtime constructs an internal
   * one, exposed as `runtime.changeBus` for hosts that want to subscribe
   * from outside.
   */
  changeBus?: ChangeBus;
  /**
   * Optional device-prefs store (a JSON file — #280 killed the identity
   * DB). Hosts (the standalone daemon, desktop local-runtime) construct the
   * store themselves and mount `/_centraid-user/*` for the shells to
   * read/write prefs.
   */
  userStore?: PrefsStore;
  /**
   * Optional conversation-history store backing the chat surface.
   * Conversations live in the ACTIVE vault's `journal.db` (#280;
   * `conversations.user_id` is application-enforced — no cross-file FK).
   * When provided, `startRuntimeHttpServer` mounts
   * `/_centraid-conversations/*` against it.
   */
  conversationHistoryStore?: ConversationHistoryStore;
  /**
   * Optional per-app chat runner. When provided, `POST /centraid/<id>/_turn`
   * drives a model turn via this harness — `@centraid/server/acp`'s
   * `makeConversationRunner` (drives codex app-server / Claude SDK locally).
   *
   * Without a harness the chat routes 503 with `no_conversation_runner`. Hosts
   * decide whether to inject one — single-app standalone setups, tests,
   * and worker subprocesses all run fine without it.
   */
  conversationRunner?: ConversationRunner;
  /**
   * Scratch base dir for harness-owned conversation session files — or a provider
   * (the gateway wires the ACTIVE vault's `harness-sessions/` dir, #280).
   * The `POST /centraid/<id>/_turn` route passes `<dir>/<conversationId>.jsonl`
   * as `ConversationTurnInput.sessionFile`. Defaults to an OS-tmpdir path
   * when omitted.
   */
  conversationHarnessSessionDir?: string | (() => string);
  /**
   * Optional reader for per-app metadata (name, description). The chat
   * route uses it to populate the `extraSystemPrompt` it hands to the
   * runner. Both hosts wire a host-injected app.json reader through.
   * Defaults to "no metadata" — chat still works, just with the bare
   * app-id as the display name.
   */
  appMeta?: (
    entry: RegistryEntry
  ) => Promise<{ name?: string; description?: string }>;
  /**
   * Optional preflight reporter for the gateway-wide
   * `GET /centraid/_turn/harness-status` route. Returns the host's view of
   * each harness's readiness so the chat panel can show a Setup screen
   * instead of failing per-turn when the CLI is missing or unauthenticated.
   */
  harnessStatus?: (opts?: HarnessStatusOptions) => Promise<HarnessStatus>;
  /**
   * Optional code-dir resolver (#137). When provided, the runtime
   * runs handlers from whatever dir this returns for an
   * app id — the gateway injects an apps-store-backed resolver pointing
   * at the live git worktree (`worktrees/main/<sha>/apps/<id>/`) instead
   * of the legacy `<appsDir>/<id>/versions/<active>/`. `entry.path` (the
   * registry's per-app dir) still holds runtime state (logs, settings.json,
   * blobs), so this cleanly separates code (git) from state (stable dir).
   */
  codeDirOverride?: (appId: string) => Promise<string | undefined>;
  /**
   * Optional DRAFT code-dir resolver (#141, draft preview). When
   * provided, RPC requests under `/centraid/_draft/<sessionId>/<appId>/…`
   * run handlers from whatever dir this returns for `(appId, sessionId)` —
   * the gateway injects an apps-store-backed resolver pointing at the
   * session worktree's `apps/<id>/`. Returns `undefined` for an unknown
   * session/app, which falls back to the app's live code dir, so the live
   * path is wholly unaffected when no draft resolver is configured.
   */
  draftCodeDir?: (
    appId: string,
    sessionId: string
  ) => Promise<string | undefined>;
  /** Host-owned Centraid roots exposed through the per-conversation selector. */
  conversationWorkspaceRoots?: (
    appId: string,
    conversationId: string
  ) => Promise<Partial<Record<ConversationWorkspaceKind, string>>>;
  /**
   * Optional per-app `ctx.vault` bridge factory (duaility §12). The gateway
   * injects one when a vault plane is mounted; handlers then reach the
   * owner's canonical vault through a consent-checked host-side executor.
   * Without it, `ctx.vault.*` calls fail closed with VAULT_UNAVAILABLE.
   */
  vaultFor?: (appId: string) => VaultBridge;
  /** Host-resolved module URL mounted as deterministic handler `ctx.time`. */
  timeModuleUrl?: string;
  /**
   * Optional ask-model picker backing (subsystem `ask`). When provided,
   * `GET`/`PUT /centraid/<id>/_turn/model` let the kit Ask panel's inline
   * model picker read/set the `model.<harnessKind>.ask` prefs override —
   * the SAME key `resolveSubsystemModel` reads at turn time, so the
   * picker and the actual turn always agree. Without it those routes 503.
   */
  askModel?: AskModelPrefs;
  /**
   * Optional per-vault turn-concurrency gate (#420). Resolved per request
   * so it bounds running turns per ambient vault. Wired by the gateway; absent
   * in embedded/hermetic hosts → unbounded.
   */
  turnLimiter?: () => TurnLimiter | undefined;
}

/** Provider-agnostic capability tier a model is classified into. */
export type ModelTier = "smart" | "balanced" | "fast";

/**
 * One model a runtime can serve, as surfaced by a runtime that can
 * enumerate its catalog. The `id` is what the chat picker persists and
 * hands back as the chat model.
 */
export interface HarnessModel {
  /** Stable model id passed back as the chat model (e.g. "openai-codex/gpt-5.5"). */
  id: string;
  /** Human-friendly label for the picker; falls back to `id` when absent. */
  name?: string;
  /** `true` for the runtime's default / configured model. */
  default?: boolean;
  /**
   * Capability tier the model was classified into, used by the picker to
   * group concrete models (smart / balanced / fast). Absent when the runtime
   * hasn't classified its catalog yet.
   */
  tier?: ModelTier;
}

/**
 * Load state of a host-capability surface (models / tools) in the gateway-owned
 * catalog. `loading` = enumeration in flight, nothing cached yet; `ready` = a
 * cached list is available (even while a refresh re-enumerates); `empty` =
 * enumeration finished or never ran and found nothing (incl. CLI unavailable).
 * Lives here (not agent-runtime) because `HarnessStatus` carries it and
 * app-engine is the lower layer; agent-runtime re-exports it.
 */
export type SurfaceStatus = "loading" | "ready" | "empty";

/** Options for the harness-status reporter (e.g. force a model reclassify). */
export interface HarnessStatusOptions {
  /** Force a fresh model-tier classification rather than serving the cache. */
  refresh?: boolean;
}

/**
 * Shape returned by the harness-status preflight route. Both hosts share
 * the schema, reporting the configured harness.
 */
export interface HarnessStatus {
  kind: HarnessKind | "none";
  ok: boolean;
  /** Adapter version string when detectable (e.g. "codex 0.20.4"). */
  version?: string;
  /**
   * Minimum CLI version whose event/flag schema we've verified end-to-end.
   * The chat panel shows this alongside the installed version.
   */
  minVersion?: string;
  /**
   * `true` when the installed version is >= `minVersion`. `false` when
   * the user's CLI is older than what we've tested — the harness may
   * still work but we surface the mismatch so users know. `undefined`
   * when we couldn't parse a semver from the CLI's `--version` output.
   */
  versionAtLeast?: boolean;
  /** Reason for `ok: false` (or for a `versionAtLeast: false` warning). */
  reason?: string;
  /** Caller-facing hint (install link, settings path …). */
  hint?: string;
  /**
   * Models the runtime can serve, read from the gateway-owned catalog. Absent
   * until the catalog has been warmed (boot or Refresh enumerates and persists);
   * `modelsStatus` distinguishes "still enumerating" from "enumerated empty".
   */
  models?: HarnessModel[];
  /**
   * Load state of the model list above — lets the chat picker show a loading
   * placeholder before the first warm completes, vs an empty state when the
   * harness reports no models. Absent when the host doesn't track a catalog.
   */
  modelsStatus?: SurfaceStatus;
}

const noopLogger: RuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * The centraid runtime engine, decoupled from any specific transport.
 *
 * A host (the standalone daemon, in-process Electron embed, ...) constructs
 * a `Runtime`, calls `bootstrap()` once, then routes inbound HTTP requests
 * through `handle(req, res)`. `onCronChanged` is forwarded by the host when
 * the scheduler reports a job state transition.
 */
export class Runtime {
  /**
   * Declared-handler dispatcher (#107). Exposed so hosts can
   * delegate here (the app RPC routes for app UIs do) rather than
   * re-implementing the manifest + validation surface.
   */
  readonly dispatcher: Dispatcher;
  /**
   * Per-app change notification bus. Subscribed by the `/centraid/<id>/_changes`
   * SSE endpoint and emitted by `runQuery` (HTTP path) and `handler-runner`
   * (app action writes). Hosts can subscribe from outside too — e.g. to add
   * a write-driven log line.
   */
  readonly changeBus: ChangeBus;
  /**
   * Optional device-prefs store. Hosts mount it on their own HTTP surface as
   * `/_centraid-user/*` so the shells can read/write prefs over HTTP.
   */
  readonly userStore?: PrefsStore;
  /** Optional conversation-history store. See `RuntimeOptions.conversationHistoryStore`. */
  readonly conversationHistoryStore?: ConversationHistoryStore;
  /** Optional per-app chat runner. See `RuntimeOptions.conversationRunner`. */
  readonly conversationRunner?: ConversationRunner;
  /** Optional app-metadata reader for chat extra-system-prompt. */
  readonly appMeta?: (
    entry: RegistryEntry
  ) => Promise<{ name?: string; description?: string }>;
  /** Optional harness-status preflight. */
  readonly harnessStatus?: (
    opts?: HarnessStatusOptions
  ) => Promise<HarnessStatus>;
  /** Optional ask-model picker backing. See `RuntimeOptions.askModel`. */
  readonly askModel?: AskModelPrefs;
  /** Optional per-vault turn-concurrency gate. See `RuntimeOptions.turnLimiter`. */
  private readonly turnLimiter?: () => TurnLimiter | undefined;
  private readonly appsDirProvider: () => string;
  private readonly sessionDirProvider: () => string;
  /**
   * One `Registry` per resolved apps dir (#280: the dir follows the active
   * vault, so a switch lands on a different registry; each is loaded by the
   * host's post-switch `bootstrap()` call before requests hit it).
   */
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
  /**
   * Per-runtime (and therefore per-gateway) chat-session lock map for the
   * `(appId, conversationId)` chat serialization. Per-runtime and not
   * module-level (#113) so two gateways that happen to share an
   * `appId` (same template installed in two profiles) don't collide on the
   * same lock key.
   */
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

  /** The current apps dir — follows the active vault when a provider was given. */
  private get appsDir(): string {
    return this.appsDirProvider();
  }

  /** The registry of the CURRENT apps dir (one cached instance per dir). */
  get registry(): Registry {
    const dir = this.appsDir;
    const cached = this.registries.get(dir);
    if (cached) return cached;
    const fresh = new Registry(dir);
    this.registries.set(dir, fresh);
    return fresh;
  }

  /** Scratch base dir for harness-owned conversation session files (per active vault). */
  get conversationHarnessSessionDir(): string {
    return this.sessionDirProvider();
  }

  /**
   * Build a closure that emits a change for the given app. Each caller picks
   * its provenance band — `'handler'` for app-authored action writes,
   * `'external'` for cloud-panel SQL writes, etc. Harness writes flow through
   * the chat runner's own emit closure (see `assistantEmitForApp`).
   */
  private emitForApp(
    appId: string,
    source: "handler" | "external"
  ): (tables: string[]) => void {
    // Empty `tables` still notifies — post-#286 handler writes ride
    // ctx.vault, so "the app acted" is all the runtime knows (and all a
    // view needs to re-derive).
    return (tables) => {
      this.changeBus.emit({ appId, tables, ts: Date.now(), source });
    };
  }

  /**
   * Build the change-emitter that the per-app conversation runner uses for
   * assistant writes. The harness path needs to thread per-tool-call
   * provenance through so a subscriber can correlate refreshes with the item
   * that caused them.
   */
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

  /**
   * Load the registry. Idempotent; call once on host startup. App code is
   * served from the git store via `codeDirOverride`; this only loads the
   * per-app data-dir registry.
   */
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
    // Mirrors `Dispatcher.resolveCodeDir`: the git-store override resolves
    // an app's live code dir (#137). No override → no servable code.
    return this.codeDirOverride ? this.codeDirOverride(entry.id) : undefined;
  }

  private refOf(entry: RegistryEntry): AppRef {
    return { id: entry.id, dir: appDataDir(entry) };
  }

  /**
   * App RPC handler-invocation route (#505, retiring the
   * `/centraid/_tool/centraid_*` shim). Serves
   * `POST /centraid/<appId>/actions/<action>` and
   * `POST /centraid/<appId>/queries/<query>`: the app id + handler name ride
   * in the path, the JSON body carries `{ input?, intentId? }`. Dispatches to
   * the right method on the shared `Dispatcher` and maps the MCP-shaped
   * `ToolResult` to HTTP: success → 200 with `structuredContent`; `isError`
   * → status from `statusForToolError` with `{code, message, path?}`.
   *
   * This is the only path non-MCP callers (the shells' inline app routes,
   * native mobile screens, scripts, the Companion extension) take to invoke
   * handlers.
   */
  private async handleAppRpc(
    req: IncomingMessage,
    res: ServerResponse,
    kind: "action" | "query",
    appId: string,
    handlerName: string,
    draftSessionId?: string
  ): Promise<void> {
    // A browser session is pinned to one app; the app id is now in the path,
    // so scope-check against it directly rather than a body field.
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

  /**
   * App describe route (#505, replacing `centraid_describe`):
   * `GET /centraid/<appId>/_describe` returns the app's manifest; an optional
   * `?action=<name>`/`?query=<name>` narrows to one declared handler.
   */
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

  /**
   * Reject the request (403) when a browser session pinned via
   * `x-centraid-web-app` addresses a different app. Returns `true` when the
   * caller may proceed.
   */
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

  /**
   * Draft preview (#141): resolve the session worktree's code dir so a
   * `/centraid/_draft/<sessionId>/…` invocation runs against the app's live
   * data. Live requests (no draft session) resolve to `undefined`.
   */
  private async draftOverride(
    appId: string,
    draftSessionId?: string
  ): Promise<string | undefined> {
    return draftSessionId && this.draftCodeDir && appId
      ? this.draftCodeDir(appId, draftSessionId)
      : undefined;
  }

  /**
   * Map an MCP-shaped `ToolResult` to an HTTP response. The handler JSON is
   * the headline compressible payload (a query result can be large) — so
   * negotiate br/gzip off the request's Accept-Encoding (#404). Skips
   * small bodies internally; the PWA service-worker path never forwards
   * Accept-Encoding, so it opts out and receives raw JSON — see
   * http/compression.ts.
   */
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

  /**
   * Handle a single inbound request. Implements the `/centraid/...` URL
   * surface. Assumes the host has already authenticated the caller —
   * app-engine does not enforce its own auth.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Draft preview (#141): a `/centraid/_draft/<sessionId>/…` request
    // runs the session worktree's handlers against the app's live data. The
    // session id rides through to the RPC/describe cases, which resolve it
    // via `draftOverride`.
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
