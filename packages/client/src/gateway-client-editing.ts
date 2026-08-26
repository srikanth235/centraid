/*
 * Renderer-side app session + lifecycle over HTTP (#141); `gateway-client.ts`
 * re-exports these. Install vs clone turns on where the code comes from (#434):
 * a bundled app installs (consent recorded, served from the shipped release, no
 * copy and no git), while generated code clones with `publish: true`.
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

// `desktop-<appId>` matches the main process's `app-sessions.ts` ON PURPOSE:
// the builder harness edits the same worktree, so a re-open 409s and that
// counts as success.
const appSessions = new Map<string, Promise<string>>();

function sessionIdFor(appId: string): string {
  return `desktop-${appId}`;
}

export function resetAppSessions(): void {
  appSessions.clear();
}

window.CentraidApi.onGatewayChanged(() => resetAppSessions());

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

interface ClonedTemplateMeta {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
  kind: "app" | "automation";
}

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

export async function installTemplate(input: {
  templateId: string;
  /** Omitted falls back to the internal default — the only spelling (#708). */
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

/** NO editing session (#434): the meta route short-circuits bundled ids to a
 *  label override, and `updateAppMeta` would leave an empty worktree behind. */
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

export async function deleteApp(input: { id: string }): Promise<{ ok: true }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  await readJson(res, "delete app");
  await dropAppSession(input.id);
  return { ok: true };
}
