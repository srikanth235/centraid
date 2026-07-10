/*
 * Renderer-side client for the broker-owned OAuth / BYO-client connections
 * surface (issue #304's gateway routes, `packages/gateway/src/routes/
 * connections-routes.ts`). Split out of `gateway-client.ts` so the new
 * Settings → Connections screen doesn't grow the barrel file further; the
 * barrel re-exports this module so call sites still import from
 * `./gateway-client.js`.
 *
 * Wire contract (all under `/centraid/_vault/…`, owner-authenticated except
 * the OAuth callback which the gateway itself serves — the renderer never
 * calls that endpoint directly):
 *
 *   GET    /_vault/connections                — list + health (never a secret cell)
 *   GET    /_vault/connections/providers       — BYO-client wizard presets
 *   POST   /_vault/connections                 — configure a credential (or detach with cred_kind:'none')
 *   PATCH  /_vault/connections/<id>            — {status, note?} pause / resume
 *   DELETE /_vault/connections/<id>            — remove entirely; 404 unknown id, 409 when undecided
 *                                                 outbox items or receipted sync history block it
 *   POST   /_vault/connections/<id>/authorize  — {redirect_uri?} → {auth_url, state}
 *
 * The list/configure endpoints answer in the DB's raw snake_case column
 * shape (see `listConnections` in the gateway route) — this module maps
 * that onto camelCase types, same convention as `listVersions`'s `GitVersion`
 * mapping in `gateway-client.ts`. The provider-presets endpoint already
 * answers in camelCase (it serializes a TS interface directly), so those
 * types pass through unchanged.
 */

import { GatewayClientError, auth, authHeaders, doFetch, enc, readJson } from './gateway-client-core.js';

// ---- Connection health list (GET /_vault/connections) ----

/** Raw wire shape of one row — verbatim SQL column names, see the gateway route. */
interface ConnectionWireRow {
  connection_id: string;
  kind: string;
  label: string;
  principal: string | null;
  status: 'active' | 'needs-auth' | 'failing' | 'paused';
  trust: 'staged' | 'auto-publish';
  created_at: string;
  last_run_at: string | null;
  cred_kind: 'oauth2' | 'api_key' | null;
  provider: string | null;
  scopes: string | null;
  allowed_hosts: string[] | null;
  token_expires_at: string | null;
  has_refresh_token: boolean;
  auth_note: string | null;
}

/** One data-source connection with its broker-carried credential + health. */
export interface ConnectionEntry {
  connectionId: string;
  kind: string;
  label: string;
  principal: string | null;
  status: 'active' | 'needs-auth' | 'failing' | 'paused';
  trust: 'staged' | 'auto-publish';
  createdAt: string;
  lastRunAt: string | null;
  /** `null` = no credential attached yet — the connection rides the
   *  harness-ambient lane instead of a BYO credential. */
  credKind: 'oauth2' | 'api_key' | null;
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

/** Every configured connection, newest-first (the gateway's own ordering). */
export async function listConnections(): Promise<ConnectionEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/connections', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ connections: ConnectionWireRow[] }>(res, 'list connections');
  return (out.connections ?? []).map(fromWireRow);
}

// ---- BYO-client wizard presets (GET /_vault/connections/providers) ----

/** One bundled connector template a provider preset unlocks. */
export interface ConnectionProviderConnector {
  templateId: string;
  kind: string;
  scope?: string;
}

/** A provider's wizard content — mirrors `ProviderPreset` in
 *  `packages/gateway/src/routes/connection-providers.ts` (already camelCase
 *  on the wire, since the gateway serializes the TS interface directly). */
export interface ConnectionProviderPreset {
  id: string;
  name: string;
  credKind: 'oauth2' | 'api_key';
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string;
  allowedHosts: string[];
  setup: string[];
  connectors: ConnectionProviderConnector[];
}

/** The BYO-client wizard's provider catalog (Google, GitHub, …). */
export async function listConnectionProviders(): Promise<ConnectionProviderPreset[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/connections/providers', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const out = await readJson<{ providers: ConnectionProviderPreset[] }>(res, 'list providers');
  return out.providers ?? [];
}

// ---- Configure / detach a credential (POST /_vault/connections) ----

/** Attach (or, with `credKind: 'none'`, detach) a credential on a connection,
 *  identified by `(kind, label)` — the same pair the connector manifest
 *  names (issue #304 decision: "credential attaches to the connection row,
 *  not the manifest"). A `(kind, label)` that doesn't exist yet is created. */
export interface ConfigureConnectionInput {
  kind: string;
  label: string;
  credKind: 'oauth2' | 'api_key' | 'none';
  provider?: string;
  authUrl?: string;
  tokenUrl?: string;
  scopes?: string;
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  /** Required (non-empty) for every `credKind` except `'none'` — the
   *  anti-exfiltration host pin the injected fetch enforces. */
  allowedHosts?: string[];
}

export async function configureConnection(
  input: ConfigureConnectionInput,
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
  const res = await doFetch(baseUrl, '/centraid/_vault/connections', {
    body: JSON.stringify(body),
    headers: authHeaders(token, 'application/json'),
    method: 'POST',
  });
  const out = await readJson<{ ok: true; connection_id: string; cred_kind: string; status: string }>(
    res,
    'configure connection',
  );
  return { connectionId: out.connection_id, credKind: out.cred_kind, status: out.status };
}

// ---- Pause / resume (PATCH /_vault/connections/<id>) ----

export async function setConnectionStatus(input: {
  connectionId: string;
  status: 'active' | 'paused' | 'needs-auth';
  note?: string;
}): Promise<{ connectionId: string; status: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/connections/${enc(input.connectionId)}`,
    {
      body: JSON.stringify({ status: input.status, ...(input.note ? { note: input.note } : {}) }),
      headers: authHeaders(token, 'application/json'),
      method: 'PATCH',
    },
  );
  const out = await readJson<{ ok: true; connection_id: string; status: string }>(
    res,
    'set connection status',
  );
  return { connectionId: out.connection_id, status: out.status };
}

// ---- Remove entirely (DELETE /_vault/connections/<id>) ----

/**
 * The route answers a real, structured `{ok:false, error}` body on refusal
 * (409: undecided outbox items, or receipted sync history — see
 * `sync.remove_connection`'s doc comment) — read it regardless of HTTP
 * status, same idiom `gateway-client-outbox.ts`'s `readOutcome` uses for the
 * outbox decide/revoke routes, so the caller gets the server's own reason
 * instead of a generic "HTTP 409" message.
 */
async function readRemoveOutcome(
  res: Response,
  op: string,
): Promise<{ connection_id: string }> {
  const text = await res.text();
  if (res.ok) {
    try {
      return JSON.parse(text) as { connection_id: string };
    } catch {
      throw new GatewayClientError(
        'gateway_error',
        `${op} returned non-JSON: ${text.slice(0, 200)}`,
      );
    }
  }
  if (res.status === 401 || res.status === 403) {
    throw new GatewayClientError(
      'auth_required',
      `${op}: gateway rejected request (HTTP ${res.status}). Check your gateway token in Settings.`,
    );
  }
  if (res.status === 404) {
    throw new GatewayClientError('not_found', `${op}: no such connection`);
  }
  let reason = text || res.statusText;
  try {
    const body = JSON.parse(text) as { error?: string };
    if (typeof body.error === 'string') reason = body.error;
  } catch {
    // Non-JSON body — fall back to the raw text above.
  }
  throw new GatewayClientError('conflict', reason);
}

/**
 * The real delete (issue #304's missing renderer half): removes the
 * connection row, its credential + health sidecars and cursor state. Refused
 * (409) when the connection still has undecided outbox items or receipted
 * sync history — `reason` is the server's own explanation, meant for a
 * toast, not a generic HTTP-status message.
 */
export async function removeConnection(connectionId: string): Promise<{ connectionId: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/connections/${enc(connectionId)}`, {
    headers: authHeaders(token),
    method: 'DELETE',
  });
  const out = await readRemoveOutcome(res, 'remove connection');
  return { connectionId: out.connection_id };
}

// ---- Begin the PKCE consent ceremony (POST /_vault/connections/<id>/authorize) ----

export interface BeginConnectionAuthorization {
  authUrl: string;
  state: string;
  redirectUri: string;
}

/**
 * Starts the OAuth ceremony for an `oauth2` connection: the gateway mints a
 * PKCE `auth_url` + single-use `state` and returns them; the caller is
 * responsible for getting the owner's browser to `auth_url` (this module
 * does not open windows — see `SettingsConnectionsScreen.tsx`). The
 * provider redirects back to the gateway's own `/oauth/callback`, which
 * finishes the ceremony server-side — the renderer never sees the code.
 */
export async function beginConnectionAuthorization(input: {
  connectionId: string;
  redirectUri?: string;
}): Promise<BeginConnectionAuthorization> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/connections/${enc(input.connectionId)}/authorize`,
    {
      body: JSON.stringify(input.redirectUri ? { redirect_uri: input.redirectUri } : {}),
      headers: authHeaders(token, 'application/json'),
      method: 'POST',
    },
  );
  const out = await readJson<{ auth_url: string; state: string; redirect_uri: string }>(
    res,
    'begin authorization',
  );
  return { authUrl: out.auth_url, redirectUri: out.redirect_uri, state: out.state };
}
