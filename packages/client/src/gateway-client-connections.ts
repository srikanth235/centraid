import {
  ROUTES,
  vaultConnectionAuthorizePath,
  vaultConnectionPath,
} from "@centraid/core/protocol";

import {
  GatewayClientError,
  auth,
  authHeaders,
  doFetch,
  enc,
  nonJsonError,
  readJson,
  withClientSession,
} from "./gateway-client-core.js";

interface ConnectionWireRow {
  connection_id: string;
  kind: string;
  label: string;
  principal: string | null;
  status: "active" | "needs-auth" | "failing" | "paused";
  trust: "staged" | "auto-publish";
  created_at: string;
  last_run_at: string | null;
  cred_kind: "oauth2" | "api_key" | null;
  oauth_mode?: "byo" | "assist" | null;
  provider: string | null;
  scopes: string | null;
  allowed_hosts: string[] | null;
  token_expires_at: string | null;
  has_refresh_token: boolean;
  auth_note: string | null;
}

export interface ConnectionEntry {
  connectionId: string;
  kind: string;
  label: string;
  principal: string | null;
  status: "active" | "needs-auth" | "failing" | "paused";
  trust: "staged" | "auto-publish";
  createdAt: string;
  lastRunAt: string | null;
  credKind: "oauth2" | "api_key" | null;
  oauthMode: "byo" | "assist" | null;
  provider: string | null;
  scopes: string | null;
  allowedHosts: string[] | null;
  tokenExpiresAt: string | null;
  hasRefreshToken: boolean;
  authNote: string | null;
}

function fromWireRow(r: ConnectionWireRow): ConnectionEntry {
  return {
    allowedHosts: r.allowed_hosts,
    authNote: r.auth_note,
    connectionId: r.connection_id,
    createdAt: r.created_at,
    credKind: r.cred_kind,
    oauthMode: r.oauth_mode ?? (r.cred_kind === "oauth2" ? "byo" : null),
    hasRefreshToken: r.has_refresh_token,
    kind: r.kind,
    label: r.label,
    lastRunAt: r.last_run_at,
    principal: r.principal,
    provider: r.provider,
    scopes: r.scopes,
    status: r.status,
    tokenExpiresAt: r.token_expires_at,
    trust: r.trust,
  };
}

export async function listConnections(): Promise<ConnectionEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, ROUTES.vaultConnections, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{ connections: ConnectionWireRow[] }>(
    res,
    "list connections"
  );
  return (out.connections ?? []).map(fromWireRow);
}

export async function oauthCallbackUri(): Promise<string> {
  const { baseUrl } = await auth();
  return `${baseUrl.replace(/\/$/u, "")}${ROUTES.vaultOAuthCallback}`;
}

export interface ConnectionProviderConnector {
  templateId: string;
  kind: string;
  scope?: string;
}

export interface ConnectionProviderSyncCapability {
  id: string;
  title: string;
  templateId: string;
  kind: string;
  defaultCron: string;
  scope?: string;
}

export interface ConnectionProviderActionCapability {
  id: string;
  title: string;
  toolName: string;
  kind: string;
  templateId?: string;
  approval?: "outbox";
  scope?: string;
}

export interface ConnectionProviderCapabilities {
  syncs: ConnectionProviderSyncCapability[];
  actions: ConnectionProviderActionCapability[];
}

export interface ConnectionProviderPreset {
  id: string;
  name: string;
  credKind: "oauth2" | "api_key";
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string;
  allowedHosts: string[];
  setup: string[];
  connectors: ConnectionProviderConnector[];
  capabilities?: ConnectionProviderCapabilities;
}

export type AssistOAuthAvailability =
  | { enabled: false }
  | {
      enabled: true;
      provider: "google";
      callbackUrl: string;
      restrictedScopesEnabled: boolean;
      scopeTiers: {
        standard: string[];
        restricted: string[];
      };
    };

export interface ConnectionProviderCatalog {
  providers: ConnectionProviderPreset[];
  assist: AssistOAuthAvailability;
}

export async function loadConnectionProviderCatalog(): Promise<ConnectionProviderCatalog> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, ROUTES.vaultConnectionProviders, {
    method: "GET",
    headers: authHeaders(token),
  });
  const out = await readJson<{
    providers: ConnectionProviderPreset[];
    assist?: AssistOAuthAvailability;
  }>(res, "list providers");
  return {
    providers: out.providers ?? [],
    assist: out.assist ?? { enabled: false },
  };
}

export async function listConnectionProviders(): Promise<
  ConnectionProviderPreset[]
> {
  return (await loadConnectionProviderCatalog()).providers;
}

export interface ConfigureConnectionInput {
  kind: string;
  label: string;
  credKind: "oauth2" | "api_key" | "none";
  provider?: string;
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string;
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  allowedHosts?: string[];
}

export interface ConfigureAssistConnectionInput {
  kind: string;
  label: string;
  scopes: string[];
}

export async function configureAssistConnection(
  input: ConfigureAssistConnectionInput
): Promise<{ connectionId: string; credKind: string; status: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, ROUTES.vaultConnectionsAssist, {
    body: JSON.stringify(input),
    headers: authHeaders(token, "application/json"),
    method: "POST",
  });
  const out = await readJson<{
    ok: true;
    connection_id: string;
    cred_kind: string;
    status: string;
  }>(res, "configure Centraid Assist connection");
  return {
    connectionId: out.connection_id,
    credKind: out.cred_kind,
    status: out.status,
  };
}

export async function configureConnection(
  input: ConfigureConnectionInput
): Promise<{ connectionId: string; credKind: string; status: string }> {
  const { baseUrl, token } = await auth();
  const body: Record<string, unknown> = {
    cred_kind: input.credKind,
    kind: input.kind,
    label: input.label,
  };
  if (input.provider) body.provider = input.provider;
  if (input.authUrl) body.auth_url = input.authUrl;
  if (input.tokenUrl) body.token_url = input.tokenUrl;
  if (input.scopes) body.scopes = input.scopes;
  if (input.clientId) body.client_id = input.clientId;
  if (input.clientSecret) body.client_secret = input.clientSecret;
  if (input.apiKey) body.api_key = input.apiKey;
  if (input.allowedHosts) body.allowed_hosts = input.allowedHosts;
  const res = await doFetch(baseUrl, ROUTES.vaultConnections, {
    body: JSON.stringify(body),
    headers: authHeaders(token, "application/json"),
    method: "POST",
  });
  const out = await readJson<{
    ok: true;
    connection_id: string;
    cred_kind: string;
    status: string;
  }>(res, "configure connection");
  return {
    connectionId: out.connection_id,
    credKind: out.cred_kind,
    status: out.status,
  };
}

export async function setConnectionStatus(input: {
  connectionId: string;
  status: "active" | "paused" | "needs-auth";
  note?: string;
}): Promise<{ connectionId: string; status: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    vaultConnectionPath(enc(input.connectionId)),
    {
      body: JSON.stringify({
        status: input.status,
        ...(input.note ? { note: input.note } : {}),
      }),
      headers: authHeaders(token, "application/json"),
      method: "PATCH",
    }
  );
  const out = await readJson<{
    ok: true;
    connection_id: string;
    status: string;
  }>(res, "set connection status");
  return { connectionId: out.connection_id, status: out.status };
}

async function readRemoveOutcome(
  res: Response,
  op: string
): Promise<{ connection_id: string }> {
  const text = await res.text();
  if (res.ok) {
    try {
      return JSON.parse(text) as { connection_id: string };
    } catch {
      throw nonJsonError(op, res.status, text);
    }
  }
  if (res.status === 401 || res.status === 403) {
    throw new GatewayClientError(
      "auth_required",
      `${op}: gateway rejected the request (HTTP ${res.status}) — check your token in Settings.`
    );
  }
  if (res.status === 404) {
    throw new GatewayClientError("not_found", `${op}: no such connection`);
  }
  let reason = text || res.statusText;
  try {
    const body = JSON.parse(text) as { error?: string };
    if (typeof body.error === "string") reason = body.error;
  } catch {
    // Intentionally empty.
  }
  throw new GatewayClientError("conflict", reason);
}

export async function removeConnection(
  connectionId: string
): Promise<{ connectionId: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, vaultConnectionPath(enc(connectionId)), {
    headers: authHeaders(token),
    method: "DELETE",
  });
  const out = await readRemoveOutcome(res, "remove connection");
  return { connectionId: out.connection_id };
}

export interface BeginConnectionAuthorization {
  authUrl: string;
  state: string;
  redirectUri: string;
}

export async function beginConnectionAuthorization(input: {
  connectionId: string;
  redirectUri?: string;
  surface?: "desktop" | "web";
}): Promise<BeginConnectionAuthorization> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    vaultConnectionAuthorizePath(enc(input.connectionId)),
    {
      body: JSON.stringify({
        ...(input.redirectUri ? { redirect_uri: input.redirectUri } : {}),
        ...(input.surface ? { surface: input.surface } : {}),
      }),
      headers: withClientSession(authHeaders(token, "application/json")),
      method: "POST",
    }
  );
  const out = await readJson<{
    auth_url: string;
    state: string;
    redirect_uri: string;
  }>(res, "begin authorization");
  return {
    authUrl: out.auth_url,
    redirectUri: out.redirect_uri,
    state: out.state,
  };
}

export interface AssistOAuthHandoff {
  state: string;
  code?: string;
  receipt?: string;
  error?: string;
}

export async function completeAssistAuthorization(
  handoff: AssistOAuthHandoff
): Promise<{ connectionId: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, ROUTES.vaultConnectionsAssistComplete, {
    body: JSON.stringify(handoff),
    headers: withClientSession(authHeaders(token, "application/json")),
    method: "POST",
  });
  const out = await readJson<{ ok: true; connection_id: string }>(
    res,
    "complete Centraid Assist authorization"
  );
  return { connectionId: out.connection_id };
}
