// governance: allow-repo-hygiene file-size-limit (#387) one cohesive lifecycle handler family (create/update/set-enabled/rotate/delete) sharing the same session+stage+publish plumbing; splitting duplicates the shared helpers
// Automation lifecycle handlers for the gateway-owned builder (issue
// #141, Phase 2): scaffold an automation app, toggle its `enabled` flag,
// and delete it. Split out of `lifecycle-routes.ts` (file-size limit);
// dispatched from `makeLifecycleRouteHandler` there. Webhook secrets are
// minted here — the plaintext is returned once, only the hash persists.

import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import nodePath from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { AppScaffoldError, listTemplates, type ScaffoldFile } from '@centraid/blueprints';
import * as automation from '@centraid/automation';
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
} from '../lifecycle/lifecycle-shared.js';

// ---- POST /centraid/_automations/compile?ref= (hidden builder compile) ----

export async function handleAutomationCompile(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const rawRef = url.searchParams.get('ref') ?? '';
  const ref = automation.parseRef(rawRef);
  if (!ref) return sendJson(res, 400, { error: 'bad_request', message: 'compile needs ?ref=' });
  if (!opts.compileAutomation) {
    return sendJson(res, 503, { error: 'unavailable', message: 'compile runner unavailable' });
  }
  const body = await readJson(req);
  const row = await automation
    .readAppOwned(opts.codeAppsDir(), ref.appId, ref.automationId)
    .catch(() => undefined);
  if (!row) {
    return sendJson(res, 404, {
      error: 'not_found',
      message: `Automation "${rawRef}" does not exist.`,
    });
  }
  const runId = `${rawRef}:compile:${crypto.randomUUID().slice(0, 8)}`;
  opts.compileAutomation({
    automationRef: rawRef,
    runId,
    enableOnSuccess: body.enableOnSuccess === true,
  });
  return sendJson(res, 202, { runId });
}

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
  // `cron`/`webhook`/`condition`/`data` are the only trigger kinds the
  // manifest schema knows — anything else is rejected loudly instead of
  // being silently coerced. `condition`/`data` specs are passed through to
  // the real validator below (`validateManifest`, via `scaffoldAppFiles`)
  // rather than re-implemented here, so a malformed one (missing entity,
  // non-array `where`/`entities`, bad cron gate, …) 400s with the
  // validator's own field-scoped message.
  const ALLOWED_TRIGGER_KINDS = new Set(['cron', 'webhook', 'condition', 'data']);
  let webhook: { id: string; secret: string; url: string } | undefined;
  const triggerInput = Array.isArray(body.triggers)
    ? (body.triggers as Array<Record<string, unknown>>)
    : undefined;
  const badKind = triggerInput?.find(
    (t) => t.kind !== undefined && !ALLOWED_TRIGGER_KINDS.has(t.kind as string),
  );
  if (badKind) {
    return sendJson(res, 400, {
      error: 'bad_request',
      message: `Unsupported trigger kind "${String(badKind.kind)}" — create accepts cron, webhook, condition and data triggers.`,
    });
  }
  const triggers: automation.Trigger[] | undefined = triggerInput?.map((t) => {
    if (t.kind === 'webhook') {
      const wid = automation.generateWebhookId();
      const secret = automation.generateWebhookSecret();
      webhook = { id: wid, secret, url: webhookUrl(req, wid) };
      return { kind: 'webhook', id: wid, secretHash: automation.hashWebhookSecret(secret) };
    }
    if (t.kind === 'condition') {
      return {
        kind: 'condition',
        entity: t.entity,
        ...(t.where !== undefined ? { where: t.where } : {}),
        ...(t.every !== undefined ? { every: t.every } : {}),
      } as automation.Trigger;
    }
    if (t.kind === 'data') {
      return {
        kind: 'data',
        entities: t.entities,
        ...(t.every !== undefined ? { every: t.every } : {}),
      } as automation.Trigger;
    }
    return { kind: 'cron', expr: typeof t.expr === 'string' ? t.expr : '0 9 * * *' };
  });
  // A condition/data trigger's consented read runs under a requested vault
  // grant (duaility §12) — `validateManifest` refuses those trigger kinds
  // without one, so pass an explicit `{ vault }` body through untouched and
  // let the same validator reject a malformed one.
  const vaultInput =
    body.vault !== null && typeof body.vault === 'object' && !Array.isArray(body.vault)
      ? (body.vault as automation.ManifestVault)
      : undefined;
  const connectorInput =
    body.connector !== null && typeof body.connector === 'object' && !Array.isArray(body.connector)
      ? (body.connector as automation.ConnectorSpec)
      : undefined;
  const connectionsInput = Array.isArray(body.connections)
    ? (body.connections as automation.ConnectionBinding[])
    : undefined;

  const files = automation.scaffoldAppFiles(id, {
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
    ...(vaultInput !== undefined ? { vault: vaultInput } : {}),
    ...(connectorInput !== undefined ? { connector: connectorInput } : {}),
    ...(connectionsInput !== undefined ? { connections: connectionsInput } : {}),
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
    const { rows } = await automation.list(opts.codeAppsDir());
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
  const ref = automation.parseRef(url.searchParams.get('ref') ?? '');
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
  const changed = automation.setEnabledInFiles(
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

// ---- POST /centraid/_automations/update?ref= (edit name/prompt/triggers) ----

/**
 * The instructions-first editor's save path: patch an automation's
 * `name` / `prompt` (manifest `prompt` — the human intent) / `triggers`
 * without going through the builder chat. Every field is optional and only
 * a present one is applied — this is `PATCH` semantics over `POST`, mirroring
 * `set-enabled`'s "load current manifest → apply → re-validate → stage +
 * publish" shape rather than re-scaffolding.
 *
 * Triggers follow create's wire shape (`CentraidCreateTrigger[]`), with one
 * v1 refinement: a `{kind:'webhook'}` entry mints a fresh id + secret ONLY
 * when the automation had no webhook trigger before — an edit that keeps an
 * existing webhook must not silently rotate its secret out from under
 * configured callers (that is `rotate-webhook`'s dedicated job). A `triggers`
 * array that omits `webhook` drops it. Renamed automations pick up their new
 * display name on the enrolled agent automatically: `publishAndReconcile`'s
 * `reconcile()` re-derives `nameByOwnerApp` from the just-published manifest
 * and re-enrolls (`ensureAgentEnrolled`'s `displayName`-driven upsert) —
 * exactly the mechanism `set-enabled`/create already ride, no special-casing
 * needed here.
 */
export async function handleAutomationUpdate(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const rawRef = url.searchParams.get('ref') ?? '';
  const ref = automation.parseRef(rawRef);
  if (!ref) return sendJson(res, 400, { error: 'bad_request', message: 'update needs ?ref=' });
  const body = await readJson(req);

  const nameInput = typeof body.name === 'string' ? body.name : undefined;
  const promptInput = typeof body.prompt === 'string' ? body.prompt : undefined;
  const triggersInput = Array.isArray(body.triggers)
    ? (body.triggers as Array<Record<string, unknown>>)
    : undefined;
  const vaultInput =
    body.vault !== null && typeof body.vault === 'object' && !Array.isArray(body.vault)
      ? (body.vault as automation.ManifestVault)
      : undefined;
  const hasConnectorKey = Object.hasOwn(body, 'connector');
  const connectorInput = hasConnectorKey
    ? body.connector === null
      ? null
      : body.connector !== null &&
          typeof body.connector === 'object' &&
          !Array.isArray(body.connector)
        ? (body.connector as automation.ConnectorSpec)
        : undefined
    : undefined;
  const hasConnectionsKey = Object.hasOwn(body, 'connections');
  const connectionsInput = hasConnectionsKey
    ? Array.isArray(body.connections)
      ? (body.connections as automation.ConnectionBinding[])
      : undefined
    : undefined;
  if (
    nameInput === undefined &&
    promptInput === undefined &&
    triggersInput === undefined &&
    vaultInput === undefined &&
    !hasConnectorKey &&
    !hasConnectionsKey
  ) {
    return sendJson(res, 400, {
      error: 'bad_request',
      message: 'update needs at least one of { name, prompt, triggers, connections, connector }',
    });
  }

  const publish = body.publish === true;
  const explicitSession =
    typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : '';
  const sessionId = explicitSession || defaultSessionId(ref.appId);
  const ephemeralSession = !explicitSession;

  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  const appDir = await opts.store.snapshotSessionAppDir(sessionId, ref.appId);
  const current = await readFileMap(appDir);

  const targetPath = `automations/${ref.automationId}/${automation.MANIFEST_FILE}`;
  const file = current.find((f) => f.path === targetPath);
  if (!file) {
    if (ephemeralSession) await opts.store.closeSession(sessionId);
    return sendJson(res, 404, {
      error: 'not_found',
      message: `Automation "${rawRef}" does not exist.`,
    });
  }

  // A corrupt-on-disk manifest surfaces the same 400 an invalid patch would
  // (via `sendLifecycleError`'s `ManifestError` mapping) rather than a 500 —
  // the route's own try/catch (in `makeLifecycleRouteHandler`) covers this.
  const existing = automation.parseManifest(file.content);

  // Same closed trigger-kind vocabulary + validator delegation as create
  // (see the comment above `ALLOWED_TRIGGER_KINDS` there): reject an unknown
  // kind loudly instead of coercing it, let `validateManifest` below reject a
  // malformed condition/data spec with its own field-scoped message.
  const ALLOWED_TRIGGER_KINDS = new Set(['cron', 'webhook', 'condition', 'data']);
  let webhook: { id: string; secret: string; url: string } | undefined;
  let triggers: automation.Trigger[] | undefined;
  if (triggersInput) {
    const badKind = triggersInput.find(
      (t) => t.kind !== undefined && !ALLOWED_TRIGGER_KINDS.has(t.kind as string),
    );
    if (badKind) {
      if (ephemeralSession) await opts.store.closeSession(sessionId);
      return sendJson(res, 400, {
        error: 'bad_request',
        message: `Unsupported trigger kind "${String(badKind.kind)}" — update accepts cron, webhook, condition and data triggers.`,
      });
    }
    const existingWebhook = automation.webhookTriggerOf(existing.triggers);
    triggers = triggersInput.map((t) => {
      if (t.kind === 'webhook') {
        // Wire shape carries no id/secretHash (those are gateway-minted) —
        // the only way to tell "keep the existing one" from "mint a new
        // one" is whether the automation already had a provisioned webhook.
        if (existingWebhook) return existingWebhook;
        const wid = automation.generateWebhookId();
        const secret = automation.generateWebhookSecret();
        webhook = { id: wid, secret, url: webhookUrl(req, wid) };
        return { kind: 'webhook', id: wid, secretHash: automation.hashWebhookSecret(secret) };
      }
      if (t.kind === 'condition') {
        return {
          kind: 'condition',
          entity: t.entity,
          ...(t.where !== undefined ? { where: t.where } : {}),
          ...(t.every !== undefined ? { every: t.every } : {}),
        } as automation.Trigger;
      }
      if (t.kind === 'data') {
        return {
          kind: 'data',
          entities: t.entities,
          ...(t.every !== undefined ? { every: t.every } : {}),
        } as automation.Trigger;
      }
      return { kind: 'cron', expr: typeof t.expr === 'string' ? t.expr : '0 9 * * *' };
    });
  }

  // Round-trip through the real validator so a patched manifest can never
  // land a shape the runtime would later reject — untouched fields (incl.
  // `generated`, `enabled`, `history`) survive via the spread.
  const patched: Record<string, unknown> = {
    ...existing,
    ...(nameInput !== undefined ? { name: nameInput } : {}),
    ...(promptInput !== undefined ? { prompt: promptInput } : {}),
    ...(triggers !== undefined ? { triggers } : {}),
    ...(vaultInput !== undefined ? { vault: vaultInput } : {}),
  };
  if (hasConnectionsKey) {
    if (connectionsInput === undefined) {
      return sendJson(res, 400, {
        error: 'bad_request',
        message: 'connections must be an array when provided',
      });
    }
    if (connectionsInput.length === 0) delete patched.connections;
    else patched.connections = connectionsInput;
  }
  if (hasConnectorKey) {
    if (connectorInput === null) delete patched.connector;
    else if (connectorInput !== undefined) patched.connector = connectorInput;
  }
  const manifest = automation.validateManifest(patched);
  const changedFile: ScaffoldFile = {
    path: targetPath,
    content: JSON.stringify(manifest, null, 2) + '\n',
  };

  await stageAndMaybePublish(opts, {
    appId: ref.appId,
    sessionId,
    files: [changedFile],
    publish,
    message: `update ${ref.automationId}`,
    ephemeralSession,
  });

  // Read the published row back for the renderer (only on `main`) — same
  // pattern as create.
  let row: unknown = null;
  if (publish) {
    const { rows } = await automation.list(opts.codeAppsDir());
    // Compare on the parsed handle, not the raw query string — `rawRef` is
    // whatever the caller typed and need not be byte-identical to the
    // canonical `<appId>/<automationId>` form `Row.ref` always is.
    const wantRef = `${ref.appId}/${ref.automationId}`;
    row = rows.find((r) => r.ref === wantRef) ?? null;
  }
  return sendJson(res, 200, { row, staged: !publish, ...(webhook ? { webhook } : {}) });
}

// ---- POST /centraid/_automations/rotate-webhook?ref= (mint a fresh secret) ----

/**
 * Rotate a webhook-triggered automation's shared secret. The plaintext is
 * shown to the owner exactly once, at mint time (create/clone) — miss that
 * one-time reveal and the automation is otherwise permanently uncallable,
 * since only the SHA-256 hash persists in `automation.json`. This mints a
 * fresh secret over the SAME route id (any caller already configured with
 * the webhook URL keeps working; only its credential changes) and persists
 * only the new hash, exactly like the mint path — the response shape
 * mirrors create's `webhook` field so the renderer's existing one-time
 * reveal UI works unchanged.
 */
export async function handleAutomationRotateWebhook(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const rawRef = url.searchParams.get('ref') ?? '';
  const ref = automation.parseRef(rawRef);
  if (!ref) {
    return sendJson(res, 400, { error: 'bad_request', message: 'rotate-webhook needs ?ref=' });
  }
  const body = await readJson(req);
  const publish = body.publish === true;
  const explicitSession =
    typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : '';
  const sessionId = explicitSession || defaultSessionId(ref.appId);
  const ephemeralSession = !explicitSession;

  await prepareLifecycleSession(opts.store, sessionId, ephemeralSession);
  const appDir = await opts.store.snapshotSessionAppDir(sessionId, ref.appId);
  const current = await readFileMap(appDir);

  const targetPath = `automations/${ref.automationId}/${automation.MANIFEST_FILE}`;
  if (!current.some((f) => f.path === targetPath)) {
    if (ephemeralSession) await opts.store.closeSession(sessionId);
    return sendJson(res, 404, {
      error: 'not_found',
      message: `Automation "${rawRef}" does not exist.`,
    });
  }

  const { changed, rotated } = automation.rotateWebhookInFiles(
    current as ScaffoldFile[],
    ref.automationId,
  );
  if (!rotated) {
    if (ephemeralSession) await opts.store.closeSession(sessionId);
    return sendJson(res, 400, {
      error: 'bad_request',
      message: `Automation "${rawRef}" has no webhook trigger to rotate.`,
    });
  }

  await stageAndMaybePublish(opts, {
    appId: ref.appId,
    sessionId,
    files: changed,
    publish,
    message: `rotate webhook secret for ${ref.automationId}`,
    ephemeralSession,
  });

  return sendJson(res, 200, {
    ok: true,
    staged: !publish,
    webhook: {
      id: rotated.webhookId,
      secret: rotated.secret,
      url: webhookUrl(req, rotated.webhookId),
    },
  });
}

// ---- POST /centraid/_automations/enrichment (batch toggle, issue #306) ----

/**
 * "Enable enrichment" is ONE owner decision (issue #306 decision 6): flip
 * every installed enricher automation in one act instead of nine separate
 * discoveries. Enrichers are identified by the blueprint catalog's
 * `category: "Enrichment"` template ids; the response reports what toggled
 * so a surface can render the checklist honestly.
 */
export async function handleEnrichmentToggle(
  opts: LifecycleRouteOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const body = await readJson(req);
  if (typeof body.enabled !== 'boolean') {
    return sendJson(res, 400, { error: 'bad_request', message: 'enrichment needs { enabled }' });
  }
  const enricherIds = new Set(
    (await listTemplates()).filter((t) => t.category === 'Enrichment').map((t) => t.id),
  );
  const { rows } = await automation.list(opts.codeAppsDir());
  const toggled: string[] = [];
  const unchanged: string[] = [];
  for (const row of rows) {
    if (!enricherIds.has(row.ownerApp)) continue;
    if (row.enabled === body.enabled) {
      unchanged.push(row.ref);
      continue;
    }
    const sessionId = defaultSessionId(row.ownerApp);
    await prepareLifecycleSession(opts.store, sessionId, true);
    const appDir = await opts.store.snapshotSessionAppDir(sessionId, row.ownerApp);
    const current = await readFileMap(appDir);
    const changed = automation.setEnabledInFiles(current as ScaffoldFile[], row.id, body.enabled);
    if (changed.length > 0) {
      await stageAndMaybePublish(opts, {
        appId: row.ownerApp,
        sessionId,
        files: changed,
        publish: true,
        message: `${body.enabled ? 'enable' : 'disable'} enrichment (${row.id})`,
        ephemeralSession: true,
      });
      toggled.push(row.ref);
    } else {
      await opts.store.closeSession(sessionId);
      unchanged.push(row.ref);
    }
  }
  return sendJson(res, 200, { ok: true, enabled: body.enabled, toggled, unchanged });
}

// ---- DELETE /centraid/_automations?ref=&publish= (remove an automation) ----

export async function handleAutomationDelete(
  opts: LifecycleRouteOptions,
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const ref = automation.parseRef(url.searchParams.get('ref') ?? '');
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
  const { removed } = automation.deleteFromFiles(current as ScaffoldFile[], ref.automationId);
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
