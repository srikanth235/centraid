// Connectors read path (#765). Map snake_case at this boundary; never
// re-implement authorize — re-export `lib/connection-reauth.ts` instead.

import { apiHeaders, fetchJson, requireGatewayBase } from "./gateway";

export {
  beginNotificationsConnectionAuthorization as beginConnectionAuthorization,
  completeNotificationsConnectionAuthorization as completeConnectionAuthorization,
} from "./gateway";

export type ConnectionStatus = "active" | "needs-auth" | "failing" | "paused";

export type ConnectionTrust = "staged" | "auto-publish";

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

export interface ConnectionEntry {
  connectionId: string;
  kind: string;
  label: string;
  principal: string | null;
  status: ConnectionStatus;
  trust: ConnectionTrust;
  createdAt: string;
  lastRunAt: string | null;
  /** `null` = harness-ambient; no broker credential attached. */
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
    hasRefreshToken: r.has_refresh_token,
    kind: r.kind,
    label: r.label,
    lastRunAt: r.last_run_at,
    // Missing `oauth_mode` on an OAuth credential is BYO (pre-Assist wire).
    oauthMode: r.oauth_mode ?? (r.cred_kind === "oauth2" ? "byo" : null),
    principal: r.principal,
    provider: r.provider,
    scopes: r.scopes,
    status: r.status,
    tokenExpiresAt: r.token_expires_at,
    trust: r.trust,
  };
}

export async function listConnections(): Promise<ConnectionEntry[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ connections?: ConnectionWireRow[] }>(
    `${base}/centraid/_vault/connections`,
    { headers: apiHeaders(), method: "GET" }
  );
  return (body.connections ?? []).map(fromWireRow);
}

/** Pause/resume only — `needs-auth`/`failing` are broker-reported, not settable. */
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
