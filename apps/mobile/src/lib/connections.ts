// Mobile connections client — the READ half of the Connectors place (#765).
//
//   GET   /centraid/_vault/connections        → { connections: [...] }
//   PATCH /centraid/_vault/connections/<id>   → { status, note? } pause / resume
//
// Both are vault-SCOPED owner acts, so they carry `apiHeaders()` (bearer + the
// active vault) and follow the Vaults switcher, exactly as `lib/insights.ts`'s
// summary read does.
//
// The list endpoint answers in the DB's raw snake_case column shape (see
// `listConnections` in `packages/gateway/src/routes/connections-routes.ts`) —
// this module maps it onto camelCase once, at the boundary, so no screen ever
// sees a wire name. The mapping and the field set are the same call
// `packages/client/src/gateway-client-connections.ts` makes for the shell;
// mobile does not depend on that package, so the shape is mirrored here as a
// lean local interface (the convention `lib/gateway.ts` and `lib/insights.ts`
// already follow). A secret cell is never on this wire and so has no type.
//
// The AUTHORIZE half is not re-implemented here: mobile already owns a working
// re-authorization flow (`lib/connection-reauth.ts` for the rules, the two
// functions below for the wire), built around the in-app auth session and the
// `centraid://` return the phone can actually receive. It is re-exported under
// names that read from Connectors rather than from Notifications, its first
// caller — one implementation, two doors.

import { apiHeaders, fetchJson, requireGatewayBase } from "./gateway";

export {
  beginNotificationsConnectionAuthorization as beginConnectionAuthorization,
  completeNotificationsConnectionAuthorization as completeConnectionAuthorization,
} from "./gateway";

/** Health of one connection. `needs-auth` is the one the screen acts on. */
export type ConnectionStatus = "active" | "needs-auth" | "failing" | "paused";

/** Whether writes from this connection stage for review or publish directly. */
export type ConnectionTrust = "staged" | "auto-publish";

/** Raw wire shape of one row — verbatim SQL column names, see the route. */
interface ConnectionWireRow {
  connection_id: string;
  kind: string;
  label: string;
  principal: string | null;
  status: ConnectionStatus;
  trust: ConnectionTrust;
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

/** One data-source connection with its credential's identity + health. */
export interface ConnectionEntry {
  connectionId: string;
  kind: string;
  label: string;
  principal: string | null;
  status: ConnectionStatus;
  trust: ConnectionTrust;
  createdAt: string;
  lastRunAt: string | null;
  /** `null` = no credential attached — the connection rides the
   *  harness-ambient lane rather than a broker-carried one. */
  credKind: "oauth2" | "api_key" | null;
  oauthMode: "byo" | "assist" | null;
  provider: string | null;
  scopes: string | null;
  allowedHosts: string[] | null;
  tokenExpiresAt: string | null;
  hasRefreshToken: boolean;
  /** Why the connection is unhealthy, in the broker's own words, or `null`. */
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
    // The gateway only started sending `oauth_mode` with the Assist lane; a
    // row without one that carries an OAuth credential is a BYO client, which
    // is what the shell client infers too.
    oauthMode: r.oauth_mode ?? (r.cred_kind === "oauth2" ? "byo" : null),
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
  const base = await requireGatewayBase();
  const body = await fetchJson<{ connections?: ConnectionWireRow[] }>(
    `${base}/centraid/_vault/connections`,
    { headers: apiHeaders(), method: "GET" }
  );
  return (body.connections ?? []).map(fromWireRow);
}

/**
 * Pause or resume one connection. The gateway accepts only these two values
 * on this route — `needs-auth` and `failing` are health the broker reports,
 * never states an owner sets — so the parameter is narrowed to what is real.
 */
export async function setConnectionStatus(
  connectionId: string,
  status: "active" | "paused",
  note?: string
): Promise<void> {
  const base = await requireGatewayBase();
  await fetchJson<{ ok?: boolean }>(
    `${base}/centraid/_vault/connections/${encodeURIComponent(connectionId)}`,
    {
      body: JSON.stringify(note === undefined ? { status } : { note, status }),
      headers: apiHeaders({ "content-type": "application/json" }),
      method: "PATCH",
    }
  );
}
