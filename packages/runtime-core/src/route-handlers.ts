import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry } from './registry.js';
import type { VersionStore } from './version-store.js';
import type { CronSync } from './cron-sync.js';
import { ingestUpload, UploadError } from './upload.js';
import { runHandler } from './handler-runner.js';
import { runPendingMigrations, MigrationError } from './migrate.js';
import { getHeader, isLoopback, readBody, sendError, sendJson } from './http-utils.js';
import { timingSafeEqual } from './security.js';
import { appDataDir } from './app-paths.js';
import { extractAgentFinalText, tryParseJson } from './payload.js';
import type { AppRef, RegistryEntry } from './types.js';
import type { TelemetryWriter } from './telemetry.js';

export interface RouteContext {
  appsDir: string;
  versionRetention: number;
  registry: Registry;
  versions: VersionStore;
  cronSync: CronSync;
  withAppUploadLock: (appId: string, fn: () => Promise<void>) => Promise<void>;
  resolveCodeDir(entry: RegistryEntry): Promise<string | undefined>;
  /**
   * Build the change-notifier closure for a given app — fired by handlers
   * after a successful write turn. Routes that don't trigger writes can
   * ignore it.
   */
  emitForApp(appId: string): (tables: string[]) => void;
  /** Plugin-scope telemetry sink shared across handler kinds; optional. */
  telemetry?: TelemetryWriter;
}

const refOf = (entry: RegistryEntry): AppRef => ({ id: entry.id, dir: appDataDir(entry) });

export async function handleAppUpload(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  appId: string,
): Promise<void> {
  await ctx.withAppUploadLock(appId, async () => {
    const entry = await ctx.registry.ensureUploaded(appId);

    let result;
    try {
      result = await ingestUpload(req, ctx.appsDir, appId);
    } catch (err) {
      if (err instanceof UploadError) {
        const status = err.code === 'too_large' ? 413 : 400;
        sendError(res, status, err.code, err.message);
        return;
      }
      throw err;
    }

    let migrationsApplied: number[] = [];
    try {
      const dataDbFile = path.join(entry.path, 'data.sqlite');
      const out = await runPendingMigrations(result.extractedDir, dataDbFile);
      migrationsApplied = out.applied;
    } catch (err) {
      await fs.rm(result.extractedDir, { recursive: true, force: true }).catch(() => {});
      if (err instanceof MigrationError) {
        const status = err.code === 'sql_failed' ? 422 : 400;
        sendJson(res, status, {
          error: err.code,
          message: err.message,
          file: err.file,
          sqlError: err.sqlError,
        });
        return;
      }
      throw err;
    }

    await ctx.versions.commit(entry.path, result.extractedDir, {
      versionId: result.versionId,
      sha256: result.sha256,
      declaredVersion: result.declaredVersion,
      uploadedAt: new Date().toISOString(),
      bytes: result.bytes,
      files: result.files,
    });

    await ctx.versions.prune(entry.path, ctx.versionRetention).catch(() => {});

    await ctx.cronSync.syncApp(entry.id);

    sendJson(res, 201, {
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

export async function handleAppIngest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  appId: string,
  cronId: string,
): Promise<void> {
  if (!isLoopback(req)) {
    sendError(res, 403, 'loopback_only', 'Ingest accepts loopback only.');
    return;
  }
  const entry = ctx.registry.get(appId);
  if (!entry) {
    sendError(res, 404, 'not_found', 'App not registered.');
    return;
  }
  const codeDir = await ctx.resolveCodeDir(entry);
  if (!codeDir) {
    sendError(res, 503, 'no_active_version', 'App has no active version yet.');
    return;
  }

  const expected = ctx.registry.cronToken(appId, cronId);
  const auth = (getHeader(req, 'authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!expected || !auth || !timingSafeEqual(auth, expected)) {
    sendError(res, 401, 'unauthorized', 'Invalid bearer token.');
    return;
  }

  const raw = (await readBody(req)).toString('utf8');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    /* leave parsedJson undefined; handler can read .text */
  }

  const text = extractAgentFinalText(parsedJson) ?? raw;
  const handlerFile = path.join(codeDir, 'crons', `${cronId}.js`);

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
        jobId: ctx.cronSync.jobIdFor(entry.id, cronId),
        runId: getHeader(req, 'x-openclaw-run-id'),
      },
    },
    timeoutMs: 60_000,
    onWrite: ctx.emitForApp(entry.id),
    telemetry: ctx.telemetry,
  });

  if (!outcome.ok) {
    sendError(res, 500, 'ingest_error', outcome.error ?? 'ingest failed');
    return;
  }
  sendJson(res, 200, { ok: true, logs: outcome.logs.length });
}
