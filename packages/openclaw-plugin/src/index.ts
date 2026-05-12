/*
 * @centraid/openclaw-plugin
 *
 * governance: allow-repo-hygiene file-size-limit single-plugin-entry-point at 540 lines
 *
 * Mounts a single `/centraid` prefix on the OpenClaw gateway and dispatches
 * to user-generated apps. Apps may be:
 *
 *   - **uploaded**:  registered + content delivered via tarball POST. Code is
 *                    versioned under `<appsDir>/<id>/versions/v_<ts>_<sha>/`,
 *                    `data.sqlite` lives at `<appsDir>/<id>/data.sqlite` and
 *                    persists across versions. Active version is selected by
 *                    `current.json#activeVersion`.
 *   - **path-mode**: registered with an external folder; no versioning.
 *
 * See README.md for the full URL surface and security model.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { resolveStateDir } from 'openclaw/plugin-sdk/state-paths';
import { Registry, RegistryError } from './lib/registry.js';
import { OpenClawCron } from './lib/openclaw-cron.js';
import { CronSync } from './lib/cron-sync.js';
import { VersionStore, VersionStoreError } from './lib/version-store.js';
import { ingestUpload, UploadError } from './lib/upload.js';
import { runHandler } from './lib/handler-runner.js';
import { parseRoute } from './lib/router.js';
import { serveStatic } from './lib/static-server.js';
import { getHeader, isLoopback, readBody, sendError, sendJson } from './lib/http-utils.js';
import { timingSafeEqual } from './lib/security.js';
import { appCodeDir, appDataDir } from './lib/app-paths.js';
import { cleanupDeregisteredApp } from './lib/deregister-cleanup.js';
import { runPendingMigrations, MigrationError } from './lib/migrate.js';
import { readAppSchema } from './lib/schema.js';
import { handleTableRowsRoute, handleQueryRoute, handleLogsRoute } from './lib/cloud-routes.js';
import { extractAgentFinalText, tryParseJson } from './lib/payload.js';
import { makeAppUploadLocks } from './lib/upload-lock.js';
import type { AppRef, RegistryEntry } from './types.js';

// Re-export public handler types so apps written in TypeScript can do:
//   import type { QueryHandler, ActionHandler, CronHandler } from "@centraid/openclaw-plugin";
export type {
  QueryHandler,
  ActionHandler,
  CronHandler,
  QueryHandlerArgs,
  ActionHandlerArgs,
  CronHandlerArgs,
  ActionResult,
  ScopedDb,
  ScopedLog,
  AppRef,
} from './types.js';

// Live-schema shape returned by `GET /centraid/_apps/<id>/schema`. Consumed
// by `@centraid/agent-harness` to inject schema into the agent's prompt.
export type {
  AppSchema,
  AppSchemaTable,
  AppSchemaColumn,
  AppSchemaIndex,
  AppSchemaView,
} from './lib/schema.js';

// Cloud-panel payloads — row browser, SQL editor, logs.
export type { AppTableRows } from './lib/table-rows.js';
export type { RunQueryResult } from './lib/run-query.js';
export type { LogEntry, LogLevel } from './lib/log-store.js';

export default definePluginEntry({
  id: 'centraid',
  name: 'Centraid',
  description:
    'Mounts /centraid on the gateway. Apps may be registered by path or uploaded as versioned tar.gz archives; each app has static assets, a persistent sqlite database, and JS handlers for queries / actions / cron-fed ingest.',

  register(api: OpenClawPluginApi) {
    const pluginConfig = (api.pluginConfig ?? {}) as {
      appsDir?: string;
      gatewayBaseUrl?: string;
      versionRetention?: number;
    };
    // Relative `appsDir` resolves under OpenClaw's state dir (~/.openclaw by
    // default, OPENCLAW_STATE_DIR override), NOT the plugin source tree —
    // runtime state must not live next to code, especially with --link installs.
    const appsDirRaw = pluginConfig.appsDir ?? 'centraid';
    const appsDir = path.isAbsolute(appsDirRaw)
      ? appsDirRaw
      : path.join(resolveStateDir(process.env), appsDirRaw);
    const gatewayBaseUrl = pluginConfig.gatewayBaseUrl ?? 'http://127.0.0.1:18789';
    const versionRetention = Math.max(2, pluginConfig.versionRetention ?? 5);

    const registry = new Registry(appsDir);
    const versions = new VersionStore();
    let cronAdapter = new OpenClawCron(); // Path B by default (shell out).
    let cronSync = new CronSync({ registry, cron: cronAdapter, versions, gatewayBaseUrl });

    const withAppUploadLock = makeAppUploadLocks();

    // Resolve the active code dir for an entry (uploaded → version dir).
    const resolveCodeDir = async (entry: RegistryEntry): Promise<string | undefined> => {
      if (entry.mode === 'uploaded') {
        const active = await versions.getActiveVersion(entry.path);
        if (!active) return undefined;
        return appCodeDir(entry, active);
      }
      return appCodeDir(entry);
    };

    const refOf = (entry: RegistryEntry): AppRef => ({
      id: entry.id,
      dir: appDataDir(entry),
    });

    // ---------- Lifecycle ----------

    api.on('gateway_start', async (_event, ctx) => {
      await registry.load();

      // Recovery pass for any uploaded app whose current.json is missing/torn.
      for (const entry of registry.list()) {
        if (entry.mode !== 'uploaded') continue;
        try {
          const repaired = await versions.recover(entry.path);
          if (repaired) {
            api.logger.warn(`[centraid] recovered current.json for app "${entry.id}"`);
          }
        } catch (err) {
          api.logger.error(
            `[centraid] recovery failed for "${entry.id}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Path A becomes available if the gateway exposes a getCron() handle.
      // We use it for list/remove only; add() always goes through the CLI
      // because the public cron service shape doesn't support webhook delivery.
      const handle = ctx.getCron?.();
      if (handle) {
        cronAdapter = new OpenClawCron({ handle });
        cronSync = new CronSync({ registry, cron: cronAdapter, versions, gatewayBaseUrl });
      }

      try {
        await cronSync.syncAll();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        api.logger.error(`[centraid] cron sync failed: ${msg}`);
      }
    });

    api.on('cron_changed', async (event) => {
      const parts = event.jobId.split(':');
      if (parts.length !== 3 || parts[0] !== 'centraid') return;
      const [, appId, cronId] = parts as [string, string, string];
      await registry
        .setCronStatus(appId, cronId, {
          lastRunStatus:
            event.status === 'ok' ? 'success' : event.status === 'error' ? 'failure' : undefined,
          lastError: event.error,
          nextRunAtMs: event.nextRunAtMs ?? event.job?.state?.nextRunAtMs,
          lastRunAtMs: event.job?.state?.lastRunAtMs,
        })
        .catch(() => {});
    });

    // ---------- HTTP route ----------

    api.registerHttpRoute({
      path: '/centraid',
      match: 'prefix',
      auth: 'gateway',
      handler: async (req, res) => {
        const route = parseRoute(req.method ?? 'GET', req.url ?? '/');

        try {
          switch (route.kind) {
            case 'registry-list': {
              return sendJson(
                res,
                200,
                registry.list().map((e) => ({
                  id: e.id,
                  path: e.path,
                  mode: e.mode,
                  registeredAt: e.registeredAt,
                  crons: Object.keys(e.cronTokens),
                  cronStatus: e.cronStatus,
                })),
              );
            }

            case 'registry-register': {
              const body = JSON.parse((await readBody(req)).toString('utf8')) as {
                id?: string;
                path?: string;
              };
              if (!body.id || !body.path) {
                return sendError(res, 400, 'bad_request', 'Body must include { id, path }.');
              }
              const entry = await registry.register({ id: body.id, path: body.path, mode: 'path' });
              await cronSync.syncApp(entry.id);
              return sendJson(res, 201, { id: entry.id, path: entry.path, mode: entry.mode });
            }

            case 'registry-deregister': {
              await cronSync.removeAppCrons(route.appId);
              const removed = await registry.deregister(route.appId);
              if (!removed) return sendError(res, 404, 'not_found', 'App not registered.');
              await cleanupDeregisteredApp(appsDir, removed, api.logger);
              return sendJson(res, 200, { id: route.appId });
            }

            case 'app-upload': {
              return await withAppUploadLock(route.appId, async () => {
                const entry = await registry.ensureUploaded(route.appId);

                let result;
                try {
                  result = await ingestUpload(req, appsDir, route.appId);
                } catch (err) {
                  if (err instanceof UploadError) {
                    const status = err.code === 'too_large' ? 413 : 400;
                    return sendError(res, status, err.code, err.message);
                  }
                  throw err;
                }

                // Apply pending migrations to the persistent data.sqlite BEFORE
                // flipping `current.json`. On failure, the extracted dir is
                // discarded and the previously active version keeps serving.
                let migrationsApplied: number[] = [];
                try {
                  const dataDbFile = path.join(entry.path, 'data.sqlite');
                  const out = await runPendingMigrations(result.extractedDir, dataDbFile);
                  migrationsApplied = out.applied;
                } catch (err) {
                  await fs
                    .rm(result.extractedDir, { recursive: true, force: true })
                    .catch(() => {});
                  if (err instanceof MigrationError) {
                    const status = err.code === 'sql_failed' ? 422 : 400;
                    return sendJson(res, status, {
                      error: err.code,
                      message: err.message,
                      file: err.file,
                      sqlError: err.sqlError,
                    });
                  }
                  throw err;
                }

                await versions.commit(entry.path, result.extractedDir, {
                  versionId: result.versionId,
                  sha256: result.sha256,
                  declaredVersion: result.declaredVersion,
                  uploadedAt: new Date().toISOString(),
                  bytes: result.bytes,
                  files: result.files,
                });

                await versions.prune(entry.path, versionRetention).catch(() => {});

                // Clear stale cron tokens that don't exist in the new version.
                await cronSync.syncApp(entry.id);

                return sendJson(res, 201, {
                  id: entry.id,
                  versionId: result.versionId,
                  declaredVersion: result.declaredVersion,
                  sha256: result.sha256,
                  files: result.files,
                  bytes: result.bytes,
                  activated: true,
                  migrationsApplied,
                });
              });
            }

            case 'app-versions-list': {
              const entry = registry.get(route.appId);
              if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');
              if (entry.mode !== 'uploaded') {
                return sendError(
                  res,
                  409,
                  'not_uploaded',
                  'Versioning is only available for uploaded apps.',
                );
              }
              const { activeVersion, versions: history } = await versions.listVersions(entry.path);
              return sendJson(res, 200, {
                activeVersion,
                versions: history.map((v) => ({ ...v, current: v.versionId === activeVersion })),
              });
            }

            case 'app-version-activate': {
              const entry = registry.get(route.appId);
              if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');
              if (entry.mode !== 'uploaded') {
                return sendError(res, 409, 'not_uploaded', 'Activate is uploaded-mode only.');
              }
              const body = JSON.parse((await readBody(req)).toString('utf8')) as {
                versionId?: string;
              };
              if (!body.versionId) {
                return sendError(res, 400, 'bad_request', 'Body must include { versionId }.');
              }
              await versions.activate(entry.path, body.versionId);
              await cronSync.syncApp(entry.id);
              return sendJson(res, 200, { activeVersion: body.versionId });
            }

            case 'app-version-delete': {
              const entry = registry.get(route.appId);
              if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');
              if (entry.mode !== 'uploaded') {
                return sendError(res, 409, 'not_uploaded', 'Versioning is uploaded-mode only.');
              }
              await versions.deleteVersion(entry.path, route.versionId);
              return sendJson(res, 200, { id: route.appId, versionId: route.versionId });
            }

            case 'app-schema': {
              const entry = registry.get(route.appId);
              if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');
              if (entry.mode !== 'uploaded') {
                return sendError(
                  res,
                  409,
                  'not_uploaded',
                  'Schema endpoint is uploaded-mode only.',
                );
              }
              const active = await versions.getActiveVersion(entry.path);
              if (!active) {
                return sendError(res, 503, 'no_active_version', 'App has no active version yet.');
              }
              const dataDbFile = path.join(entry.path, 'data.sqlite');
              const schema = readAppSchema(dataDbFile);
              return sendJson(res, 200, schema);
            }

            case 'app-table-rows': {
              return await handleTableRowsRoute(
                res,
                registry,
                route.appId,
                route.tableName,
                route.query,
              );
            }

            case 'app-query': {
              return await handleQueryRoute(req, res, registry, route.appId);
            }

            case 'app-logs': {
              return await handleLogsRoute(res, registry, route.appId, route.query);
            }

            case 'app-index':
            case 'app-static': {
              const entry = registry.get(route.appId);
              if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');
              const codeDir = await resolveCodeDir(entry);
              if (!codeDir) {
                return sendError(res, 503, 'no_active_version', 'App has no active version yet.');
              }
              const rel = route.kind === 'app-index' ? 'index.html' : route.rel;
              return await serveStatic(res, codeDir, rel);
            }

            case 'app-data': {
              const entry = registry.get(route.appId);
              if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');
              const codeDir = await resolveCodeDir(entry);
              if (!codeDir) {
                return sendError(res, 503, 'no_active_version', 'App has no active version yet.');
              }
              const file = path.join(codeDir, 'queries', `${route.queryName}.js`);
              const outcome = await runHandler({
                app: refOf(entry),
                handlerFile: file,
                handlerKind: 'query',
                args: { params: {}, query: route.query },
                timeoutMs: 10_000,
              });
              if (!outcome.ok) {
                return sendError(res, 500, 'handler_error', outcome.error ?? 'query failed');
              }
              return sendJson(res, 200, outcome.value ?? null);
            }

            case 'app-run': {
              const entry = registry.get(route.appId);
              if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');
              const codeDir = await resolveCodeDir(entry);
              if (!codeDir) {
                return sendError(res, 503, 'no_active_version', 'App has no active version yet.');
              }
              const body = JSON.parse((await readBody(req)).toString('utf8')) as {
                action?: string;
                args?: unknown;
              };
              if (!body.action) {
                return sendError(res, 400, 'bad_request', 'Body must include { action }.');
              }
              const file = path.join(codeDir, 'actions', `${body.action}.js`);
              const outcome = await runHandler({
                app: refOf(entry),
                handlerFile: file,
                handlerKind: 'action',
                args: { params: {}, body: body.args },
                timeoutMs: 30_000,
              });
              if (!outcome.ok) {
                return sendError(res, 500, 'handler_error', outcome.error ?? 'action failed');
              }
              const result = (outcome.value ?? {}) as { status?: number; body?: unknown };
              return sendJson(res, result.status ?? 200, result.body ?? null);
            }

            case 'app-crons-list': {
              const entry = registry.get(route.appId);
              if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');
              return sendJson(
                res,
                200,
                Object.keys(entry.cronTokens).map((cronId) => ({
                  id: cronId,
                  jobId: cronSync.jobIdFor(entry.id, cronId),
                  status: entry.cronStatus[cronId] ?? null,
                })),
              );
            }

            case 'app-cron-runnow': {
              const entry = registry.get(route.appId);
              if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');
              const id = cronSync.jobIdFor(entry.id, route.cronId);
              await cronAdapter.runJobNow(id);
              return sendJson(res, 202, { jobId: id });
            }

            case 'app-ingest': {
              if (!isLoopback(req)) {
                return sendError(res, 403, 'loopback_only', 'Ingest accepts loopback only.');
              }
              const entry = registry.get(route.appId);
              if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');
              const codeDir = await resolveCodeDir(entry);
              if (!codeDir) {
                return sendError(res, 503, 'no_active_version', 'App has no active version yet.');
              }

              const expected = registry.cronToken(route.appId, route.cronId);
              const auth = (getHeader(req, 'authorization') ?? '').replace(/^Bearer\s+/i, '');
              if (!expected || !auth || !timingSafeEqual(auth, expected)) {
                return sendError(res, 401, 'unauthorized', 'Invalid bearer token.');
              }

              const raw = (await readBody(req)).toString('utf8');
              let parsedJson: unknown;
              try {
                parsedJson = JSON.parse(raw);
              } catch {
                /* leave parsedJson undefined; handler can read .text */
              }

              const text = extractAgentFinalText(parsedJson) ?? raw;
              const handlerFile = path.join(codeDir, 'crons', `${route.cronId}.js`);

              const outcome = await runHandler({
                app: refOf(entry),
                handlerFile,
                handlerKind: 'cron',
                args: {
                  payload: {
                    text,
                    json: tryParseJson(text),
                    raw,
                    headers: Object.fromEntries(
                      Object.entries(req.headers).map(([k, v]) => [
                        k,
                        Array.isArray(v) ? v.join(',') : (v ?? ''),
                      ]),
                    ),
                    jobId: cronSync.jobIdFor(entry.id, route.cronId),
                    runId: getHeader(req, 'x-openclaw-run-id'),
                  },
                },
                timeoutMs: 60_000,
              });

              if (!outcome.ok) {
                return sendError(res, 500, 'ingest_error', outcome.error ?? 'ingest failed');
              }
              return sendJson(res, 200, { ok: true, logs: outcome.logs.length });
            }

            case 'not-found':
              return sendError(res, 404, 'not_found', 'Unknown centraid path.');
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
            return sendError(res, status, err.code, err.message);
          }
          if (err instanceof VersionStoreError) {
            const status = err.code === 'not_found' ? 404 : 409;
            return sendError(res, status, err.code, err.message);
          }
          if (err instanceof UploadError) {
            const status = err.code === 'too_large' ? 413 : 400;
            return sendError(res, status, err.code, err.message);
          }
          return sendError(
            res,
            500,
            'internal_error',
            err instanceof Error ? err.message : String(err),
          );
        }
      },
    });
  },
});
