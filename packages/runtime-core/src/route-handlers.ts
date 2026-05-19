import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry } from './registry.js';
import type { VersionStore } from './version-store.js';
import { ingestUpload, UploadError } from './upload.js';
import { runPendingMigrations, MigrationError } from './migrate.js';
import { sendError, sendJson } from './http-utils.js';
import type { RegistryEntry } from './types.js';
import type { AutomationStore } from './automation-store.js';
import { syncAutomationsFromDisk, type SyncAutomationsResult } from './sync-automations.js';

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
  /**
   * Optional automation mirror store (issue #70). When provided,
   * `handleAppUpload` syncs the just-extracted version's
   * `automations/*.json` into it so the desktop UI + scheduler
   * reconciler see the deployed set.
   */
  automationStore?: AutomationStore;
  /**
   * Fired after a successful sync — hosts wire their scheduler
   * reconciler here (openclaw cron, OS scheduler). Fires only when the
   * mirror actually changed.
   */
  onAutomationsSynced?: (appId: string, result: SyncAutomationsResult) => void | Promise<void>;
  /** Optional logger so sync errors don't sink silently. */
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

    // Deploy automations: scan the just-committed version's `automations/`
    // and bring the mirror into agreement. Best-effort — a manifest error
    // shouldn't fail the upload (the publish still succeeded), so we
    // surface in the response and log. The host scheduler reconciles
    // separately via `onAutomationsSynced`.
    //
    // `versions.commit` above renamed the staging dir into
    // `<entry.path>/versions/<versionId>/`, so `result.extractedDir`
    // no longer exists on disk — point sync at the post-commit path
    // or it reads ENOENT and wipes the mirror rows the clone-time
    // sync just wrote.
    const committedDir = path.join(entry.path, 'versions', result.versionId);
    let automationSync: SyncAutomationsResult | undefined;
    if (ctx.automationStore) {
      try {
        automationSync = await syncAutomationsFromDisk({
          appId,
          appCodeDir: committedDir,
          store: ctx.automationStore,
          // The persistent app root holds `data.sqlite`; its
          // `__centraid_settings` table carries user-set automation
          // toggles. Sync reads these so a user-disabled automation
          // stays disabled across republish.
          dataDbFile: path.join(entry.path, 'data.sqlite'),
        });
        const changed =
          automationSync.added.length +
            automationSync.updated.length +
            automationSync.removed.length >
          0;
        if (changed && ctx.onAutomationsSynced) {
          await ctx.onAutomationsSynced(appId, automationSync);
        }
        if (automationSync.errors.length > 0 && ctx.logger) {
          for (const e of automationSync.errors) {
            ctx.logger.warn(
              `[centraid] automation manifest "${appId}/${e.file}" invalid: ${e.error}`,
            );
          }
        }
      } catch (err) {
        ctx.logger?.warn(
          `[centraid] automation sync for "${appId}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    sendJson(res, 201, {
      id: entry.id,
      versionId: result.versionId,
      declaredVersion: result.declaredVersion,
      sha256: result.sha256,
      files: result.files,
      bytes: result.bytes,
      activated: true,
      migrationsApplied,
      ...(automationSync ? { automations: automationSync } : {}),
    });
  });
}
