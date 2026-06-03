// HTTP surface for the gateway-owned git store (issue #137).
//
// These routes live in gateway-runtime, not app-engine, because
// they're specific to the WorktreeStore backend — app-engine stays
// backend-agnostic (OpenClaw + standalone share it). They're mounted
// via `startRuntimeHttpServer`'s `extraHandlers` seam, after the
// bearer check, before `runtime.handle`.
//
// Surface (all under the reserved `_apps` namespace, distinct verbs
// from the legacy upload routes app-engine still owns):
//
//   GET    /centraid/_apps                           list apps + metadata
//          → { apps: [{id, name?, description?, hasIndex}] }
//   POST   /centraid/_apps/_sessions                 open a session
//          → { sessionId }
//   DELETE /centraid/_apps/_sessions/<id>            close a session
//   GET    /centraid/_apps/_sessions                 list active sessions
//   PUT    /centraid/_apps/<appId>/files/<path>      write a draft file
//          body = raw file bytes (text)
//   GET    /centraid/_apps/<appId>/files             read draft files
//          ?sessionId=<id>
//   POST   /centraid/_apps/<appId>/publish           publish a session
//          → { sessionId, message }
//   POST   /centraid/_apps/<appId>/rollback          forward-only rollback
//          → { versionTag }
//   POST   /centraid/_apps/<appId>/reset-data        re-seed draft data
//          → { sessionId } — VACUUM live + replay pending migrations (#144)
//   GET    /centraid/_apps/<appId>/git-versions      tag-driven history
//   DELETE /centraid/_apps/<appId>                   remove app from main
//
// Publish validates the manifest against the *session worktree* before
// the merge — the validation that used to run client-side in
// agent-harness's publish.ts now runs gateway-side, since the
// gateway owns the data.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MigrationError } from '@centraid/app-engine';
import { WorktreeStore, WorktreeStoreError } from './worktree-store/index.js';
import { readBody, readJson, sendJson } from './route-helpers.js';
import { validateManifestAt } from './validate-manifest.js';
import { runPublishMigrations } from './publish-migrations.js';
import { seedDraftData } from './draft-data.js';

// Re-exported so existing importers (lifecycle-shared) keep their path; the
// implementation moved to validate-manifest.ts (issue #167, file-size hygiene).
export { validateManifestAt } from './validate-manifest.js';

/** Text extensions a draft file write accepts — mirrors agent-harness. */
const EDITABLE_EXT = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.html',
  '.htm',
  '.css',
  '.json',
  '.md',
  '.txt',
  '.svg',
]);

const MAX_DRAFT_FILE_BYTES = 1 * 1024 * 1024; // 1 MiB per file

export interface AppsStoreRouteOptions {
  /**
   * Called after a successful publish/rollback with the app id, so the
   * host can register the app in the runtime's registry (a brand-new
   * app published mid-session isn't in the boot-time sync yet). The
   * gateway wires `runtime.registry.ensureUploaded`.
   */
  onAppLive?: (appId: string) => Promise<void>;
  /**
   * Called after a successful delete of an app so the host can drop
   * it from the runtime's registry + tear down its data dir.
   */
  onAppDeleted?: (appId: string) => Promise<void>;
  /**
   * Resolve an app's LIVE `data.sqlite` path (`<appsDir>/<appId>/data.sqlite`).
   * Injected so publish can run the session's committed migrations against
   * live data before the ff-merge (issue #144) — the store itself stays
   * data-agnostic. Omitted on backends without a live data tree.
   */
  liveDataFile?: (appId: string) => string;
}

/**
 * Build the apps-store route handler bound to a live `WorktreeStore`.
 * Returns a function suitable for `startRuntimeHttpServer`'s
 * `extraHandlers`: resolves `true` when it owned the request.
 */
export function makeAppsStoreRouteHandler(
  store: WorktreeStore,
  opts: AppsStoreRouteOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    if (!pathname.startsWith('/centraid/_apps')) return false;
    const segments = pathname.slice('/centraid/'.length).split('/').filter(Boolean);
    // segments[0] === '_apps'
    const method = (req.method ?? 'GET').toUpperCase();

    try {
      // ---- collection-level: GET /_apps (list with metadata) ----
      // Shadows app-engine's legacy registry-list route and returns
      // the same flat-array shape, extended with `name`, `description`,
      // and `hasIndex` so the desktop home shelf doesn't need a
      // workspaceDir scan to render tiles.
      if (segments.length === 1 && method === 'GET') {
        const apps = await store.listAppsWithMeta();
        sendJson(res, 200, apps);
        return true;
      }

      // ---- session lifecycle: /_apps/_sessions[/<id>] ----
      if (segments[1] === '_sessions') {
        return await handleSessions(store, req, res, method, segments);
      }

      // Everything else is /_apps/<appId>[/<verb>]
      const appId = decodeURIComponent(segments[1] ?? '');
      const verb = segments[2];
      if (!appId || appId.startsWith('_')) return false;

      // ---- per-app collection-level: DELETE /_apps/<appId> ----
      if (segments.length === 2 && method === 'DELETE') {
        // Delete is idempotent. `store.deleteApp` throws `no_changes` when
        // there's no code subtree on `main` to drop — which is the normal
        // state for a never-published draft, and also what a redundant
        // second DELETE of an already-removed app hits. Neither is a
        // failure: we still run the registry/data-dir/session teardown
        // below so a draft (or a re-delete) cleans up fully and reports
        // success instead of surfacing a confusing `no_changes` error.
        let codeRemoved = true;
        try {
          await store.deleteApp(appId);
        } catch (err) {
          if (err instanceof WorktreeStoreError && err.code === 'no_changes') {
            codeRemoved = false;
          } else {
            throw err;
          }
        }
        if (opts.onAppDeleted) await opts.onAppDeleted(appId);
        sendJson(res, 200, { id: appId, deleted: true, codeRemoved });
        return true;
      }

      if (verb === 'publish' && method === 'POST') {
        return await handlePublish(store, req, res, appId, opts.onAppLive, opts.liveDataFile);
      }
      if (verb === 'rollback' && method === 'POST') {
        return await handleRollback(store, req, res, appId, opts.onAppLive);
      }
      if (verb === 'reset-data' && method === 'POST') {
        return await handleResetData(store, req, res, appId, opts.liveDataFile);
      }
      if (verb === 'git-versions' && method === 'GET') {
        const versions = await store.listVersions(appId);
        sendJson(res, 200, { versions });
        return true;
      }
      if (verb === 'files') {
        return await handleFiles(store, req, res, method, appId, segments, url);
      }

      return false;
    } catch (err) {
      return sendStoreError(res, err);
    }
  };
}

async function handleSessions(
  store: WorktreeStore,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
): Promise<boolean> {
  if (segments.length === 2) {
    if (method === 'POST') {
      const body = await readJson(req);
      const sessionId =
        typeof body.sessionId === 'string' && body.sessionId.length > 0
          ? body.sessionId
          : `s_${Date.now().toString(36)}`;
      const handle = await store.openSession(sessionId);
      sendJson(res, 201, { sessionId: handle.id, branch: handle.branch });
      return true;
    }
    if (method === 'GET') {
      sendJson(res, 200, { sessions: await store.listSessions() });
      return true;
    }
    return false;
  }
  if (segments.length === 3 && method === 'DELETE') {
    const sessionId = decodeURIComponent(segments[2] ?? '');
    await store.closeSession(sessionId);
    sendJson(res, 200, { sessionId });
    return true;
  }
  return false;
}

async function handlePublish(
  store: WorktreeStore,
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  onAppLive?: (appId: string) => Promise<void>,
  liveDataFile?: (appId: string) => string,
): Promise<boolean> {
  const body = await readJson(req);
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  const message = typeof body.message === 'string' ? body.message : '';
  if (!sessionId || !message) {
    sendJson(res, 400, { error: 'bad_request', message: 'publish needs { sessionId, message }' });
    return true;
  }

  // Manifest validation moved gateway-side (was agent-harness's
  // assertManifestValid). Validate the session worktree's app.json +
  // handler files BEFORE the merge so an invalid manifest fails the
  // publish instead of producing a dead live version.
  const appDir = await store.snapshotSessionAppDir(sessionId, appId);
  const validationError = await validateManifestAt(appDir);
  if (validationError) {
    sendJson(res, 400, { error: 'invalid_manifest', message: validationError });
    return true;
  }

  // Migrate LIVE data as part of publish (#144): the `migrate` hook fires
  // inside the store's mutex, post-rebase + pre-ff-merge, so migrations apply
  // against the exact tree going live. A failure aborts the publish untouched.
  let result;
  try {
    result = await store.publish({
      sessionId,
      appId,
      message,
      ...(liveDataFile
        ? { migrate: (dir: string) => runPublishMigrations(dir, liveDataFile(appId)) }
        : {}),
    });
  } catch (err) {
    if (err instanceof MigrationError) {
      const status = err.code === 'sql_failed' ? 422 : 400;
      sendJson(res, status, {
        error: err.code,
        message: err.message,
        file: err.file,
        sqlError: err.sqlError,
      });
      return true;
    }
    throw err;
  }
  await onAppLive?.(appId);
  sendJson(res, 201, {
    id: appId,
    versionTag: result.versionTag,
    sha: result.sha,
    activated: true,
    migrationsApplied: result.migrationsApplied,
  });
  return true;
}

async function handleRollback(
  store: WorktreeStore,
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  onAppLive?: (appId: string) => Promise<void>,
): Promise<boolean> {
  const body = await readJson(req);
  const versionTag = typeof body.versionTag === 'string' ? body.versionTag : '';
  if (!versionTag) {
    sendJson(res, 400, { error: 'bad_request', message: 'rollback needs { versionTag }' });
    return true;
  }
  const result = await store.rollback({ appId, versionTag });
  await onAppLive?.(appId);
  sendJson(res, 200, { id: appId, sha: result.sha, rolledBackTo: versionTag });
  return true;
}

/**
 * Re-seed a draft session's branched `data.sqlite` from a fresh prod snapshot
 * + replay its pending migrations (issue #144). Doubles as a dress rehearsal
 * of the publish migration against real prod data: a migration incompatible
 * with live rows fails here and the SQL error surfaces inline (422), letting
 * the author hit it in preview before publishing.
 */
async function handleResetData(
  store: WorktreeStore,
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  liveDataFile?: (appId: string) => string,
): Promise<boolean> {
  const body = await readJson(req);
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    sendJson(res, 400, { error: 'bad_request', message: 'reset-data needs { sessionId }' });
    return true;
  }
  if (!liveDataFile) {
    sendJson(res, 400, { error: 'bad_request', message: 'reset-data needs a live data backend' });
    return true;
  }
  // Throws `session_missing` (→ 404) via the outer handler when the worktree
  // isn't open.
  const worktreeAppDir = await store.snapshotSessionAppDir(sessionId, appId);
  try {
    const out = await seedDraftData({
      liveDataFile: liveDataFile(appId),
      worktreeAppDir,
      force: true,
    });
    sendJson(res, 200, { id: appId, seeded: out.seeded, migrationsApplied: out.migrationsApplied });
  } catch (err) {
    if (err instanceof MigrationError) {
      const status = err.code === 'sql_failed' ? 422 : 400;
      sendJson(res, status, {
        error: err.code,
        message: err.message,
        file: err.file,
        sqlError: err.sqlError,
      });
      return true;
    }
    throw err;
  }
  return true;
}

async function handleFiles(
  store: WorktreeStore,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  appId: string,
  segments: string[],
  url: URL,
): Promise<boolean> {
  if (method === 'GET') {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    if (!sessionId) {
      sendJson(res, 400, { error: 'bad_request', message: 'files read needs ?sessionId' });
      return true;
    }
    const appDir = await store.snapshotSessionAppDir(sessionId, appId);
    sendJson(res, 200, { files: await readDraftFiles(appDir) });
    return true;
  }
  if (method === 'PUT') {
    // /_apps/<appId>/files/<rel...> — rel path is segments[3..]
    const rel = segments
      .slice(3)
      .map((s) => decodeURIComponent(s))
      .join('/');
    const sessionId = url.searchParams.get('sessionId') ?? '';
    if (!sessionId || !rel) {
      sendJson(res, 400, { error: 'bad_request', message: 'files write needs ?sessionId + path' });
      return true;
    }
    const result = await writeDraftFile(store, sessionId, appId, rel, await readBody(req));
    sendJson(res, 200, result);
    return true;
  }
  if (method === 'DELETE') {
    // /_apps/<appId>/files/<rel...> — remove a draft file from the
    // session worktree (issue #141: app-owned-automation delete over HTTP).
    const rel = segments
      .slice(3)
      .map((s) => decodeURIComponent(s))
      .join('/');
    const sessionId = url.searchParams.get('sessionId') ?? '';
    if (!sessionId || !rel) {
      sendJson(res, 400, { error: 'bad_request', message: 'files delete needs ?sessionId + path' });
      return true;
    }
    const appDir = await store.snapshotSessionAppDir(sessionId, appId);
    const abs = path.resolve(appDir, rel);
    if (abs !== appDir && !abs.startsWith(appDir + path.sep)) {
      throw new WorktreeStoreError('invalid_app_id', `Refusing to delete outside the app: ${rel}`);
    }
    await fs.rm(abs, { force: true });
    sendJson(res, 200, { path: rel, deleted: true });
    return true;
  }
  return false;
}

// ---- draft file read/write inside a session worktree ----

interface DraftFile {
  path: string;
  content: string;
}

async function readDraftFiles(appDir: string): Promise<DraftFile[]> {
  const out: DraftFile[] = [];
  await walk(appDir, '', out);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function walk(root: string, rel: string, out: DraftFile[]): Promise<void> {
  const here = rel ? path.join(root, rel) : root;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(here, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const r = rel ? path.posix.join(rel, e.name) : e.name;
    if (e.isDirectory()) {
      await walk(root, r, out);
      continue;
    }
    if (!e.isFile()) continue;
    if (!EDITABLE_EXT.has(path.extname(e.name).toLowerCase())) continue;
    const abs = path.join(root, r);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat || stat.size > MAX_DRAFT_FILE_BYTES) continue;
    out.push({ path: r, content: await fs.readFile(abs, 'utf8').catch(() => '') });
  }
}

async function writeDraftFile(
  store: WorktreeStore,
  sessionId: string,
  appId: string,
  rel: string,
  content: Buffer,
): Promise<{ path: string; size: number }> {
  const appDir = await store.snapshotSessionAppDir(sessionId, appId);
  const abs = path.resolve(appDir, rel);
  if (abs !== appDir && !abs.startsWith(appDir + path.sep)) {
    throw new WorktreeStoreError('invalid_app_id', `Refusing to write outside the app: ${rel}`);
  }
  if (!EDITABLE_EXT.has(path.extname(abs).toLowerCase())) {
    throw new WorktreeStoreError('invalid_app_id', `Not an editable text file: ${rel}`);
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
  return { path: rel, size: content.byteLength };
}

// ---- apps-store-specific error mapping (delegates to shared sendJson) ----

function sendStoreError(res: ServerResponse, err: unknown): true {
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
