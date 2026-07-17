/*
 * Renderer-side app *editing* + *lifecycle* over direct HTTP (issue #141,
 * Phase 2). Split out of `gateway-client.ts` (repo file-size limit); the
 * barrel re-exports these so call sites still `import … from
 * './gateway-client.js'`.
 *
 * The draft-editing surface (sessions / files / publish) and the
 * deterministic lifecycle (create / clone / install / meta) the gateway now
 * owns. The renderer states intent; the gateway scaffolds, stages into a
 * session worktree, and publishes. Automation CRUD lives next door in
 * `gateway-client-automation-editing.ts`.
 *
 * Two lifecycles meet here, and the difference is *where the code comes
 * from* (#434). A bundled app `install`s: the gateway records consent and
 * serves it from the shipped release — nothing is copied, no git, and it
 * upgrades with the software. Generated code (automations) and forks still
 * `create`/`clone` with `publish: true` to land a *baseline* version on
 * `main` (the app's "git init"), because code that exists nowhere else has
 * to live in the vault's code store. Those then stage chat- and file-driven
 * edits in the `desktop-<id>` draft worktree — the builder preview reads
 * that draft via `draftPreviewUrl` and an explicit Publish flips the next
 * version live. So "auto-publish" is the one-time baseline only, not
 * per-edit.
 */

import {
  GatewayClientError,
  appSessionUrl,
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from './gateway-client-core.js';

// One open editing session per app id, opened lazily and reused across
// reads / writes / lifecycle mutations / publish. The id scheme matches
// the main process's `app-sessions.ts` (`desktop-<appId>`) ON PURPOSE:
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

/**
 * Draft-preview URL for an app's editing session, served through the
 * gateway runtime (issue #141, Phase 4). The staged worktree is previewed
 * faithfully (static assets + handlers) under
 * `/centraid/_draft/<sessionId>/<appId>/` so the builder iframe reflects
 * chat/file edits *before* an explicit Publish flips them live — honoring
 * #137's "everything serves through the store, never a local path shortcut"
 * invariant. The iframe authenticates the same way the live-URL iframe
 * does: the main-process auth-injector stamps the Bearer header onto every
 * gateway-origin request (top navigation + subresources).
 *
 * Returns `available` so the builder can keep showing its "building"
 * skeleton until the draft actually has an index.html (fresh apps mid-
 * generation have an open session but no page yet → the draft index 404s).
 * The returned `url` carries a cache-buster so re-resolving after a save
 * forces the iframe to re-navigate.
 */
export async function draftPreviewUrl(appId: string): Promise<{ url: string; available: boolean }> {
  const sessionId = await ensureAppSession(appId);
  const { baseUrl, token } = await auth();
  const draftPath = `/centraid/_draft/${enc(sessionId)}/${enc(appId)}/`;
  let available = false;
  try {
    const res = await doFetch(baseUrl, draftPath, {
      method: 'GET',
      headers: authHeaders(token),
    });
    available = res.ok;
    await res.text().catch(() => undefined); // drain so the socket frees
  } catch {
    available = false;
  }
  // Stable path + per-resolve cache-buster (the iframe src must change to
  // re-navigate after a staged edit). `parseWithDraft` preserves the query
  // string and the inner app-index route ignores unknown params.
  const launchUrl = await appSessionUrl(appId, draftPath, sessionId);
  const url = `${launchUrl}${launchUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
  return { url, available };
}

/** Read the app's draft files from its editing session. */
export async function readAppFiles(input: {
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
export async function writeAppFile(input: {
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

/**
 * Reset the app's draft data from a fresh prod snapshot + replay its pending
 * migrations (issue #144). Backs the preview-pane "Reset data from prod"
 * control: a no-op once a draft copy exists is rebuilt from live, and a
 * migration incompatible with prod rows rejects with the SQL error (HTTP
 * 422) — surfacing the publish conflict in preview before publishing.
 */
export async function resetAppData(input: {
  id: string;
}): Promise<{ id: string; seeded: boolean; migrationsApplied: number[] }> {
  const sessionId = await ensureAppSession(input.id);
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}/reset-data`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ sessionId }),
  });
  return readJson<{ id: string; seeded: boolean; migrationsApplied: number[] }>(res, 'reset-data');
}

// ───────────────────────── lifecycle ─────────────────────

/** Scaffold a fresh app (staged + published for immediate preview). */
export async function createApp(input: {
  id: string;
  name?: string;
  version?: string;
  /** Tile identity stamped into the scaffold's `app.json` (issue #263);
   *  the gateway defaults to Sparkle/violet when omitted. */
  iconKey?: string;
  colorKey?: string;
}): Promise<{ id: string; name?: string; kind?: 'app' | 'automation' }> {
  const sessionId = await ensureAppSession(input.id);
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ ...input, sessionId, publish: true }),
  });
  const out = await readJson<{
    app: { id: string; name?: string; kind?: 'app' | 'automation' };
  }>(res, 'create app');
  return out.app;
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
  app: { id: string; name?: string; description?: string; kind?: 'app' | 'automation' };
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
    app: { id: string; name?: string; description?: string; kind?: 'app' | 'automation' };
    template: ClonedTemplateMeta;
    webhooks?: CentraidMintedWebhook[];
  }>(res, 'clone template');
  return { app: out.app, template: out.template, webhooks: out.webhooks ?? [] };
}

/**
 * Install a bundled blueprint app in place (issue #434): registration +
 * consent grants, no code copy, no git. Keeps the blueprint's own id.
 * Idempotent — installing an already-installed app returns its existing
 * registration (`alreadyInstalled: true`). Unlike {@link cloneTemplate}
 * (still used for automations, which fork into the code store), this app
 * serves straight from the shipped package and upgrades with every release.
 */
export async function installTemplate(input: { templateId: string }): Promise<{
  app: { id: string; name?: string; description?: string; iconKey?: string; colorKey?: string };
  alreadyInstalled: boolean;
}> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/_install`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ templateId: input.templateId }),
  });
  const out = await readJson<{
    app: { id: string; name?: string; description?: string; iconKey?: string; colorKey?: string };
    alreadyInstalled?: boolean;
  }>(res, 'install template');
  return { app: out.app, alreadyInstalled: out.alreadyInstalled ?? false };
}

/**
 * Rename an installed bundled app (issue #434) — sets its per-vault label
 * override in the registry, with NO editing session. The gateway's meta route
 * short-circuits bundled ids to the label override (their code is read-only,
 * so nothing is staged/published); routing this through {@link updateAppMeta}
 * would open a `desktop-<id>` session worktree that then sits empty. An empty
 * `name` clears the override, falling back to the manifest name.
 */
export async function renameInstalledApp(input: {
  id: string;
  name: string;
}): Promise<{ ok: true }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}/meta`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ name: input.name }),
  });
  await readJson(res, 'rename installed app');
  return { ok: true };
}

/** Patch the app's `app.json` name/description in its draft, then publish. */
export async function updateAppMeta(input: {
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

/** Delete an app from `main`, then close its editing session. */
export async function deleteApp(input: { id: string }): Promise<{ ok: true }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  // Surface a gateway rejection (401/404/409/500) instead of reporting a
  // phantom success — and only drop the draft session once the delete is
  // confirmed, so a failed delete leaves the editing session intact.
  await readJson(res, 'delete app');
  await dropAppSession(input.id);
  return { ok: true };
}
