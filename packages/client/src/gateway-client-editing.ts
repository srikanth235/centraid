/*
 * Renderer-side app *session* + *lifecycle* over direct HTTP (issue #141,
 * Phase 2). Split out of `gateway-client.ts` (repo file-size limit); the
 * barrel re-exports these so call sites still `import … from
 * './gateway-client.js'`.
 *
 * What lives here (#799): the
 * `desktop-<id>` editing session (opened/closed lazily and shared with the
 * automation-authoring harness), and the deterministic lifecycle the gateway
 * owns — clone / install / meta / delete. Automation CRUD lives next door in
 * `gateway-client-automation-editing.ts` and is the remaining writer of the
 * code store. The app-file editing surface (draft files, publish, preview
 * URLs, scaffolding a blank app) went with the builder that drove it.
 *
 * Two lifecycles meet here, and the difference is *where the code comes
 * from* (#434). A bundled app `install`s: the gateway records consent and
 * serves it from the shipped release — nothing is copied, no git, and it
 * upgrades with the software. Generated code (automations) still `clone`s
 * with `publish: true` to land a *baseline* version on `main` (its "git
 * init"), because code that exists nowhere else has to live in the vault's
 * code store.
 */

import {
  GatewayClientError,
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
  scopedAuthHeaders,
} from "./gateway-client-core.js";

// One open editing session per app id, opened lazily and reused across
// reads / writes / lifecycle mutations / publish. The id scheme matches
// the main process's `app-sessions.ts` (`desktop-<appId>`) ON PURPOSE:
// the local-only builder harness edits the same `desktop-<appId>` worktree,
// so the renderer and the harness share one draft. Whoever opens the session
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
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ sessionId }),
  });
  const out = await readJson<{ sessionId: string }>(res, "open session");
  return out.sessionId;
}

/**
 * Get the open session id for an app, opening one if needed. Concurrent
 * callers share the in-flight open; a 409 (the main-side harness already
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
  const p = openAppSession(wanted).catch((error: unknown) => {
    if (error instanceof GatewayClientError && error.code === "conflict")
      return wanted;
    throw error;
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
    method: "DELETE",
    headers: authHeaders(token),
  }).catch(() => undefined);
}

// ───────────────────────── lifecycle ─────────────────────

/** Template display metadata echoed back by the clone endpoint. */
interface ClonedTemplateMeta {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
  kind: "app" | "automation";
}

/** Clone a bundled template into a fresh app; mints any webhook secrets. */
export async function cloneTemplate(input: { templateId: string }): Promise<{
  app: {
    id: string;
    name?: string;
    description?: string;
    kind?: "app" | "automation";
  };
  template: ClonedTemplateMeta;
  webhooks: CentraidMintedWebhook[];
}> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/_clone`, {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ templateId: input.templateId, publish: true }),
  });
  const out = await readJson<{
    app: {
      id: string;
      name?: string;
      description?: string;
      kind?: "app" | "automation";
    };
    template: ClonedTemplateMeta;
    webhooks?: CentraidMintedWebhook[];
  }>(res, "clone template");
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
export async function installTemplate(input: {
  templateId: string;
  /** The vault the app is installed into (issue #599). Omitted falls back to
   *  the internal default — the only spelling there is (#708); the remaining
   *  caller is the gateway's own "app follows the member into an audience
   *  vault" seam. */
  scopeId?: string;
}): Promise<{
  app: {
    id: string;
    name?: string;
    description?: string;
    iconKey?: string;
    colorKey?: string;
  };
  alreadyInstalled: boolean;
}> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/_install`, {
    method: "POST",
    headers: scopedAuthHeaders(token, input.scopeId, "application/json"),
    body: JSON.stringify({ templateId: input.templateId }),
  });
  const out = await readJson<{
    app: {
      id: string;
      name?: string;
      description?: string;
      iconKey?: string;
      colorKey?: string;
    };
    alreadyInstalled?: boolean;
  }>(res, "install template");
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
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({ name: input.name }),
  });
  await readJson(res, "rename installed app");
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
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      sessionId,
      publish: true,
    }),
  });
  await readJson(res, "update meta");
  return { ok: true };
}

/** Delete an app from `main`, then close its editing session. */
export async function deleteApp(input: { id: string }): Promise<{ ok: true }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  // Surface a gateway rejection (401/404/409/500) instead of reporting a
  // phantom success — and only drop the draft session once the delete is
  // confirmed, so a failed delete leaves the editing session intact.
  await readJson(res, "delete app");
  await dropAppSession(input.id);
  return { ok: true };
}
