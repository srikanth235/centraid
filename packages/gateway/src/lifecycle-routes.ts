// HTTP surface for the gateway-owned app *lifecycle* (issue #141).
//
// Phase 2 of the thin-client pivot: the deterministic builder lives in
// the gateway, not the desktop. Scaffolding a blank app, cloning a
// template, editing an app's name/description, and creating/toggling/
// deleting automations were all desktop orchestration (agent-harness
// scaffolders + app-engine webhook minting, pushed up over IPC-relayed
// session writes). They move here so the renderer states intent and the
// gateway does the work — identical for a local or remote gateway.
//
// Surface (mounted via `serve()`'s `extraHandlers`, after the bearer
// check; each verb returns `false` so the apps-store / automations
// handlers keep their own routes):
//
//   POST   /centraid/_apps                     scaffold a blank app
//          body {id, name?, version?, publish?}
//   POST   /centraid/_apps/_clone              clone a bundled template
//          body {templateId, sessionId?, publish?}
//   POST   /centraid/_apps/<id>/meta           edit name/description
//          body {name?, description?, sessionId?, publish?}
//   POST   /centraid/_automations              scaffold an automation app
//          body {id, name?, description?, prompt?, triggers?, apps?, …, publish?}
//   POST   /centraid/_automations/set-enabled?ref=<ref>   toggle enabled
//          body {enabled, publish?}
//   DELETE /centraid/_automations?ref=<ref>&publish=      remove an automation
//
// **Stage vs publish.** Every mutation stages into a git-store session
// worktree (the draft). When `publish` is falsy (the default — extends
// the explicit-publish model, #141/C6) the change stays in the session
// and the app is only *registered* (`ensureRegistered` → data dir +
// registry entry) so its draft is previewable through the runtime. When
// `publish` is true the session is validated + merged onto `main` and
// the OS scheduler is reconciled — the renderer passes this for now to
// preserve "new app is immediately live", and drops it once the preview
// iframe points at the draft URL. Either way the orchestration is the
// gateway's.
//
// Webhook secrets are minted gateway-side (create + clone): the plaintext
// is returned once in the response, only the hash is written into the
// manifest that lands on `main`. The app handlers (create/clone/meta)
// live here; the automation handlers live in `lifecycle-automation-routes`
// and the stage/publish + error helpers in `lifecycle-shared` — split to
// keep each module under the repo file-size limit.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  AppScaffoldError,
  cloneTemplateFiles,
  readTemplateFiles,
  resolveTemplates,
  scaffoldAppFiles,
  suggestCloneIdentityFrom,
  updateAppMetaFiles,
  type ScaffoldFile,
} from '@centraid/app-blueprints';
import { provisionPendingWebhooksInFiles } from '@centraid/automation';
import { readFileMap, readJson, sendJson } from './route-helpers.js';
import {
  handleAutomationCreate,
  handleAutomationDelete,
  handleAutomationSetEnabled,
} from './lifecycle-automation-routes.js';
import {
  defaultSessionId,
  prepareLifecycleSession,
  sendLifecycleError,
  stageAndMaybePublish,
  webhookUrl,
  type LifecycleRouteOptions,
} from './lifecycle-shared.js';

export type { LifecycleRouteOptions } from './lifecycle-shared.js';

/**
 * Build the lifecycle route handler bound to a live `WorktreeStore`. Returns
 * a function suitable for `startRuntimeHttpServer`'s `extraHandlers`:
 * resolves `true` when it owned the request, `false` otherwise.
 */
export function makeLifecycleRouteHandler(
  opts: LifecycleRouteOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const method = (req.method ?? 'GET').toUpperCase();

    const isApps = pathname === '/centraid/_apps' || pathname.startsWith('/centraid/_apps/');
    const isAutomations = pathname.startsWith('/centraid/_automations');
    if (!isApps && !isAutomations) return false;

    try {
      if (pathname === '/centraid/_apps' && method === 'POST') {
        return await handleCreate(opts, req, res);
      }
      if (pathname === '/centraid/_apps/_clone' && method === 'POST') {
        return await handleClone(opts, req, res);
      }
      const metaMatch = /^\/centraid\/_apps\/([^/]+)\/meta$/.exec(pathname);
      if (metaMatch && method === 'POST') {
        return await handleMeta(opts, req, res, decodeURIComponent(metaMatch[1] ?? ''));
      }
      if (pathname === '/centraid/_automations' && method === 'POST') {
        return await handleAutomationCreate(opts, req, res);
      }
      if (pathname === '/centraid/_automations/set-enabled' && method === 'POST') {
        return await handleAutomationSetEnabled(opts, req, res, url);
      }
      if (pathname === '/centraid/_automations' && method === 'DELETE') {
        return await handleAutomationDelete(opts, req, res, url);
      }
      return false;
    } catch (err) {
      return sendLifecycleError(res, err);
    }
  };
}

// ---- POST /centraid/_apps (scaffold a blank app) ----

async function handleCreate(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readJson(req);
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return sendJson(res, 400, { error: 'bad_request', message: 'create needs { id }' });
  const name = typeof body.name === 'string' ? body.name : undefined;
  const version = typeof body.version === 'string' ? body.version : undefined;
  const publish = body.publish === true;
  const explicitSession =
    typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : '';
  const sessionId = explicitSession || defaultSessionId(id);
  const ephemeralSession = !explicitSession;

  // Reject a collision with an app already on `main` — a create must never
  // clobber an existing app's draft (the FS scaffolder guarded this with a
  // dir-exists check; the git-store path checks the list).
  const existing = await opts.store.listAppsWithMeta();
  if (existing.some((a) => a.id === id)) {
    throw new AppScaffoldError('already_exists', `App "${id}" already exists.`);
  }

  const files = scaffoldAppFiles(id, {
    ...(name !== undefined ? { name } : {}),
    ...(version !== undefined ? { version } : {}),
  });
  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  await stageAndMaybePublish(opts, {
    appId: id,
    sessionId,
    files,
    publish,
    message: `scaffold ${id}`,
    ephemeralSession,
  });

  return sendJson(res, 201, {
    app: { id, ...(name !== undefined ? { name } : {}), kind: 'app' as const },
    sessionId,
    staged: !publish,
  });
}

// ---- POST /centraid/_apps/_clone (clone a bundled template) ----

async function handleClone(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readJson(req);
  const templateId = typeof body.templateId === 'string' ? body.templateId : '';
  if (!templateId) {
    return sendJson(res, 400, { error: 'bad_request', message: 'clone needs { templateId }' });
  }
  const publish = body.publish === true;

  const cacheOpt = opts.templatesCacheDir ? { cacheDir: opts.templatesCacheDir } : {};
  const templates = await resolveTemplates(cacheOpt);
  const tmpl = templates.find((t) => t.id === templateId);
  if (!tmpl) throw new AppScaffoldError('not_found', `Unknown template "${templateId}".`);

  // Pick a unique (id, name) pair against the apps already on `main`, then
  // rewrite the template's files in memory for the new identity.
  const existing = await opts.store.listAppsWithMeta();
  const { id: newAppId, name: newName } = suggestCloneIdentityFrom(existing, tmpl.id, tmpl.name);
  const templateFiles = await readTemplateFiles(tmpl, cacheOpt);
  const cloned = cloneTemplateFiles({
    newAppId,
    templateFiles,
    newName,
    newDesc: tmpl.desc,
  });

  // Mint any pending webhook triggers (automation templates ship
  // `{kind:'webhook',pending:true}`). The plaintext secret is returned
  // once; the manifest persists only the hash.
  const { files: provisioned, minted } = provisionPendingWebhooksInFiles(cloned, newAppId);
  const webhooks = minted.map((m) => ({
    automationId: m.automationId,
    ownerApp: m.ownerApp,
    webhookId: m.webhookId,
    secret: m.secret,
    url: webhookUrl(req, m.webhookId),
  }));

  const explicitSession =
    typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : '';
  const sessionId = explicitSession || defaultSessionId(newAppId);
  const ephemeralSession = !explicitSession;
  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  await stageAndMaybePublish(opts, {
    appId: newAppId,
    sessionId,
    files: provisioned,
    publish,
    message: `clone ${tmpl.id}`,
    ephemeralSession,
  });

  return sendJson(res, 201, {
    app: {
      id: newAppId,
      name: newName,
      ...(tmpl.desc !== undefined ? { description: tmpl.desc } : {}),
      kind: tmpl.kind ?? 'app',
    },
    template: {
      id: tmpl.id,
      name: tmpl.name,
      desc: tmpl.desc,
      colorKey: tmpl.colorKey,
      iconKey: tmpl.iconKey,
      version: tmpl.version,
      kind: tmpl.kind ?? 'app',
    },
    webhooks,
    sessionId,
    staged: !publish,
  });
}

// ---- POST /centraid/_apps/<id>/meta (edit name/description) ----

async function handleMeta(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
  appId: string,
): Promise<boolean> {
  if (!appId) return sendJson(res, 400, { error: 'bad_request', message: 'meta needs an app id' });
  const body = await readJson(req);
  const name = typeof body.name === 'string' ? body.name : undefined;
  const description = typeof body.description === 'string' ? body.description : undefined;
  const publish = body.publish === true;
  const explicitSession =
    typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : '';
  const sessionId = explicitSession || defaultSessionId(appId);
  const ephemeralSession = !explicitSession;

  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  const appDir = await opts.store.snapshotSessionAppDir(sessionId, appId);
  const [current, existing] = await Promise.all([
    readFileMap(appDir),
    opts.store.listAppsWithMeta(),
  ]);
  const changed = updateAppMetaFiles(
    current as ScaffoldFile[],
    appId,
    {
      ...(name !== undefined ? { name } : {}),
      ...(description !== undefined ? { description } : {}),
    },
    existing,
  );
  if (changed.length > 0) {
    await stageAndMaybePublish(opts, {
      appId,
      sessionId,
      files: changed,
      publish,
      message: `update meta ${appId}`,
      ephemeralSession,
    });
  } else if (ephemeralSession) {
    // No metadata change to publish, but we may have opened a fresh
    // throwaway session above — close it so it doesn't orphan a worktree.
    await opts.store.closeSession(sessionId);
  }
  return sendJson(res, 200, { ok: true, staged: !publish });
}
