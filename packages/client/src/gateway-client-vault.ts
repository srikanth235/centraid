import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";

export interface VaultStatus {
  vaultId: string;
  name: string;
  ownerPartyId: string;
  fresh: boolean;
}

export interface VaultListEntry {
  vaultId: string;
  name: string;
  ownerPartyId: string;
  personal?: boolean;
  color?: string;
  icon?: string;
  blurb?: string;
}

export interface AppScopeEntry {
  vaultId: string;
  label: string;
  personal?: boolean;
  color?: string;
  icon?: string;
  canWrite: boolean;
  installed?: boolean;
}

export interface AppScopePlane {
  scopes: AppScopeEntry[];
}

export async function readAppScopePlane(
  appId?: string
): Promise<AppScopePlane | undefined> {
  const { baseUrl, token } = await auth();
  const path = appId
    ? `/centraid/_vault/scopes?app=${encodeURIComponent(appId)}`
    : "/centraid/_vault/scopes";
  const res = await doFetch(baseUrl, path, {
    method: "GET",
    headers: authHeaders(token),
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  return await readJson<AppScopePlane>(res, "list app scopes");
}

export async function listAppScopes(
  appId?: string
): Promise<AppScopeEntry[] | undefined> {
  return (await readAppScopePlane(appId))?.scopes;
}

export interface VaultScope {
  schema: string;
  table?: string | null;
  verbs: string;
  rowFilter?: Array<{ column: string; op: string; value?: unknown }> | null;
  fieldMask?: string[] | null;
}

export interface VaultGrant {
  grantId: string;
  purposeConceptId: string;
  purpose: string | null;
  expiresAt: string | null;
  scopes: VaultScope[];
}

export interface VaultAppEntry {
  appId: string;
  name: string;
  status: string;
  origin: string;
  riskCeiling: string;
  installedAt: string;
  grants: VaultGrant[];
}

export interface VaultAgentEntry {
  agentId: string;
  enrollmentKey: string;
  partyId: string;
  name: string;
  modelRef: string;
  enrolledAt: string;
  grants: VaultGrant[];
}

export async function listAgents(): Promise<VaultAgentEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/agents", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ agents: VaultAgentEntry[] }>(
    res,
    "list agents"
  );
  return body.agents;
}

export interface VaultEntityHit {
  type: string;
  id: string;
  status: string;
  title: string | null;
  subtitle: string | null;
  thumbnail_content_id: string | null;
  snippet?: string;
}

export interface VaultAnchorHit extends VaultEntityHit {
  type: "core.link_anchor";
  sourceType: string;
  sourceId: string;
  sourceField: string;
}

export async function listVaultEntityTypes(): Promise<string[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/entities", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ entities: string[] }>(
    res,
    "list vault entity types"
  );
  return body.entities;
}

export async function searchVaultEntities(
  term: string
): Promise<VaultEntityHit[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/picker?term=${enc(term)}&limit=8`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  const body = await readJson<{ cards: VaultEntityHit[] }>(
    res,
    "search vault entities"
  );
  return body.cards;
}

export async function searchVaultAnchors(
  term: string
): Promise<VaultAnchorHit[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/anchors?term=${enc(term)}&limit=8`,
    {
      method: "GET",
      headers: authHeaders(token),
    }
  );
  const body = await readJson<{ anchors: VaultAnchorHit[] }>(
    res,
    "search vault anchors"
  );
  return body.anchors;
}

export interface VaultParkedEntry {
  invocationId: string;
  command: string;
  parkedAt: string;
  callerKind: "app" | "agent" | "assistant" | "owner-device";
  callerId: string;
  caller: string | null;
  input: Record<string, unknown>;
}

export async function vaultStatus(): Promise<VaultStatus | undefined> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/status", {
    method: "GET",
    headers: authHeaders(token),
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  return readJson<VaultStatus>(res, "fetch vault status");
}

export async function listVaults(): Promise<VaultListEntry[] | undefined> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/vaults", {
    method: "GET",
    headers: authHeaders(token),
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  const body = await readJson<{ vaults: VaultListEntry[] }>(res, "list vaults");
  return body.vaults;
}

export async function updateVault(input: {
  vaultId: string;
  name?: string;
  color?: string | null;
  icon?: string | null;
  blurb?: string | null;
}): Promise<VaultListEntry> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/vaults/${enc(input.vaultId)}`,
    {
      method: "PATCH",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.icon === undefined ? {} : { icon: input.icon }),
        ...(input.blurb === undefined ? {} : { blurb: input.blurb }),
      }),
    }
  );
  return readJson<VaultListEntry>(res, "update vault");
}

export async function vaultApps(): Promise<VaultAppEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/apps", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ apps: VaultAppEntry[] }>(
    res,
    "list vault apps"
  );
  return body.apps;
}

export async function approveVaultGrant(input: {
  appId: string;
  purpose: string;
  scopes: VaultScope[];
  expiresAt?: string;
}): Promise<{ grantId: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/apps/${enc(input.appId)}/grants`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({
        purpose: input.purpose,
        scopes: input.scopes,
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      }),
    }
  );
  return readJson<{ grantId: string }>(res, "approve vault grant");
}

export async function revokeVaultGrant(input: {
  grantId: string;
}): Promise<{ parkedDropped: number }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/grants/${enc(input.grantId)}`,
    {
      method: "DELETE",
      headers: authHeaders(token),
    }
  );
  return readJson(res, "revoke vault grant");
}

export async function vaultParked(): Promise<VaultParkedEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/parked", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ parked: VaultParkedEntry[] }>(
    res,
    "list parked invocations"
  );
  return body.parked;
}

export async function confirmVaultParked(input: {
  invocationId: string;
  approve: boolean;
}): Promise<{ status: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/parked/${enc(input.invocationId)}`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ approve: input.approve }),
    }
  );
  return readJson<{ status: string }>(res, "confirm parked invocation");
}

export interface VaultDemoApp {
  appId: string;
  rows: number;
  seedable: boolean;
}

export async function vaultDemoStatus(): Promise<VaultDemoApp[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/demo", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ apps: VaultDemoApp[] }>(
    res,
    "read demo status"
  );
  return body.apps;
}

export async function vaultDemoLoad(appId: string): Promise<{ rows: number }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/demo/${enc(appId)}`, {
    method: "POST",
    headers: authHeaders(token),
  });
  return readJson<{ rows: number }>(res, "load demo data");
}

export interface VaultConnection {
  connectionId: string;
  kind: string;
  label: string;
  principal: string | null;
  status: "active" | "needs-auth" | "failing" | "paused";
  lastRunAt: string | null;
  lastRun: {
    status: string;
    startedAt: string;
    staged: number;
    published: number;
    error: string | null;
  } | null;
}

export async function vaultConnections(): Promise<VaultConnection[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_vault/imports/connections", {
    method: "GET",
    headers: authHeaders(token),
  });
  const body = await readJson<{ connections: VaultConnection[] }>(
    res,
    "read connections"
  );
  return body.connections;
}

export async function vaultConnectionSetStatus(
  connectionId: string,
  status: "paused" | "active"
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/imports/connections/${enc(connectionId)}/status`,
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ status }),
    }
  );
  await readJson(res, "set connection status");
}

export * from "./gateway-client-vault-enrich.js";
