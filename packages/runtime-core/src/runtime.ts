import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Registry, RegistryError } from './registry.js';
import { CronSync } from './cron-sync.js';
import type { Scheduler, CronChangedEvent } from './scheduler.js';
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
import { handleAppIngest, handleAppUpload } from './route-handlers.js';
import type { AppRef, RegistryEntry } from './types.js';

export interface RuntimeLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RuntimeOptions {
  /** Absolute path of the directory holding app folders + `_registry.json`. */
  appsDir: string;
  /** Base URL the cron webhook delivery targets — typically the loopback URL
   *  of whichever HTTP front-end is mounted on top of this runtime. */
  gatewayBaseUrl: string;
  /** Max retained versions per uploaded app (active always kept; min 2). */
  versionRetention?: number;
  /** Scheduler backend (OpenClaw, Claude Agent SDK, etc.). */
  scheduler: Scheduler;
  logger?: RuntimeLogger;
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
  readonly cronSync: CronSync;
  private readonly appsDir: string;
  private readonly versionRetention: number;
  private readonly logger: RuntimeLogger;
  private scheduler: Scheduler;
  private readonly withAppUploadLock: ReturnType<typeof makeAppUploadLocks>;

  constructor(opts: RuntimeOptions) {
    this.appsDir = opts.appsDir;
    this.versionRetention = Math.max(2, opts.versionRetention ?? 5);
    this.logger = opts.logger ?? noopLogger;
    this.scheduler = opts.scheduler;
    this.registry = new Registry(opts.appsDir);
    this.versions = new VersionStore();
    this.cronSync = new CronSync({
      registry: this.registry,
      scheduler: this.scheduler,
      versions: this.versions,
      gatewayBaseUrl: opts.gatewayBaseUrl,
    });
    this.withAppUploadLock = makeAppUploadLocks();
  }

  /**
   * Swap the scheduler backend at runtime. OpenClaw uses this when a richer
   * SDK handle becomes available after `gateway_start`.
   */
  setScheduler(scheduler: Scheduler): void {
    this.scheduler = scheduler;
    this.cronSync.setScheduler(scheduler);
  }

  /**
   * Update the base URL the runtime uses when constructing cron ingest
   * webhook targets. The desktop's in-process embed calls this after its
   * HTTP server has bound to an ephemeral loopback port.
   */
  setGatewayBaseUrl(url: string): void {
    this.cronSync.setGatewayBaseUrl(url);
  }

  /**
   * Load the registry, recover any torn `current.json` files, and reconcile
   * cron jobs with the scheduler. Idempotent; call once on host startup.
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

    try {
      await this.cronSync.syncAll();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[centraid] cron sync failed: ${msg}`);
    }
  }

  /** Forward a scheduler-side cron status update onto the registry. */
  async onCronChanged(event: CronChangedEvent): Promise<void> {
    const parts = event.jobId.split(':');
    if (parts.length !== 3 || parts[0] !== 'centraid') return;
    const [, appId, cronId] = parts as [string, string, string];
    await this.registry
      .setCronStatus(appId, cronId, {
        lastRunStatus:
          event.status === 'ok' ? 'success' : event.status === 'error' ? 'failure' : undefined,
        lastError: event.error,
        nextRunAtMs: event.nextRunAtMs ?? event.job?.state?.nextRunAtMs,
        lastRunAtMs: event.job?.state?.lastRunAtMs,
      })
      .catch(() => {});
  }

  private routeContext() {
    return {
      appsDir: this.appsDir,
      versionRetention: this.versionRetention,
      registry: this.registry,
      versions: this.versions,
      cronSync: this.cronSync,
      withAppUploadLock: this.withAppUploadLock,
      resolveCodeDir: (entry: RegistryEntry) => this.resolveCodeDir(entry),
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
   * runtime-core does not enforce its own auth (the ingest endpoint is
   * the one exception, gated on loopback + per-cron bearer).
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
              crons: Object.keys(e.cronTokens),
              cronStatus: e.cronStatus,
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
          await this.cronSync.syncApp(entry.id);
          sendJson(res, 201, { id: entry.id, path: entry.path, mode: entry.mode });
          return;
        }

        case 'registry-deregister': {
          await this.cronSync.removeAppCrons(route.appId);
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
          await this.cronSync.syncApp(entry.id);
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
          await handleQueryRoute(req, res, this.registry, route.appId);
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
          const themeInject =
            route.kind === 'app-index'
              ? { theme: route.query.theme, bgL: route.query.bgL }
              : undefined;
          await serveStatic(res, codeDir, rel, themeInject ? { themeInject } : {});
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
          });
          if (!outcome.ok) {
            sendError(res, 500, 'handler_error', outcome.error ?? 'action failed');
            return;
          }
          const result = (outcome.value ?? {}) as { status?: number; body?: unknown };
          sendJson(res, result.status ?? 200, result.body ?? null);
          return;
        }

        case 'app-crons-list': {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          sendJson(
            res,
            200,
            Object.keys(entry.cronTokens).map((cronId) => ({
              id: cronId,
              jobId: this.cronSync.jobIdFor(entry.id, cronId),
              status: entry.cronStatus[cronId] ?? null,
            })),
          );
          return;
        }

        case 'app-cron-runnow': {
          const entry = this.registry.get(route.appId);
          if (!entry) {
            sendError(res, 404, 'not_found', 'App not registered.');
            return;
          }
          const id = this.cronSync.jobIdFor(entry.id, route.cronId);
          await this.scheduler.runJobNow(id);
          sendJson(res, 202, { jobId: id });
          return;
        }

        case 'app-ingest': {
          await handleAppIngest(req, res, this.routeContext(), route.appId, route.cronId);
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
