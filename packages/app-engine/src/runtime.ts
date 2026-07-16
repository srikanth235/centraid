// governance: allow-repo-hygiene file-size-limit pending split into changes-feed / app-routes modules
import path from 'node:path';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Registry, RegistryError } from './registry/registry.js';
import { parseWithDraft } from './http/router.js';
import {
  Dispatcher,
  isToolName,
  statusForToolError,
  type ToolName,
  type ToolResult,
} from './handlers/dispatcher.js';
import { serveStatic } from './http/static-server.js';
import { readBody, sendError, sendJson } from './http/http-utils.js';
import { sendJsonNegotiated } from './http/compression.js';
import { appDataDir } from './registry/app-paths.js';
import { cleanupDeregisteredApp } from './registry/deregister-cleanup.js';
import { handleLogsRoute, handleSettingsWrite } from './http/cloud-routes.js';
import { ChangeBus } from './changes/change-bus.js';
import { handleAppChanges } from './http/changes-sse.js';
import { serveQueryBundle } from './http/query-bundle.js';
import type { PrefsStore } from './stores/prefs-store.js';
import type { ConversationHistoryStore } from './conversation/history.js';
import { readAppSettings } from './settings/app-settings.js';
import { buildSettingsInject } from './settings/settings-merge.js';
import { handleTurnRoute, parseTurnSubRoute, type AskModelPrefs } from './http/turn-routes.js';
import type { TurnLimiter } from './http/turn-limiter.js';
import type { ConversationRunner } from './conversation/runner.js';
import type { VaultBridge } from './handlers/vault-bridge.js';
import type { AppRef, RegistryEntry } from './types.js';

const WEB_APP_HEADER = 'x-centraid-web-app';
const WEB_SHELL_ORIGIN_HEADER = 'x-centraid-web-shell-origin';

export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RuntimeOptions {
  /**
   * Directory holding app folders + `_registry.json` — or a provider that
   * resolves it per call. The gateway wires "the ACTIVE vault's workspace
   * apps dir" (#280: apps are vault assets), so a vault switch re-roots the
   * whole app surface; the runtime keeps one `Registry` per resolved dir.
   */
  appsDir: string | (() => string);
  /**
   * Optional canonical dir for assets shared verbatim by every app
   * (`kit.js` / `kit.css`). Apps no longer ship their own copy; a request
   * for `/centraid/<id>/kit.js` that the app folder can't satisfy is served
   * from here. Hosts point this at `@centraid/blueprints`'s `KIT_DIR`.
   * Omit to disable the fallback.
   */
  sharedAssetsDir?: string;
  logger?: RuntimeLogger;
  /**
   * Optional change bus. When omitted the runtime constructs an internal
   * one, exposed as `runtime.changeBus` for hosts that want to subscribe
   * from outside.
   */
  changeBus?: ChangeBus;
  /**
   * Optional device-prefs store (a JSON file — #280 killed the identity
   * DB). When provided, the runtime reads the gateway-wide prefs during
   * `app-index` and bakes them into the served HTML (merged with the app's
   * own `__centraid_settings` table and any URL-query overrides). Without
   * it, app-index falls back to URL-query-only injection so
   * single-app/standalone setups still work. Hosts (the standalone daemon,
   * desktop local-runtime) construct the store themselves and additionally
   * mount `/_centraid-user/*` for the desktop to read/write prefs.
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
   * drives a model turn via this runner — `@centraid/agent-runtime`'s
   * `makeConversationRunner` (drives codex app-server / Claude SDK locally).
   *
   * Without a runner the chat routes 503 with `no_conversation_runner`. Hosts
   * decide whether to inject one — single-app standalone setups, tests,
   * and worker subprocesses all run fine without it.
   */
  conversationRunner?: ConversationRunner;
  /**
   * Scratch base dir for runner-owned chat session files — or a provider
   * (the gateway wires the ACTIVE vault's `runner-sessions/` dir, #280).
   * The `POST /centraid/<id>/_turn` route passes `<dir>/<conversationId>.jsonl`
   * as `ConversationTurnInput.sessionFile`. Defaults to an OS-tmpdir path
   * when omitted.
   */
  conversationRunnerSessionDir?: string | (() => string);
  /**
   * Optional reader for per-app metadata (name, description). The chat
   * route uses it to populate the `extraSystemPrompt` it hands to the
   * runner. Both hosts wire a host-injected app.json reader through.
   * Defaults to "no metadata" — chat still works, just with the bare
   * app-id as the display name.
   */
  appMeta?: (entry: RegistryEntry) => Promise<{ name?: string; description?: string }>;
  /**
   * Optional preflight reporter for the gateway-wide
   * `GET /centraid/_turn/runner-status` route. Returns the host's view of
   * each adapter's readiness so the chat panel can show a Setup screen
   * instead of failing per-turn when the CLI is missing or unauthenticated.
   */
  runnerStatus?: (opts?: RunnerStatusOptions) => Promise<RunnerStatus>;
  /**
   * Optional code-dir resolver (issue #137). When provided, the runtime
   * serves handlers + static files from whatever dir this returns for an
   * app id — the gateway injects an apps-store-backed resolver pointing
   * at the live git worktree (`worktrees/main/<sha>/apps/<id>/`) instead
   * of the legacy `<appsDir>/<id>/versions/<active>/`. `entry.path` (the
   * registry's per-app dir) still holds runtime state (logs, settings.json,
   * blobs), so this cleanly separates code (git) from state (stable dir).
   */
  codeDirOverride?: (appId: string) => Promise<string | undefined>;
  /**
   * Optional DRAFT code-dir resolver (issue #141, draft preview). When
   * provided, requests under `/centraid/_draft/<sessionId>/<appId>/…` serve
   * static files + run handlers from whatever dir this returns for
   * `(appId, sessionId)` — the gateway injects an apps-store-backed
   * resolver pointing at the session worktree's `apps/<id>/`. Returns
   * `undefined` for an unknown session/app (→ 404/503), so the live
   * serving path is wholly unaffected when no draft resolver is
   * configured.
   */
  draftCodeDir?: (appId: string, sessionId: string) => Promise<string | undefined>;
  /**
   * Optional per-app `ctx.vault` bridge factory (duaility §12). The gateway
   * injects one when a vault plane is mounted; handlers then reach the
   * owner's canonical vault through a consent-checked host-side executor.
   * Without it, `ctx.vault.*` calls fail closed with VAULT_UNAVAILABLE.
   */
  vaultFor?: (appId: string) => VaultBridge;
  /**
   * Optional ask-model picker backing (subsystem `ask`). When provided,
   * `GET`/`PUT /centraid/<id>/_turn/model` let the kit Ask panel's inline
   * model picker read/set the `model.<runnerKind>.ask` prefs override —
   * the SAME key `resolveSubsystemModel` reads at turn time, so the
   * picker and the actual turn always agree. Without it those routes 503.
   */
  askModel?: AskModelPrefs;
  /**
   * Optional per-vault turn-concurrency gate (issue #420). Resolved per request
   * so it bounds running turns per ambient vault. Wired by the gateway; absent
   * in embedded/hermetic hosts → unbounded.
   */
  turnLimiter?: () => TurnLimiter | undefined;
}

/** Provider-agnostic capability tier a model is classified into. */
export type ModelTier = 'smart' | 'balanced' | 'fast';

/**
 * One model a runtime can serve, as surfaced by a runtime that can
 * enumerate its catalog. The `id` is what the chat picker persists and
 * hands back as the chat model.
 */
export interface RunnerModel {
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
 * Lives here (not agent-runtime) because `RunnerStatus` carries it and
 * app-engine is the lower layer; agent-runtime re-exports it.
 */
export type SurfaceStatus = 'loading' | 'ready' | 'empty';

/** Options for the runner-status reporter (e.g. force a model reclassify). */
export interface RunnerStatusOptions {
  /** Force a fresh model-tier classification rather than serving the cache. */
  refresh?: boolean;
}

/**
 * Shape returned by the runner-status preflight route. Both hosts share
 * the schema, reporting the configured CLI adapter.
 */
export interface RunnerStatus {
  kind: 'codex' | 'claude-code' | 'none';
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
   * the user's CLI is older than what we've tested — the adapter may
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
  models?: RunnerModel[];
  /**
   * Load state of the model list above — lets the chat picker show a loading
   * placeholder before the first warm completes, vs an empty state when the
   * runner reports no models. Absent when the host doesn't track a catalog.
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
   * Declared-handler dispatcher (issue #107). Exposed so hosts can
   * delegate here (the `_tool` HTTP shim for app UIs does) rather than
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
   * Optional device-prefs store. Hosts mount it both here (so app-index can
   * bake prefs into HTML) and on their own HTTP surface as `/_centraid-user/*`
   * (so the desktop can read/write prefs over HTTP).
   */
  readonly userStore?: PrefsStore;
  /** Optional conversation-history store. See `RuntimeOptions.conversationHistoryStore`. */
  readonly conversationHistoryStore?: ConversationHistoryStore;
  /** Optional per-app chat runner. See `RuntimeOptions.conversationRunner`. */
  readonly conversationRunner?: ConversationRunner;
  /** Optional app-metadata reader for chat extra-system-prompt. */
  readonly appMeta?: (entry: RegistryEntry) => Promise<{ name?: string; description?: string }>;
  /** Optional runner-status preflight. */
  readonly runnerStatus?: (opts?: RunnerStatusOptions) => Promise<RunnerStatus>;
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
  private readonly sharedAssetsDir?: string;
  private readonly logger: RuntimeLogger;
  private readonly codeDirOverride?: (appId: string) => Promise<string | undefined>;
  private readonly draftCodeDir?: (appId: string, sessionId: string) => Promise<string | undefined>;
  /**
   * Per-runtime (and therefore per-gateway) chat-session lock map for the
   * `(appId, conversationId)` chat serialization. Was a module-level map in
   * `chat-routes.ts` until issue #113 — moved here so two gateways that
   * happen to share an `appId` (same template installed in two profiles)
   * don't collide on the same lock key.
   */
  private readonly conversationLocks = new Map<string, Promise<void>>();

  constructor(opts: RuntimeOptions) {
    this.appsDirProvider =
      typeof opts.appsDir === 'string'
        ? (
            (dir) => () =>
              dir
          )(opts.appsDir)
        : opts.appsDir;
    if (opts.sharedAssetsDir) this.sharedAssetsDir = opts.sharedAssetsDir;
    this.logger = opts.logger ?? noopLogger;
    this.changeBus = opts.changeBus ?? new ChangeBus({ logger: this.logger });
    this.userStore = opts.userStore;
    this.conversationHistoryStore = opts.conversationHistoryStore;
    this.conversationRunner = opts.conversationRunner;
    const sessionDir =
      opts.conversationRunnerSessionDir ??
      path.join(os.tmpdir(), 'centraid-conversation-runner-sessions');
    this.sessionDirProvider = typeof sessionDir === 'string' ? () => sessionDir : sessionDir;
    this.appMeta = opts.appMeta;
    this.runnerStatus = opts.runnerStatus;
    this.askModel = opts.askModel;
    if (opts.turnLimiter) this.turnLimiter = opts.turnLimiter;
    if (opts.codeDirOverride) this.codeDirOverride = opts.codeDirOverride;
    if (opts.draftCodeDir) this.draftCodeDir = opts.draftCodeDir;
    this.dispatcher = new Dispatcher({
      registry: () => this.registry,
      onWriteFor: (appId) => this.emitForApp(appId, 'handler'),
      ...(this.codeDirOverride ? { codeDirOverride: this.codeDirOverride } : {}),
      ...(opts.vaultFor ? { vaultFor: opts.vaultFor } : {}),
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

  /** Scratch base dir for runner-owned chat session files (per active vault). */
  get conversationRunnerSessionDir(): string {
    return this.sessionDirProvider();
  }

  /**
   * Build a closure that emits a change for the given app. Each caller picks
   * its provenance band — `'handler'` for app-authored action writes,
   * `'external'` for cloud-panel SQL writes, etc. Agent writes flow through
   * the chat runner's own emit closure (see `agentEmitForApp`).
   */
  private emitForApp(appId: string, source: 'handler' | 'external'): (tables: string[]) => void {
    // Empty `tables` still notifies — post-#286 handler writes ride
    // ctx.vault, so "the app acted" is all the runtime knows (and all a
    // view needs to re-derive).
    return (tables) => {
      this.changeBus.emit({ appId, tables, ts: Date.now(), source });
    };
  }

  /**
   * Build the change-emitter that the per-app chat runner uses for agent
   * writes. The agent path needs to thread per-tool-call provenance through
   * so the iframe can correlate refreshes with chat pills.
   */
  agentEmitForApp(
    appId: string,
  ): (payload: { tables: string[]; toolCallId?: string; turnId?: string }) => void {
    return (payload) => {
      this.changeBus.emit({
        appId,
        tables: payload.tables,
        ts: Date.now(),
        source: 'agent',
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
      runner: this.conversationRunner,
      conversationStore: this.conversationHistoryStore,
      conversationRunnerSessionDir: this.conversationRunnerSessionDir,
      appMeta: this.appMeta,
      conversationLocks: this.conversationLocks,
      ...(this.askModel ? { askModel: this.askModel } : {}),
      ...(this.turnLimiter ? { turnLimiter: this.turnLimiter } : {}),
    };
  }

  private async resolveCodeDir(entry: RegistryEntry): Promise<string | undefined> {
    // Mirrors `Dispatcher.resolveCodeDir`: the git-store override resolves
    // an app's live code dir (issue #137). No override → no servable code.
    return this.codeDirOverride ? this.codeDirOverride(entry.id) : undefined;
  }

  private refOf(entry: RegistryEntry): AppRef {
    return { id: entry.id, dir: appDataDir(entry) };
  }

  /**
   * HTTP shim for the three-tool surface (issue #107). Parses
   * `POST /centraid/_tool/<toolName>`, dispatches to the right method
   * on the shared `Dispatcher`, and maps the MCP-shaped `ToolResult`
   * to an HTTP response: success → 200 with the `structuredContent` as
   * the JSON body; `isError: true` → status from `statusForToolError`
   * with `{code, message, path?}` as the body.
   *
   * This is the only path non-MCP callers (browser UI, scripts, the
   * mobile bridge) take to invoke handlers.
   */
  private async handleToolInvoke(
    req: IncomingMessage,
    res: ServerResponse,
    toolName: string,
    draftSessionId?: string,
  ): Promise<void> {
    if (!isToolName(toolName)) {
      sendError(
        res,
        404,
        'unknown_tool',
        `tool "${toolName}" is not a centraid tool — expected one of centraid_write, centraid_read, centraid_describe`,
      );
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      const raw = (await readBody(req)).toString('utf8');
      if (raw.length > 0) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          sendError(res, 400, 'bad_request', 'Tool body must be a JSON object.');
          return;
        }
        body = parsed as Record<string, unknown>;
      }
    } catch (err) {
      sendError(
        res,
        400,
        'bad_request',
        `tool body is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const webApp = req.headers[WEB_APP_HEADER];
    if (typeof webApp === 'string') {
      if (typeof body.app !== 'string' || body.app !== webApp) {
        sendError(res, 403, 'app_session_scope', 'This browser session is scoped to another app.');
        return;
      }
    }

    const result = await this.dispatchTool(toolName, body, draftSessionId);
    // Tool JSON is the headline compressible payload (a `centraid_read`
    // result can be large) — negotiate br/gzip off the request's
    // Accept-Encoding (issue #404). Skips small bodies internally; the PWA
    // service-worker path never forwards Accept-Encoding, so it opts out and
    // receives raw JSON — see http/compression.ts.
    if (result.isError) {
      sendJsonNegotiated(
        req,
        res,
        statusForToolError(result.structuredContent.code),
        result.structuredContent,
      );
      return;
    }
    sendJsonNegotiated(req, res, 200, result.structuredContent ?? null);
  }

  private async dispatchTool(
    toolName: ToolName,
    body: Record<string, unknown>,
    draftSessionId?: string,
  ): Promise<ToolResult> {
    // Draft preview (issue #141): run the session worktree's handlers
    // against the app's live data. The app id is in the body, so resolve
    // the draft code dir here and pass it as the per-call override.
    const appId = typeof body.app === 'string' ? body.app : '';
    const overrideCodeDir =
      draftSessionId && this.draftCodeDir && appId
        ? await this.draftCodeDir(appId, draftSessionId)
        : undefined;
    switch (toolName) {
      case 'centraid_write':
        return this.dispatcher.write(
          {
            app: String(body.app ?? ''),
            action: String(body.action ?? ''),
            input: body.input,
            ...(typeof body.intentId === 'string' ? { intentId: body.intentId } : {}),
          },
          overrideCodeDir,
        );
      case 'centraid_read':
        return this.dispatcher.read(
          {
            app: String(body.app ?? ''),
            query: String(body.query ?? ''),
            input: body.input,
          },
          overrideCodeDir,
        );
      case 'centraid_describe':
        return this.dispatcher.describe(
          {
            ...(typeof body.app === 'string' ? { app: body.app } : {}),
            ...(typeof body.action === 'string' ? { action: body.action } : {}),
            ...(typeof body.query === 'string' ? { query: body.query } : {}),
          },
          overrideCodeDir,
        );
    }
  }

  /**
   * Handle a single inbound request. Implements the `/centraid/...` URL
   * surface. Assumes the host has already authenticated the caller —
   * app-engine does not enforce its own auth.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const { route, draftSessionId } = parseWithDraft(req.method ?? 'GET', req.url ?? '/');

    // Draft preview (issue #141): a `/centraid/_draft/<sessionId>/…` request
    // serves the session worktree's code (static + handlers) against the
    // app's live data. Resolve the draft code dir once here; the
    // code-dependent cases below prefer it over the live `resolveCodeDir`.
    // A draft request with no resolver configured (or an unknown
    // session/app) yields `undefined`, which those cases surface as
    // 503/404 — the live path is never affected when `draftSessionId` is
    // absent.
    const draftCodeDirFor = async (appId: string): Promise<string | undefined> =>
      draftSessionId && this.draftCodeDir ? this.draftCodeDir(appId, draftSessionId) : undefined;

    try {
      switch (route.kind) {
        case 'registry-list': {
          sendJson(
            res,
            200,
            this.registry.list().map((e) => ({
              id: e.id,
              path: e.path,
              registeredAt: e.registeredAt,
            })),
          );
          return;
        }

        case 'registry-deregister': {
          const removed = await this.registry.deregister(route.appId);
          if (!removed) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          await cleanupDeregisteredApp(this.appsDir, removed, this.logger);
          sendJson(res, 200, { id: route.appId });
          return;
        }

        case 'app-settings-read': {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          sendJson(res, 200, { settings: readAppSettings(entry.path) });
          return;
        }

        case 'app-settings-write': {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          await handleSettingsWrite(req, res, entry.path);
          return;
        }

        case 'app-changes': {
          await handleAppChanges(req, res, this.changeBus, route.appId);
          return;
        }

        case 'app-logs': {
          await handleLogsRoute(res, this.registry, route.appId, route.query);
          return;
        }

        case 'app-query-bundle': {
          const webApp = req.headers[WEB_APP_HEADER];
          if (typeof webApp === 'string' && webApp !== route.appId) {
            sendError(
              res,
              403,
              'app_session_scope',
              'This browser session is scoped to another app.',
            );
            return;
          }
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          const codeDir = draftSessionId
            ? await draftCodeDirFor(entry.id)
            : await this.resolveCodeDir(entry);
          if (!codeDir) {
            sendError(res, 503, 'no_active_version', 'App has no active version yet.');
            return;
          }
          await serveQueryBundle(req, res, {
            codeDir,
            appId: entry.id,
            queryName: route.queryName,
          });
          return;
        }

        case 'app-index':
        case 'app-static': {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          const codeDir = draftSessionId
            ? await draftCodeDirFor(entry.id)
            : await this.resolveCodeDir(entry);
          if (!codeDir) {
            sendError(res, 503, 'no_active_version', 'App has no active version yet.');
            return;
          }
          // In draft mode the served HTML's bridge must pin the app id +
          // route tool calls through the draft shim (the path's first
          // segment is `_draft`, so the live `location.pathname` sniff
          // would mis-read it). Passed through to `serveStatic`.
          const draftServe = draftSessionId
            ? { draft: { appId: entry.id, sessionId: draftSessionId } }
            : {};
          // Kit assets (kit.js / kit.css) are served from the shared canonical
          // dir when the app folder doesn't ship its own copy.
          const sharedServe = this.sharedAssetsDir ? { sharedAssetsDir: this.sharedAssetsDir } : {};
          const rel = route.kind === 'app-index' ? 'index.html' : route.rel;
          if (route.kind === 'app-index') {
            // Merge global prefs (gateway-side store) with this app's own
            // settings.json and any URL-query overrides, then bake the
            // result into the served HTML so the iframe paints in the
            // right shape before any script runs.
            const globalPrefs = this.userStore?.getAllPrefs();
            const appSettings = readAppSettings(entry.path);
            const queryOverrides = route.query as Record<string, unknown>;
            const settingsInject = buildSettingsInject([globalPrefs, appSettings, queryOverrides]);
            const shellOrigin = req.headers[WEB_SHELL_ORIGIN_HEADER];
            await serveStatic(req, res, codeDir, rel, {
              settingsInject,
              ...(typeof shellOrigin === 'string' ? { frameAncestor: shellOrigin } : {}),
              ...draftServe,
              ...sharedServe,
            });
          } else {
            await serveStatic(req, res, codeDir, rel, { ...draftServe, ...sharedServe });
          }
          return;
        }

        case 'tool-invoke': {
          await this.handleToolInvoke(req, res, route.toolName, draftSessionId);
          return;
        }

        case 'app-chat': {
          const parsed = parseTurnSubRoute(route.appId, route.segments, req.method ?? 'GET');
          if (!parsed) {
            sendError(res, 404, 'not_found', 'Unknown chat sub-route.');
            return;
          }
          await handleTurnRoute(req, res, this.turnRouteContext(), parsed);
          return;
        }

        case 'app-runner-status': {
          if (!this.runnerStatus) {
            sendJson(res, 200, { kind: 'none', ok: false, reason: 'no runner configured' });
            return;
          }
          const status = await this.runnerStatus({ refresh: route.refresh });
          sendJson(res, 200, status);
          return;
        }

        case 'not-found':
          sendError(res, 404, 'not_found', 'Unknown centraid path.');
      }
    } catch (err) {
      if (err instanceof RegistryError) {
        const status =
          err.code === 'invalid_id'
            ? 400
            : err.code === 'already_registered'
              ? 409
              : err.code === 'not_a_directory'
                ? 400
                : 404;
        sendError(res, status, err.code, err.message);
        return;
      }
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  }
}
