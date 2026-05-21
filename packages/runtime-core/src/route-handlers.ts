import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry } from './registry.js';
import type { VersionStore } from './version-store.js';
import { ingestUpload, UploadError } from './upload.js';
import { runPendingMigrations, MigrationError } from './migrate.js';
import { sendError, sendJson } from './http-utils.js';
import type { RegistryEntry } from './types.js';

export interface RouteContext {
  appsDir: string;
  versionRetention: number;
  registry: Registry;
  versions: VersionStore;
  withAppUploadLock: (appId: string, fn: () => Promise<void>) => Promise<void>;
  resolveCodeDir(entry: RegistryEntry): Promise<string | undefined>;
  /**
   * Build the change-notifier closure for a given app — fired by handlers
   * after a successful write turn. Routes that don't trigger writes can
   * ignore it.
   */
  emitForApp(appId: string): (tables: string[]) => void;
  /** Optional logger so upload errors don't sink silently. */
  logger?: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

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
