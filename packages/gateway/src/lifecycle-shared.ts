// Shared options + helpers for the gateway-owned app lifecycle routes
// (issue #141, Phase 2). Split out of `lifecycle-routes.ts` so the app
// handlers (create/clone/meta) and the automation handlers
// (create/set-enabled/delete) can each stay under the repo file-size
// limit while sharing the stage-vs-publish fork and error mapping.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppScaffoldError } from '@centraid/app-blueprints';
import { MigrationError } from '@centraid/app-engine';
import type { AutomationHistoryKeep } from '@centraid/conversation-engine';
import { WorktreeStore, WorktreeStoreError } from './worktree-store/index.js';
import { validateManifestAt } from './apps-store-routes.js';
import { runPublishMigrations } from './publish-migrations.js';
import { sendJson, writeFileMap, type FileMapEntry } from './route-helpers.js';

export interface LifecycleRouteOptions {
  /** Git store backing app code. Sessions/publishes ride through it. */
  store: WorktreeStore;
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
  /**
   * Drop an app from the runtime registry AND delete its data dir
   * (`<appsDir>/<id>/`) after the store removed its code — wires the
   * gateway's deregister+cleanup path. Used when a whole automation app
   * is deleted wholesale, so its data.sqlite + run ledgers don't linger.
   */
  deregister: (appId: string) => Promise<void>;
  /** Reconcile the gateway's in-process cron scheduler after a publish
   *  changed the live set (issue #149/#150). */
  reconcile: () => void;
  /**
   * Resolve an app's LIVE `data.sqlite` path. Injected so a lifecycle
   * publish runs the staged app's committed migrations against live data
   * before the ff-merge (issue #144) — symmetric to the apps-store publish
   * route.
   */
  liveDataFile?: (appId: string) => string;
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
export async function ensureSession(store: WorktreeStore, sessionId: string): Promise<string> {
  try {
    const handle = await store.openSession(sessionId);
    return handle.id;
  } catch (err) {
    if (err instanceof WorktreeStoreError && err.code === 'session_exists') return sessionId;
    throw err;
  }
}

/**
 * Prepare the session a lifecycle mutation will stage into.
 *
 * `ephemeral` sessions are the caller-defaulted `lifecycle-<appId>` ones a
 * one-shot create/clone/meta/automation mutation uses when the renderer
 * didn't supply its own editing session. They must start *fresh off current
 * `main`*: a previous one-shot may have left an orphan worktree branched off
 * a stale `main` (e.g. a clone that published a baseline then the app was
 * deleted), and reusing it would stage onto pre-delete state. We close any
 * leftover (idempotent) and open a clean one; {@link stageAndMaybePublish}
 * closes it again once the publish lands.
 *
 * Non-ephemeral sessions are the renderer's persistent `desktop-<appId>`
 * editing sessions — reuse them in place via {@link ensureSession} and leave
 * them open across the mutation.
 */
export async function prepareLifecycleSession(
  store: WorktreeStore,
  sessionId: string,
  ephemeral: boolean,
): Promise<void> {
  if (!ephemeral) {
    await ensureSession(store, sessionId);
    return;
  }
  await store.closeSession(sessionId);
  await store.openSession(sessionId);
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
 * The "a publish landed on `main`" invariant, in one place: validate the
 * worktree manifest, merge it onto `main`, register the now-live app, and
 * reconcile the in-process cron scheduler against the new live set.
 * Optionally close a one-shot session afterward.
 *
 * Every lifecycle mutation that publishes funnels through here so no route
 * hand-sequences `publish → ensureRegistered → reconcile` itself (issue #147,
 * Concern 3) — the apps-store publish route already centralizes the same
 * sequence via its `onAppLive` hook.
 */
export async function publishAndReconcile(
  opts: LifecycleRouteOptions,
  input: {
    appId: string;
    sessionId: string;
    /** The session worktree's app dir (already mutated by the caller). */
    appDir: string;
    message: string;
    /** Close the session after publishing — see {@link stageAndMaybePublish}. */
    ephemeralSession?: boolean;
  },
): Promise<void> {
  const validationError = await validateManifestAt(input.appDir);
  if (validationError) throw new AppScaffoldError('invalid_manifest', validationError);
  // Apply the staged app's committed migrations to live data as part of the
  // publish (issue #144). The `migrate` hook runs inside the store's mutex,
  // post-rebase + pre-ff-merge, against the final worktree tree. A failing
  // migration throws and aborts the publish, live data untouched.
  const liveDataFile = opts.liveDataFile;
  const appId = input.appId;
  await opts.store.publish({
    sessionId: input.sessionId,
    appId,
    message: input.message,
    ...(liveDataFile
      ? {
          migrate: (worktreeAppDir: string) =>
            runPublishMigrations(worktreeAppDir, liveDataFile(appId)),
        }
      : {}),
  });
  await opts.ensureRegistered(input.appId);
  opts.reconcile();
  if (input.ephemeralSession) await opts.store.closeSession(input.sessionId);
}

/**
 * Delete a whole app wholesale and reconcile: drop its code from `main`,
 * deregister it (removing its data dir + run ledgers), then reconcile the
 * scheduler so its triggers stop firing. The delete-side counterpart to
 * {@link publishAndReconcile} — keeps `reconcile()` out of the route body.
 */
export async function deleteAppAndReconcile(
  opts: LifecycleRouteOptions,
  appId: string,
): Promise<void> {
  await opts.store.deleteApp(appId);
  await opts.deregister(appId);
  opts.reconcile();
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
    /**
     * When true, close the session after a successful publish — the session
     * was a one-shot `lifecycle-<appId>` (see {@link prepareLifecycleSession}),
     * not the renderer's persistent editing session, so leaving it open would
     * orphan a worktree. No-op on the staged (`publish:false`) path: a staged
     * draft must keep its session so it stays previewable.
     */
    ephemeralSession?: boolean;
  },
): Promise<void> {
  const appDir = await opts.store.snapshotSessionAppDir(input.sessionId, input.appId);
  await writeFileMap(appDir, input.files);
  if (!input.publish) {
    await opts.ensureRegistered(input.appId);
    return;
  }
  await publishAndReconcile(opts, {
    appId: input.appId,
    sessionId: input.sessionId,
    appDir,
    message: input.message,
    ...(input.ephemeralSession ? { ephemeralSession: input.ephemeralSession } : {}),
  });
}

/** Map a lifecycle error to a status + JSON body. */
export function sendLifecycleError(res: ServerResponse, err: unknown): true {
  if (err instanceof AppScaffoldError) {
    const status = err.code === 'already_exists' ? 409 : err.code === 'not_found' ? 404 : 400;
    return sendJson(res, status, { error: err.code, message: err.message });
  }
  if (err instanceof MigrationError) {
    // A staged migration that fails against live data aborts the publish
    // (issue #144) — `sql_failed` is a runtime conflict (422), a malformed
    // migration set is a bad request (400).
    const status = err.code === 'sql_failed' ? 422 : 400;
    return sendJson(res, status, {
      error: err.code,
      message: err.message,
      file: err.file,
      sqlError: err.sqlError,
    });
  }
  if (err instanceof WorktreeStoreError) {
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
