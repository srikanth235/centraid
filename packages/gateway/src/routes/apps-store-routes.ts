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
//          → { apps: [{id, name?, description?, hasIndex, iconKey?, colorKey?}] }
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
//   POST   /centraid/_apps/<appId>/reset-data        re-seed the draft band
//          → { sessionId } — fresh live snapshot of the app's ext tables (#286)
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
import { ExtSpecError } from '@centraid/vault';
import { WorktreeStore, WorktreeStoreError } from '../worktree-store/index.js';
import { readBody, readJson, sendJson } from './route-helpers.js';
import { validateManifestAt } from '../validate-manifest.js';
import { applyExtOnPublish, readExtSpecs, type ExtBandOps } from '../lifecycle/ext-band.js';

// Re-exported so existing importers (lifecycle-shared) keep their path; the
// implementation moved to validate-manifest.ts (issue #167, file-size hygiene).
export { validateManifestAt } from '../validate-manifest.js';

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
   * The vault plane's ext-band operations (issue #286 phase 2). Injected
   * so publish applies the session's declared extension tables to the
   * vault before the ff-merge, and reset-data re-snapshots the draft band —
   * the store itself stays data-agnostic. Omitted on hosts without a
   * vault plane.
   */
  ext?: ExtBandOps;
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
      // `hasIndex`, and the app.json tile identity (`iconKey`/`colorKey`,
      // issue #263) so the home shelves render tiles without a
      // workspaceDir scan or a per-device metadata shim.
      if (segments.length === 1 && method === 'GET') {
        const apps = await store.listAppsWithMeta();
        sendJson(res, 200, apps);
        return true;
      }

      // ---- session lifecycle: /_apps/_sessions[/<id>] ----
      if (segments[1] === '_sessions') {
        return await handleSessions(store, req, res, method, segments, opts.ext);
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
        return await handlePublish(store, req, res, appId, opts.onAppLive, opts.ext);
      }
      if (verb === 'rollback' && method === 'POST') {
        return await handleRollback(store, req, res, appId, opts.onAppLive);
      }
      if (verb === 'reset-data' && method === 'POST') {
        return await handleResetData(store, req, res, appId, opts.ext);
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
  ext?: ExtBandOps,
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
    // Discard the session's scratch ext bands with its worktree — a closed
    // draft leaves no data residue (best-effort: the worktree may already
    // be gone, and an app may have no band at all).
    if (ext) {
      for (const appId of await store.sessionAppIds(sessionId)) {
        try {
          ext.dropAppExtDraft(appId);
        } catch {
          /* draft cleanup must never block a session close */
        }
      }
    }
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
  ext?: ExtBandOps,
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

  // Apply the declared ext band to the vault as part of publish (#286
  // phase 2): the `beforeMerge` hook fires inside the store's mutex,
  // post-rebase + pre-ff-merge, so the specs applied are the exact tree
  // going live. A refused spec aborts the publish, vault untouched.
  let result;
  let extOutcome: { created: string[]; dropped: string[]; altered: string[] } | undefined;
  try {
    result = await store.publish({
      sessionId,
      appId,
      message,
      ...(ext
        ? {
            beforeMerge: async (dir: string) => {
              extOutcome = await applyExtOnPublish(ext, appId, dir);
            },
          }
        : {}),
    });
  } catch (err) {
    if (err instanceof ExtSpecError) {
      sendJson(res, 400, { error: 'invalid_ext_spec', message: err.message });
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
    ...(extOutcome ? { ext: extOutcome } : {}),
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
 * Re-snapshot a draft session's ext band from live (issue #286 phase 2) —
 * the preview "Reset data" control. Reads the DRAFT manifest's declared
 * tables and rebuilds the scratch band with a fresh copy of live rows.
 * Doubles as a dress rehearsal of the publish DDL: a spec the vault
 * refuses surfaces inline (400) before the author publishes.
 */
async function handleResetData(
  store: WorktreeStore,
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
  ext?: ExtBandOps,
): Promise<boolean> {
  const body = await readJson(req);
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
  if (!sessionId) {
    sendJson(res, 400, { error: 'bad_request', message: 'reset-data needs { sessionId }' });
    return true;
  }
  if (!ext) {
    sendJson(res, 400, { error: 'bad_request', message: 'reset-data needs a vault plane' });
    return true;
  }
  // Throws `session_missing` (→ 404) via the outer handler when the worktree
  // isn't open.
  const worktreeAppDir = await store.snapshotSessionAppDir(sessionId, appId);
  try {
    const specs = await readExtSpecs(worktreeAppDir);
    const out =
      specs.length === 0
        ? { ...ext.dropAppExtDraft(appId), created: [], altered: [] }
        : ext.seedAppExtDraft(appId, specs, { reset: true });
    sendJson(res, 200, { id: appId, ext: out });
  } catch (err) {
    if (err instanceof ExtSpecError) {
      sendJson(res, 400, { error: 'invalid_ext_spec', message: err.message });
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
