/*
 * Renderer-side app *editing* + *lifecycle* over direct HTTP (issue #141,
 * Phase 2). Split out of `gateway-client.ts` (repo file-size limit); the
 * barrel re-exports these so call sites still `import … from
 * './gateway-client.js'`.
 *
 * The draft-editing surface (sessions / files / publish) and the
 * deterministic lifecycle (create / clone / meta / automation CRUD) the
 * gateway now owns. The renderer states intent; the gateway scaffolds,
 * mints webhooks, stages into a session worktree, and publishes. We pass
 * `publish: true` to preserve "new app is live immediately" until the
 * preview iframe points at the draft URL.
 */

import {
  GatewayClientError,
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from './gateway-client-core.js';

// One open editing session per app id, opened lazily and reused across
// reads / writes / lifecycle mutations / publish. The id scheme matches
// the main process's `project-sessions.ts` (`desktop-<appId>`) ON PURPOSE:
// the local-only builder agent edits the same `desktop-<appId>` worktree,
// so the renderer and the agent share one draft. Whoever opens the session
// first wins; the other reuses it (a re-open of the same id 409s, which we
// treat as success).
const appSessions = new Map<string, Promise<string>>();

function sessionIdFor(appId: string): string {
  return `desktop-${appId}`;
}

/** Drop the cached session ids (without closing) — e.g. on gateway swap. */
export function resetAppSessions(): void {
  appSessions.clear();
}

// The cached sessions belong to the old gateway after a switch.
window.CentraidApi.onGatewayChanged(() => resetAppSessions());

/** Open the app's editing session (idempotent), returning its id. */
async function openAppSession(sessionId: string): Promise<string> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/_sessions`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ sessionId }),
  });
  const out = await readJson<{ sessionId: string }>(res, 'open session');
  return out.sessionId;
}

/**
 * Get the open session id for an app, opening one if needed. Concurrent
 * callers share the in-flight open; a 409 (the main-side agent already
 * opened this id) is treated as success — the worktree exists, which is
 * all we need. A rejected cached open is evicted so the next call retries.
 */
export async function ensureAppSession(appId: string): Promise<string> {
  const existing = appSessions.get(appId);
  if (existing) {
    try {
      return await existing;
    } catch {
      appSessions.delete(appId);
    }
  }
  const wanted = sessionIdFor(appId);
  const p = openAppSession(wanted).catch((err: unknown) => {
    if (err instanceof GatewayClientError && err.code === 'conflict') return wanted;
    throw err;
  });
  appSessions.set(appId, p);
  return p;
}

/** Close + forget an app's session (e.g. on delete). Idempotent. */
export async function dropAppSession(appId: string): Promise<void> {
  const existing = appSessions.get(appId);
  appSessions.delete(appId);
  let sessionId = sessionIdFor(appId);
  if (existing) {
    try {
      sessionId = await existing;
    } catch {
      return; // never opened; nothing to close
    }
  }
  const { baseUrl, token } = await auth();
  await doFetch(baseUrl, `/centraid/_apps/_sessions/${enc(sessionId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  }).catch(() => undefined);
}

/** Read the app's draft files from its editing session. */
export async function readProjectFiles(input: {
  id: string;
}): Promise<{ path: string; content: string }[]> {
  const sessionId = await ensureAppSession(input.id);
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_apps/${enc(input.id)}/files?sessionId=${enc(sessionId)}`,
    { method: 'GET', headers: authHeaders(token) },
  );
  const out = await readJson<{ files: { path: string; content: string }[] }>(res, 'read files');
  return out.files ?? [];
}

/** Overwrite a single text file in the app's draft session. */
export async function writeProjectFile(input: {
  id: string;
  path: string;
  content: string;
}): Promise<{ path: string; size: number }> {
  const sessionId = await ensureAppSession(input.id);
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_apps/${enc(input.id)}/files/${enc(input.path)}?sessionId=${enc(sessionId)}`,
    {
      method: 'PUT',
      headers: authHeaders(token, 'text/plain; charset=utf-8'),
      body: input.content,
    },
  );
  return readJson<{ path: string; size: number }>(res, 'write file');
}

/** Explicit Publish: validate + merge the draft session onto `main`. */
export async function publish(input: { id: string; skipBuild?: boolean }): Promise<{
  id: string;
  versionId: string;
  sha256: string;
  activated: boolean;
  files: number;
  bytes: number;
  migrationsApplied: number[];
}> {
  void input.skipBuild;
  const sessionId = await ensureAppSession(input.id);
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}/publish`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ sessionId, message: `publish ${input.id}` }),
  });
  const out = await readJson<{ id: string; versionTag: string; sha: string }>(res, 'publish');
  // Shape into the renderer's CentraidPublishResult: the git backend ships
  // no per-version files/bytes aggregates, and publish == merge into main.
  return {
    id: out.id,
    versionId: out.versionTag,
    sha256: out.sha,
    activated: true,
    files: 0,
    bytes: 0,
    migrationsApplied: [],
  };
}

// ───────────────────────── lifecycle ─────────────────────

/** Scaffold a fresh app (staged + published for immediate preview). */
export async function createProject(input: {
  id: string;
  name?: string;
  version?: string;
}): Promise<{ id: string; name?: string; kind?: 'app' | 'automation' }> {
  const sessionId = await ensureAppSession(input.id);
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ ...input, sessionId, publish: true }),
  });
  const out = await readJson<{
    project: { id: string; name?: string; kind?: 'app' | 'automation' };
  }>(res, 'create project');
  return out.project;
}

/** Template display metadata echoed back by the clone endpoint. */
interface ClonedTemplateMeta {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
  kind: 'app' | 'automation';
}

/** Clone a bundled template into a fresh app; mints any webhook secrets. */
export async function cloneTemplate(input: { templateId: string }): Promise<{
  project: { id: string; name?: string; description?: string; kind?: 'app' | 'automation' };
  template: ClonedTemplateMeta;
  webhooks: CentraidMintedWebhook[];
}> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/_clone`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ templateId: input.templateId, publish: true }),
  });
  const out = await readJson<{
    project: { id: string; name?: string; description?: string; kind?: 'app' | 'automation' };
    template: ClonedTemplateMeta;
    webhooks?: CentraidMintedWebhook[];
  }>(res, 'clone template');
  return { project: out.project, template: out.template, webhooks: out.webhooks ?? [] };
}

/** Patch the app's `app.json` name/description in its draft, then publish. */
export async function updateProjectMeta(input: {
  id: string;
  name?: string;
  description?: string;
}): Promise<{ ok: true }> {
  const sessionId = await ensureAppSession(input.id);
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}/meta`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      sessionId,
      publish: true,
    }),
  });
  await readJson(res, 'update meta');
  return { ok: true };
}

/** Delete an app from `main` and close its editing session. */
export async function deleteProject(input: { id: string }): Promise<{ ok: true }> {
  await dropAppSession(input.id);
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  await readJson(res, 'delete project').catch(() => undefined);
  return { ok: true };
}

/** Scaffold a new automation app; mints a webhook secret when requested. */
export async function createAutomation(input: {
  id: string;
  name?: string;
  description?: string;
  prompt?: string;
  triggers?: Array<{ kind: 'cron'; expr: string } | { kind: 'webhook' }>;
  apps?: string[];
  model?: string;
  historyKeep?: { count: number } | { days: number } | 'all' | 'errors';
  onFailure?: string;
  enabled?: boolean;
}): Promise<{
  row: CentraidAutomationRow | null;
  webhook?: { id: string; secret: string; url: string };
}> {
  const sessionId = await ensureAppSession(input.id);
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_automations`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ ...input, sessionId, publish: true }),
  });
  const out = await readJson<{
    row: CentraidAutomationRow | null;
    webhook?: { id: string; secret: string; url: string };
  }>(res, 'create automation');
  return { row: out.row ?? null, ...(out.webhook ? { webhook: out.webhook } : {}) };
}

/** Toggle an automation's `enabled` flag in its draft, then publish. */
export async function setAutomationEnabled(input: {
  automationId: string;
  enabled: boolean;
}): Promise<{ ok: true }> {
  const appId = input.automationId.split('/')[0] ?? '';
  const sessionId = await ensureAppSession(appId);
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations/set-enabled?ref=${enc(input.automationId)}`,
    {
      method: 'POST',
      headers: authHeaders(token, 'application/json'),
      body: JSON.stringify({ enabled: input.enabled, sessionId, publish: true }),
    },
  );
  await readJson(res, 'set automation enabled');
  return { ok: true };
}

/** Remove an automation (whole app or in-app subdir), then publish. */
export async function deleteAutomation(input: { automationId: string }): Promise<{ ok: true }> {
  const appId = input.automationId.split('/')[0] ?? '';
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_automations?ref=${enc(input.automationId)}&publish=true`,
    { method: 'DELETE', headers: authHeaders(token) },
  );
  const out = await readJson<{ deletedApp?: boolean }>(res, 'delete automation').catch(
    () => ({}) as { deletedApp?: boolean },
  );
  // A whole-automation-app delete drops the app; forget its session too.
  if (out.deletedApp) await dropAppSession(appId);
  return { ok: true };
}
