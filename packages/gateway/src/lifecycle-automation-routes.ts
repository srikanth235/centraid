// Automation lifecycle handlers for the gateway-owned builder (issue
// #141, Phase 2): scaffold an automation app, toggle its `enabled` flag,
// and delete it. Split out of `lifecycle-routes.ts` (file-size limit);
// dispatched from `makeLifecycleRouteHandler` there. Webhook secrets are
// minted here — the plaintext is returned once, only the hash persists.

import { promises as fs } from 'node:fs';
import nodePath from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppScaffoldError, type ScaffoldFile } from '@centraid/app-engine';
import {
  generateWebhookId,
  generateWebhookSecret,
  hashWebhookSecret,
  listAutomations,
  parseAutomationRef,
  type AutomationTrigger,
  deleteAutomationFromFiles,
  scaffoldAutomationAppFiles,
  setAutomationEnabledInFiles,
} from '@centraid/automation';
import { readFileMap, readJson, sendJson } from './route-helpers.js';
import {
  defaultSessionId,
  deleteAppAndReconcile,
  prepareLifecycleSession,
  parseHistoryKeep,
  publishAndReconcile,
  stageAndMaybePublish,
  webhookUrl,
  type LifecycleRouteOptions,
} from './lifecycle-shared.js';

// ---- POST /centraid/_automations (scaffold an automation app) ----

export async function handleAutomationCreate(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readJson(req);
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return sendJson(res, 400, { error: 'bad_request', message: 'create needs { id }' });
  const publish = body.publish === true;
  const explicitSession =
    typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : '';
  const sessionId = explicitSession || defaultSessionId(id);
  const ephemeralSession = !explicitSession;

  const existing = await opts.store.listAppsWithMeta();
  if (existing.some((a) => a.id === id)) {
    throw new AppScaffoldError('already_exists', `Automation app "${id}" already exists.`);
  }

  // Mint webhook secrets gateway-side: plaintext returned once, manifest
  // persists only the hash. A `webhook` trigger entry carries no secret in.
  let webhook: { id: string; secret: string; url: string } | undefined;
  const triggerInput = Array.isArray(body.triggers)
    ? (body.triggers as Array<{ kind?: string; expr?: string }>)
    : undefined;
  const triggers: AutomationTrigger[] | undefined = triggerInput?.map((t) => {
    if (t.kind === 'webhook') {
      const wid = generateWebhookId();
      const secret = generateWebhookSecret();
      webhook = { id: wid, secret, url: webhookUrl(req, wid) };
      return { kind: 'webhook', id: wid, secretHash: hashWebhookSecret(secret) };
    }
    return { kind: 'cron', expr: typeof t.expr === 'string' ? t.expr : '0 9 * * *' };
  });

  const files = scaffoldAutomationAppFiles(id, {
    ...(typeof body.name === 'string' && body.name ? { name: body.name } : {}),
    ...(typeof body.description === 'string' && body.description
      ? { description: body.description }
      : {}),
    ...(typeof body.prompt === 'string' && body.prompt ? { prompt: body.prompt } : {}),
    ...(triggers !== undefined ? { triggers } : {}),
    ...(Array.isArray(body.apps) ? { apps: body.apps.filter((a) => typeof a === 'string') } : {}),
    ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
    ...(parseHistoryKeep(body.historyKeep) !== undefined
      ? { historyKeep: parseHistoryKeep(body.historyKeep) }
      : {}),
    ...(typeof body.onFailure === 'string' && body.onFailure ? { onFailure: body.onFailure } : {}),
    ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
  });
  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  await stageAndMaybePublish(opts, {
    appId: id,
    sessionId,
    files,
    publish,
    message: `scaffold automation ${id}`,
    ephemeralSession,
  });

  // Read the published row back for the renderer (only on `main`).
  let row: unknown = null;
  if (publish) {
    const { rows } = await listAutomations(opts.codeAppsDir());
    row = rows.find((r) => r.ownerApp === id) ?? null;
  }
  return sendJson(res, 201, { row, sessionId, staged: !publish, ...(webhook ? { webhook } : {}) });
}

// ---- POST /centraid/_automations/set-enabled?ref= (toggle enabled) ----

export async function handleAutomationSetEnabled(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const ref = parseAutomationRef(url.searchParams.get('ref') ?? '');
  if (!ref) return sendJson(res, 400, { error: 'bad_request', message: 'set-enabled needs ?ref=' });
  const body = await readJson(req);
  if (typeof body.enabled !== 'boolean') {
    return sendJson(res, 400, { error: 'bad_request', message: 'set-enabled needs { enabled }' });
  }
  const publish = body.publish === true;
  const explicitSession =
    typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : '';
  const sessionId = explicitSession || defaultSessionId(ref.appId);
  const ephemeralSession = !explicitSession;

  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  const appDir = await opts.store.snapshotSessionAppDir(sessionId, ref.appId);
  const current = await readFileMap(appDir);
  const changed = setAutomationEnabledInFiles(
    current as ScaffoldFile[],
    ref.automationId,
    body.enabled,
  );
  if (changed.length > 0) {
    await stageAndMaybePublish(opts, {
      appId: ref.appId,
      sessionId,
      files: changed,
      publish,
      message: `toggle ${ref.automationId}`,
      ephemeralSession,
    });
  } else if (ephemeralSession) {
    // Nothing to publish, but a throwaway session may have been opened —
    // close it so it doesn't orphan a worktree.
    await opts.store.closeSession(sessionId);
  }
  return sendJson(res, 200, { ok: true, staged: !publish });
}

// ---- DELETE /centraid/_automations?ref=&publish= (remove an automation) ----

export async function handleAutomationDelete(
  opts: LifecycleRouteOptions,
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const ref = parseAutomationRef(url.searchParams.get('ref') ?? '');
  if (!ref) return sendJson(res, 400, { error: 'bad_request', message: 'delete needs ?ref=' });
  const publish = url.searchParams.get('publish') === 'true';

  // A whole automation app (`kind: 'automation'`) is removed wholesale;
  // an app-owned automation loses just its `automations/<id>/` subdir.
  const apps = await opts.store.listAppsWithMeta().catch(() => []);
  const appKind = apps.find((a) => a.id === ref.appId)?.kind;

  if (appKind === 'automation') {
    // Drop the code from `main`, deregister (removing the data dir + run
    // ledgers — NOT a stray `ensureRegistered`, which would re-create them),
    // and reconcile the scheduler. The sequence lives in lifecycle-shared.
    await deleteAppAndReconcile(opts, ref.appId);
    return sendJson(res, 200, { ok: true, deletedApp: true });
  }

  // A subdir delete is a one-shot off `main` — use a fresh throwaway session
  // (no renderer editing session is supplied here) and close it once done so
  // it doesn't orphan a worktree.
  const sessionId = defaultSessionId(ref.appId);
  await prepareLifecycleSession(opts.store, sessionId, true);
  const appDir = await opts.store.snapshotSessionAppDir(sessionId, ref.appId);
  const current = await readFileMap(appDir);
  const { removed } = deleteAutomationFromFiles(current as ScaffoldFile[], ref.automationId);
  if (removed.length === 0) {
    await opts.store.closeSession(sessionId);
    return sendJson(res, 200, { ok: true, staged: !publish });
  }

  // The surviving files already live in the worktree; just drop the
  // removed `automations/<id>/` subdir, then optionally publish so `main`
  // no longer lists it. The publish→reconcile→close sequence lives in
  // lifecycle-shared so this route doesn't hand-orchestrate it.
  await Promise.all(removed.map((rel) => fs.rm(nodePath.resolve(appDir, rel), { force: true })));
  if (publish) {
    await publishAndReconcile(opts, {
      appId: ref.appId,
      sessionId,
      appDir,
      message: `delete automation ${ref.automationId}`,
      ephemeralSession: true,
    });
  } else {
    await opts.ensureRegistered(ref.appId);
  }
  return sendJson(res, 200, { ok: true, staged: !publish });
}
