// governance: allow-repo-hygiene file-size-limit pending split into changes-feed / app-routes modules
import path from 'node:path';
import os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Registry, RegistryError } from './registry.js';
import { parseWithDraft } from './router.js';
import {
  Dispatcher,
  isToolName,
  statusForToolError,
  type ToolName,
  type ToolResult,
} from './dispatcher.js';
import { serveStatic } from './static-server.js';
import { readBody, sendError, sendJson } from './http-utils.js';
import { appDataDir } from './app-paths.js';
import { cleanupDeregisteredApp } from './deregister-cleanup.js';
import { readAppSchema } from './schema.js';
import { handleTableRowsRoute, handleQueryRoute, handleLogsRoute } from './cloud-routes.js';
import { ChangeBus } from './change-bus.js';
import { handleAppChanges } from './changes-sse.js';
import type { UserStore } from './user-store.js';
import type { ChatHistoryStore } from './chat-history.js';
import { readAppSettings } from './app-settings.js';
import { buildSettingsInject } from './settings-merge.js';
import { handleChatRoute, parseChatSubRoute } from './chat-routes.js';
import type { ChatRunner } from './chat-runner.js';
import type { AppRef, RegistryEntry } from './types.js';

export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RuntimeOptions {
  /** Absolute path of the directory holding app folders + `_registry.json`. */
  appsDir: string;
  logger?: RuntimeLogger;
  /**
   * Optional change bus. When omitted the runtime constructs an internal
   * one, exposed as `runtime.changeBus` for hosts that want to subscribe
   * from outside (e.g. OpenClaw's `centraid_sql_write` agent tool).
   */
  changeBus?: ChangeBus;
  /**
   * Optional user-prefs store. When provided, the runtime reads the
   * gateway-wide user preferences during `app-index` and bakes them into
   * the served HTML (merged with the app's own `__centraid_settings`
   * table and any URL-query overrides). Without it, app-index falls back
   * to URL-query-only injection so single-app/standalone setups still
   * work. Hosts (openclaw plugin, desktop local-runtime) construct the
   * store themselves and additionally mount `/_centraid-user/*` for the
   * desktop to read/write prefs.
   */
  userStore?: UserStore;
  /**
   * Optional chat-history store. Wraps the same gateway DB as `userStore`
   * (real FK from `chat_sessions.user_id` → `users.id`). When provided,
   * `startRuntimeHttpServer` mounts `/_centraid-chat/*` against it.
   */
  chatHistoryStore?: ChatHistoryStore;
  /**
   * Optional per-app chat runner. When provided, `POST /centraid/<id>/_chat`
   * drives a model turn via this runner. Two implementations exist:
   * `openclaw-plugin/lib/openclaw-chat-runner` (calls `runEmbeddedAgent`
   * in-process on the gateway side) and `@centraid/agent-runtime`'s
   * `makeChatRunner` (drives codex app-server / Claude SDK locally).
   *
   * Without a runner the chat routes 503 with `no_chat_runner`. Hosts
   * decide whether to inject one — single-app standalone setups, tests,
   * and worker subprocesses all run fine without it.
   */
  chatRunner?: ChatRunner;
  /**
   * Central scratch base dir for runner-owned chat session files. The
   * `POST /centraid/<id>/_chat` route passes `<dir>/<conversationId>.jsonl` as
   * `ChatRunInput.sessionFile`. Defaults to an OS-tmpdir path when omitted.
   */
  chatRunnerSessionDir?: string;
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
   * `GET /centraid/_chat/runner-status` route. Returns the host's view of
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
   * registry's per-app dir) is still where `data.sqlite` lives, so this
   * cleanly separates code (git) from data (stable per-app dir).
   */
  codeDirOverride?: (appId: string) => Promise<string | undefined>;
  /**
   * Optional DRAFT code-dir resolver (issue #141, draft preview). When
   * provided, requests under `/centraid/_draft/<sessionId>/<appId>/…` serve
   * static files + run handlers from whatever dir this returns for
   * `(appId, sessionId)` — the gateway injects an apps-store-backed
   * resolver pointing at the session worktree's `apps/<id>/`. Data still
   * binds to the registry entry's dir, so a draft reads/writes the same
   * `data.sqlite` the published app uses. Returns `undefined` for an
   * unknown session/app (→ 404/503), so the live serving path is wholly
   * unaffected when no draft resolver is configured.
   */
  draftCodeDir?: (appId: string, sessionId: string) => Promise<string | undefined>;
}

/** Provider-agnostic capability tier a model is classified into. */
export type ModelTier = 'smart' | 'balanced' | 'fast';

/**
 * One model a runtime can serve, as surfaced by a runtime that can
 * enumerate its catalog (e.g. OpenClaw via `openclaw models list`). The
 * `id` is what the chat picker persists and hands back as the chat model.
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

/** Options for the runner-status reporter (e.g. force a model reclassify). */
export interface RunnerStatusOptions {
  /** Force a fresh model-tier classification rather than serving the cache. */
  refresh?: boolean;
}

/**
 * Shape returned by the runner-status preflight route. Both hosts share
 * the schema; OpenClaw reports `{ kind: 'openclaw', ok: true }` plus its
 * enumerated `models`, the desktop local-runtime reports the configured
 * CLI adapter.
 */
export interface RunnerStatus {
  kind: 'openclaw' | 'codex' | 'claude-code' | 'none';
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
   * Models the runtime can serve, when it can enumerate them (OpenClaw via
   * `openclaw models list`). Absent when the runtime has no enumerable list
   * (built-in codex / claude-code, which pick the model internally).
   */
  models?: RunnerModel[];
}

const noopLogger: RuntimeLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * The centraid runtime engine, decoupled from any specific transport.
 *
 * A host (OpenClaw plugin shim, in-process Electron embed, ...) constructs
 * a `Runtime`, calls `bootstrap()` once, then routes inbound HTTP requests
 * through `handle(req, res)`. `onCronChanged` is forwarded by the host when
 * the scheduler reports a job state transition.
 */
export class Runtime {
  readonly registry: Registry;
  /**
   * Three-tool dispatcher (issue #107). Exposed so the OpenClaw plugin
   * can register `centraid_write`/`_read`/`_describe` tools that
   * delegate here rather than re-implementing the manifest + validation
   * surface.
   */
  readonly dispatcher: Dispatcher;
  /**
   * Per-app change notification bus. Subscribed by the `/centraid/<id>/_changes`
   * SSE endpoint and emitted by `runQuery` (HTTP path + openclaw legacy tool)
   * and `handler-runner` (app action writes). Hosts can subscribe from
   * outside too — e.g. to add a write-driven log line.
   */
  readonly changeBus: ChangeBus;
  /**
   * Optional user-prefs store. Hosts mount it both here (so app-index can
   * bake prefs into HTML) and on their own HTTP surface as `/_centraid-user/*`
   * (so the desktop can read/write prefs over HTTP).
   */
  readonly userStore?: UserStore;
  /** Optional chat-history store. See `RuntimeOptions.chatHistoryStore`. */
  readonly chatHistoryStore?: ChatHistoryStore;
  /** Optional per-app chat runner. See `RuntimeOptions.chatRunner`. */
  readonly chatRunner?: ChatRunner;
  /** Central scratch base dir for runner-owned chat session files. */
  readonly chatRunnerSessionDir: string;
  /** Optional app-metadata reader for chat extra-system-prompt. */
  readonly appMeta?: (entry: RegistryEntry) => Promise<{ name?: string; description?: string }>;
  /** Optional runner-status preflight. */
  readonly runnerStatus?: (opts?: RunnerStatusOptions) => Promise<RunnerStatus>;
  private readonly appsDir: string;
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
    this.appsDir = opts.appsDir;
    this.logger = opts.logger ?? noopLogger;
    this.registry = new Registry(opts.appsDir);
    this.changeBus = opts.changeBus ?? new ChangeBus({ logger: this.logger });
    this.userStore = opts.userStore;
    this.chatHistoryStore = opts.chatHistoryStore;
    this.chatRunner = opts.chatRunner;
    this.chatRunnerSessionDir =
      opts.chatRunnerSessionDir ?? path.join(os.tmpdir(), 'centraid-chat-runner-sessions');
    this.appMeta = opts.appMeta;
    this.runnerStatus = opts.runnerStatus;
    if (opts.codeDirOverride) this.codeDirOverride = opts.codeDirOverride;
    if (opts.draftCodeDir) this.draftCodeDir = opts.draftCodeDir;
    this.dispatcher = new Dispatcher({
      registry: this.registry,
      onWriteFor: (appId) => this.emitForApp(appId, 'handler'),
      ...(this.codeDirOverride ? { codeDirOverride: this.codeDirOverride } : {}),
    });
  }

  /**
   * Build a closure that emits a change for the given app. Each caller picks
   * its provenance band — `'handler'` for app-authored action writes,
   * `'external'` for cloud-panel SQL writes, etc. Agent writes flow through
   * the chat runner's own emit closure (see `agentEmitForApp`).
   */
  private emitForApp(appId: string, source: 'handler' | 'external'): (tables: string[]) => void {
    return (tables) => {
      if (tables.length === 0) return;
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
  ): (payload: { tables: string[]; toolCallId?: string; agentTurnId?: string }) => void {
    return (payload) => {
      if (payload.tables.length === 0) return;
      this.changeBus.emit({
        appId,
        tables: payload.tables,
        ts: Date.now(),
        source: 'agent',
        ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
        ...(payload.agentTurnId ? { agentTurnId: payload.agentTurnId } : {}),
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

  private chatRouteContext() {
    return {
      registry: this.registry,
      resolveCodeDir: (entry: RegistryEntry) => this.resolveCodeDir(entry),
      runner: this.chatRunner,
      chatStore: this.chatHistoryStore,
      chatRunnerSessionDir: this.chatRunnerSessionDir,
      appMeta: this.appMeta,
      conversationLocks: this.conversationLocks,
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

    const result = await this.dispatchTool(toolName, body, draftSessionId);
    if (result.isError) {
      res.statusCode = statusForToolError(result.structuredContent.code);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result.structuredContent));
      return;
    }
    sendJson(res, 200, result.structuredContent ?? null);
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

        case 'app-schema': {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          // Gate on code-dir presence rather than current.json so the
          // git-store backend (no current.json) works too. In draft mode
          // data dir = code dir (the session worktree), so the schema read
          // reflects the draft's branched data — incl. a pending migration
          // the draft applied (#144). Live reads the per-app dir.
          const codeDir = draftSessionId
            ? await draftCodeDirFor(entry.id)
            : await this.resolveCodeDir(entry);
          if (!codeDir) {
            sendError(res, 503, 'no_active_version', 'App has no active version yet.');
            return;
          }
          const dataDbFile = path.join(draftSessionId ? codeDir : entry.path, 'data.sqlite');
          const schema = readAppSchema(dataDbFile);
          sendJson(res, 200, schema);
          return;
        }

        case 'app-table-rows': {
          await handleTableRowsRoute(res, this.registry, route.appId, route.tableName, route.query);
          return;
        }

        case 'app-query': {
          await handleQueryRoute(
            req,
            res,
            this.registry,
            route.appId,
            this.emitForApp(route.appId, 'external'),
          );
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
          const rel = route.kind === 'app-index' ? 'index.html' : route.rel;
          if (route.kind === 'app-index') {
            // Merge global prefs (gateway-side store) with this app's own
            // `__centraid_settings` rows and any URL-query overrides, then
            // bake the result into the served HTML so the iframe paints in
            // the right shape before any script runs. Draft mode reads the
            // branched settings from the worktree's data.sqlite (#144).
            const dataDbFile = path.join(draftSessionId ? codeDir : entry.path, 'data.sqlite');
            const globalPrefs = this.userStore?.getAllPrefs();
            const appSettings = readAppSettings(dataDbFile);
            const queryOverrides = route.query as Record<string, unknown>;
            const settingsInject = buildSettingsInject([globalPrefs, appSettings, queryOverrides]);
            await serveStatic(res, codeDir, rel, { settingsInject, ...draftServe });
          } else {
            await serveStatic(res, codeDir, rel, draftServe);
          }
          return;
        }

        case 'tool-invoke': {
          await this.handleToolInvoke(req, res, route.toolName, draftSessionId);
          return;
        }

        case 'app-chat': {
          const parsed = parseChatSubRoute(route.appId, route.segments, req.method ?? 'GET');
          if (!parsed) {
            sendError(res, 404, 'not_found', 'Unknown chat sub-route.');
            return;
          }
          await handleChatRoute(req, res, this.chatRouteContext(), parsed);
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
