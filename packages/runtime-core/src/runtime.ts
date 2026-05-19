// governance: allow-repo-hygiene file-size-limit pending split into changes-feed / app-routes modules
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Registry, RegistryError } from './registry.js';
import { VersionStore, VersionStoreError } from './version-store.js';
import { UploadError } from './upload.js';
import { runHandler } from './handler-runner.js';
import { parseRoute } from './router.js';
import { serveStatic } from './static-server.js';
import { readBody, sendError, sendJson } from './http-utils.js';
import { appCodeDir, appDataDir } from './app-paths.js';
import { cleanupDeregisteredApp } from './deregister-cleanup.js';
import { readAppSchema } from './schema.js';
import { handleTableRowsRoute, handleQueryRoute, handleLogsRoute } from './cloud-routes.js';
import { makeAppUploadLocks } from './upload-lock.js';
import { handleAppUpload } from './route-handlers.js';
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
  /** Max retained versions per uploaded app (active always kept; min 2). */
  versionRetention?: number;
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
   * Optional reader for per-app metadata (name, description). The chat
   * route uses it to populate the `extraSystemPrompt` it hands to the
   * runner. Both hosts wire `@centraid/builder-harness`'s app.json
   * reader through. Defaults to "no metadata" — chat still works, just
   * with the bare app-id as the display name.
   */
  appMeta?: (entry: RegistryEntry) => Promise<{ name?: string; description?: string }>;
  /**
   * Optional preflight reporter for the gateway-wide
   * `GET /centraid/_chat/runner-status` route. Returns the host's view of
   * each adapter's readiness so the chat panel can show a Setup screen
   * instead of failing per-turn when the CLI is missing or unauthenticated.
   */
  runnerStatus?: () => Promise<RunnerStatus>;
}

/**
 * Sub-status for a custom OpenAI-compatible provider configured on the
 * codex runner. Surfaced in `RunnerStatus.provider` when set, so the
 * settings UI can show whether the endpoint is reachable and what
 * models it exposes — independent of whether the codex binary itself
 * is healthy.
 */
export interface ProviderStatus {
  /** Provider id from `RunnerPrefs.provider.id`. */
  id: string;
  /** Base URL probed. */
  baseUrl: string;
  /** `true` when the endpoint responded successfully. */
  ok: boolean;
  /** Number of models returned by `GET <baseUrl>/models` when probe succeeded. */
  modelCount?: number;
  /** Plain-text reason for `ok: false` (timeout, 401, connection refused, …). */
  reason?: string;
}

/**
 * Shape returned by the runner-status preflight route. Both hosts share
 * the schema; OpenClaw always reports `{ kind: 'openclaw', ok: true }`,
 * the desktop local-runtime reports the configured CLI adapter.
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
   * Probe of the configured custom OpenAI-compatible endpoint, if any.
   * Independent from the binary preflight — a healthy codex CLI can
   * still fail at runtime if the configured endpoint is unreachable
   * or the API key is wrong, so the UI surfaces both.
   */
  provider?: ProviderStatus;
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
  readonly versions: VersionStore;
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
  /** Optional app-metadata reader for chat extra-system-prompt. */
  readonly appMeta?: (entry: RegistryEntry) => Promise<{ name?: string; description?: string }>;
  /** Optional runner-status preflight. */
  readonly runnerStatus?: () => Promise<RunnerStatus>;
  private readonly appsDir: string;
  private readonly versionRetention: number;
  private readonly logger: RuntimeLogger;
  private readonly withAppUploadLock: ReturnType<typeof makeAppUploadLocks>;

  constructor(opts: RuntimeOptions) {
    this.appsDir = opts.appsDir;
    this.versionRetention = Math.max(2, opts.versionRetention ?? 5);
    this.logger = opts.logger ?? noopLogger;
    this.registry = new Registry(opts.appsDir);
    this.versions = new VersionStore();
    this.changeBus = opts.changeBus ?? new ChangeBus({ logger: this.logger });
    this.userStore = opts.userStore;
    this.chatHistoryStore = opts.chatHistoryStore;
    this.chatRunner = opts.chatRunner;
    this.appMeta = opts.appMeta;
    this.runnerStatus = opts.runnerStatus;
    this.withAppUploadLock = makeAppUploadLocks();
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
   * Load the registry and recover any torn `current.json` files. Idempotent;
   * call once on host startup.
   */
  async bootstrap(): Promise<void> {
    await this.registry.load();

    for (const entry of this.registry.list()) {
      if (entry.mode !== 'uploaded') continue;
      try {
        const repaired = await this.versions.recover(entry.path);
        if (repaired) {
          this.logger.warn(`[centraid] recovered current.json for app "${entry.id}"`);
        }
      } catch (err) {
        this.logger.error(
          `[centraid] recovery failed for "${entry.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private chatRouteContext() {
    return {
      registry: this.registry,
      runner: this.chatRunner,
      appMeta: this.appMeta,
    };
  }

  private routeContext() {
    return {
      appsDir: this.appsDir,
      versionRetention: this.versionRetention,
      registry: this.registry,
      versions: this.versions,
      withAppUploadLock: this.withAppUploadLock,
      resolveCodeDir: (entry: RegistryEntry) => this.resolveCodeDir(entry),
      emitForApp: (appId: string) => this.emitForApp(appId, 'handler'),
    };
  }

  private async resolveCodeDir(entry: RegistryEntry): Promise<string | undefined> {
    if (entry.mode === 'uploaded') {
      const active = await this.versions.getActiveVersion(entry.path);
      if (!active) return undefined;
      return appCodeDir(entry, active);
    }
    return appCodeDir(entry);
  }

  private refOf(entry: RegistryEntry): AppRef {
    return { id: entry.id, dir: appDataDir(entry) };
  }

  /**
   * Handle a single inbound request. Implements the `/centraid/...` URL
   * surface. Assumes the host has already authenticated the caller —
   * runtime-core does not enforce its own auth.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const route = parseRoute(req.method ?? 'GET', req.url ?? '/');

    try {
      switch (route.kind) {
        case 'registry-list': {
          sendJson(
            res,
            200,
            this.registry.list().map((e) => ({
              id: e.id,
              path: e.path,
              mode: e.mode,
              registeredAt: e.registeredAt,
            })),
          );
          return;
        }

        case 'registry-register': {
          const body = JSON.parse((await readBody(req)).toString('utf8')) as {
            id?: string;
            path?: string;
          };
          if (!body.id || !body.path) {
            sendError(res, 400, 'bad_request', 'Body must include { id, path }.');
            return;
          }
          const entry = await this.registry.register({
            id: body.id,
            path: body.path,
            mode: 'path',
          });
          sendJson(res, 201, { id: entry.id, path: entry.path, mode: entry.mode });
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

        case 'app-upload': {
          await handleAppUpload(req, res, this.routeContext(), route.appId);
          return;
        }

        case 'app-versions-list': {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          if (entry.mode !== 'uploaded') {
            sendError(res, 409, 'not_uploaded', 'Versioning is only available for uploaded apps.');
            return;
          }
          const { activeVersion, versions: history } = await this.versions.listVersions(entry.path);
          sendJson(res, 200, {
            activeVersion,
            versions: history.map((v) => ({ ...v, current: v.versionId === activeVersion })),
          });
          return;
        }

        case 'app-version-activate': {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          if (entry.mode !== 'uploaded') {
            sendError(res, 409, 'not_uploaded', 'Activate is uploaded-mode only.');
            return;
          }
          const body = JSON.parse((await readBody(req)).toString('utf8')) as {
            versionId?: string;
          };
          if (!body.versionId) {
            sendError(res, 400, 'bad_request', 'Body must include { versionId }.');
            return;
          }
          await this.versions.activate(entry.path, body.versionId);
          sendJson(res, 200, { activeVersion: body.versionId });
          return;
        }

        case 'app-version-delete': {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          if (entry.mode !== 'uploaded') {
            sendError(res, 409, 'not_uploaded', 'Versioning is uploaded-mode only.');
            return;
          }
          await this.versions.deleteVersion(entry.path, route.versionId);
          sendJson(res, 200, { id: route.appId, versionId: route.versionId });
          return;
        }

        case 'app-schema': {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          if (entry.mode !== 'uploaded') {
            sendError(res, 409, 'not_uploaded', 'Schema endpoint is uploaded-mode only.');
            return;
          }
          const active = await this.versions.getActiveVersion(entry.path);
          if (!active) {
            sendError(res, 503, 'no_active_version', 'App has no active version yet.');
            return;
          }
          const dataDbFile = path.join(entry.path, 'data.sqlite');
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
          const codeDir = await this.resolveCodeDir(entry);
          if (!codeDir) {
            sendError(res, 503, 'no_active_version', 'App has no active version yet.');
            return;
          }
          const rel = route.kind === 'app-index' ? 'index.html' : route.rel;
          if (route.kind === 'app-index') {
            // Merge global prefs (gateway-side store) with this app's own
            // `__centraid_settings` rows and any URL-query overrides, then
            // bake the result into the served HTML so the iframe paints in
            // the right shape before any script runs.
            const dataDbFile = path.join(entry.path, 'data.sqlite');
            const globalPrefs = this.userStore?.getAllPrefs();
            const appSettings = readAppSettings(dataDbFile);
            const queryOverrides = route.query as Record<string, unknown>;
            const settingsInject = buildSettingsInject([globalPrefs, appSettings, queryOverrides]);
            await serveStatic(res, codeDir, rel, { settingsInject });
          } else {
            await serveStatic(res, codeDir, rel);
          }
          return;
        }

        case 'app-data': {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          const codeDir = await this.resolveCodeDir(entry);
          if (!codeDir) {
            sendError(res, 503, 'no_active_version', 'App has no active version yet.');
            return;
          }
          const file = path.join(codeDir, 'queries', `${route.queryName}.js`);
          const outcome = await runHandler({
            app: this.refOf(entry),
            handlerFile: file,
            handlerKind: 'query',
            args: { params: {}, query: route.query },
            timeoutMs: 10_000,
          });
          if (!outcome.ok) {
            sendError(res, 500, 'handler_error', outcome.error ?? 'query failed');
            return;
          }
          sendJson(res, 200, outcome.value ?? null);
          return;
        }

        case 'app-run': {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          const codeDir = await this.resolveCodeDir(entry);
          if (!codeDir) {
            sendError(res, 503, 'no_active_version', 'App has no active version yet.');
            return;
          }
          const body = JSON.parse((await readBody(req)).toString('utf8')) as {
            action?: string;
            args?: unknown;
          };
          if (!body.action) {
            sendError(res, 400, 'bad_request', 'Body must include { action }.');
            return;
          }
          const file = path.join(codeDir, 'actions', `${body.action}.js`);
          const outcome = await runHandler({
            app: this.refOf(entry),
            handlerFile: file,
            handlerKind: 'action',
            args: { params: {}, body: body.args },
            timeoutMs: 30_000,
            onWrite: this.emitForApp(route.appId, 'handler'),
          });
          if (!outcome.ok) {
            sendError(res, 500, 'handler_error', outcome.error ?? 'action failed');
            return;
          }
          const result = (outcome.value ?? {}) as { status?: number; body?: unknown };
          sendJson(res, result.status ?? 200, result.body ?? null);
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
          const status = await this.runnerStatus();
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
      if (err instanceof VersionStoreError) {
        const status = err.code === 'not_found' ? 404 : 409;
        sendError(res, status, err.code, err.message);
        return;
      }
      if (err instanceof UploadError) {
        const status = err.code === 'too_large' ? 413 : 400;
        sendError(res, status, err.code, err.message);
        return;
      }
      sendError(res, 500, 'internal_error', err instanceof Error ? err.message : String(err));
    }
  }
}
