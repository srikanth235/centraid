// Shared options + helpers for the gateway-owned app lifecycle routes
// (issue #141, Phase 2). Split out of `lifecycle-routes.ts` so the app
// handlers (create/clone/meta) and the automation handlers
// (create/set-enabled/delete) can each stay under the repo file-size
// limit while sharing the stage-vs-publish fork and error mapping.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { HarnessError } from '@centraid/builder-harness';
import type { AutomationHistoryKeep } from '@centraid/runtime-core';
import { AppsStore, AppsStoreError } from '@centraid/apps-store';
import { validateManifestAt } from './apps-store-routes.js';
import { sendJson, writeFileMap, type FileMapEntry } from './route-helpers.js';

export interface LifecycleRouteOptions {
  /** Git store backing app code. Sessions/publishes ride through it. */
  store: AppsStore;
  /** Materialized `main` apps dir — reads back a published automation row. */
  codeAppsDir: () => string;
  /** Per-gateway templates cache dir (clone resolves bundle-or-cache). */
  templatesCacheDir?: string;
  /**
   * Register/refresh an app in the runtime registry (creates its data
   * dir + entry) WITHOUT publishing — wires `runtime.registry.ensureUploaded`
   * so a staged app's draft is immediately previewable.
   */
  ensureRegistered: (appId: string) => Promise<void>;
  /** Reconcile the OS scheduler after a publish changed the live set. */
  reconcile: () => void;
}

/** Build an app's absolute webhook URL from the inbound request's host. */
export function webhookUrl(req: IncomingMessage, webhookId: string): string {
  const host = req.headers.host ?? '127.0.0.1';
  const forwarded = req.headers['x-forwarded-proto'];
  const proto =
    (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || 'http';
  return `${proto}://${host}/_centraid-hook/${webhookId}`;
}

/** Open a session, tolerating one that already exists (reuse its worktree). */
export async function ensureSession(store: AppsStore, sessionId: string): Promise<string> {
  try {
    const handle = await store.openSession(sessionId);
    return handle.id;
  } catch (err) {
    if (err instanceof AppsStoreError && err.code === 'session_exists') return sessionId;
    throw err;
  }
}

/** A session id derived from the app id, when the caller didn't supply one. */
export function defaultSessionId(appId: string): string {
  return `lifecycle-${appId}`;
}

/** Coerce a wire value into an {@link AutomationHistoryKeep}, or undefined. */
export function parseHistoryKeep(raw: unknown): AutomationHistoryKeep | undefined {
  if (raw === 'all' || raw === 'errors') return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.count === 'number') return { count: obj.count };
    if (typeof obj.days === 'number') return { days: obj.days };
  }
  return undefined;
}

/**
 * Stage a file map into a session, then either register the app (draft
 * only) or validate + publish onto `main`. Centralizes the stage/publish
 * fork shared by create / clone / automation-create.
 */
export async function stageAndMaybePublish(
  opts: LifecycleRouteOptions,
  input: {
    appId: string;
    sessionId: string;
    files: ReadonlyArray<FileMapEntry>;
    publish: boolean;
    message: string;
  },
): Promise<void> {
  const appDir = await opts.store.snapshotSessionAppDir(input.sessionId, input.appId);
  await writeFileMap(appDir, input.files);
  if (!input.publish) {
    await opts.ensureRegistered(input.appId);
    return;
  }
  const validationError = await validateManifestAt(appDir);
  if (validationError) throw new HarnessError('invalid_manifest', validationError);
  await opts.store.publish({
    sessionId: input.sessionId,
    appId: input.appId,
    message: input.message,
  });
  await opts.ensureRegistered(input.appId);
  opts.reconcile();
}

/** Map a lifecycle error to a status + JSON body. */
export function sendLifecycleError(res: ServerResponse, err: unknown): true {
  if (err instanceof HarnessError) {
    const status = err.code === 'already_exists' ? 409 : err.code === 'not_found' ? 404 : 400;
    return sendJson(res, status, { error: err.code, message: err.message });
  }
  if (err instanceof AppsStoreError) {
    const status =
      err.code === 'session_missing' || err.code === 'tag_missing'
        ? 404
        : err.code === 'session_exists'
          ? 409
          : 400;
    return sendJson(res, status, { error: err.code, message: err.message });
  }
  return sendJson(res, 500, {
    error: 'internal_error',
    message: err instanceof Error ? err.message : String(err),
  });
}
