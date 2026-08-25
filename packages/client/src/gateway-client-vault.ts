/*
 * Renderer-side client for the gateway's owner consent surface
 * (`/centraid/_vault/*`, duaility §12). Everything here is an OWNER act
 * executed by the gateway with the owner-device credential — apps never
 * see these routes; their door is `ctx.vault` inside handlers.
 *
 * When the active gateway mounts no vault plane the routes 404; callers
 * get `undefined` from `vaultStatus()` and should render the
 * "no vault on this gateway" state rather than an error.
 */

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
} from "./gateway-client-core.js";

/** Presence + the ADDRESSED vault's identity, from `GET /_vault/status`. */
export interface VaultStatus {
  vaultId: string;
  name: string;
  ownerPartyId: string;
  fresh: boolean;
}

/**
 * One vault of the registry, from `GET /_vault/vaults` (filtered to the
 * caller's enrollments, #289). There is no server-side "active" flag any
 * more — the client owns its vault pointer; the switcher compares each
 * `vaultId` against `getGatewayAuth().vaultId`.
 */
export interface VaultListEntry {
  vaultId: string;
  name: string;
  ownerPartyId: string;
  /**
   * True for the owner's PERSONAL vault — the gateway's default target,
   * marked in the vault itself at founding. Survives the fresh path renaming
   * it to the owner's display name, so this (not `name === "Personal"`) is
   * how a client finds "my own vault".
   */
  personal?: boolean;
  /**
   * Presentation out of `core_vault.settings_json` (#280: profiles are
   * vaults — the switcher's color/icon/blurb live IN the vault).
   */
  color?: string;
  icon?: string;
  blurb?: string;
}

/**
 * One SCOPE an app may be mounted over, from `GET /_vault/scopes?app=<id>`
 * (#599). A scope is a vault the CALLING OWNER owns (#726) — so this is
 * the ownership-aware successor to `listVaults`, which answers per DEVICE
 * enrollment and carries neither `canWrite` nor whether the app is installed
 * there.
 *
 * Order is the gateway's: oldest vault first, which puts the owner's own
 * (primary) scope first. `installed` is present only when `app` was named.
 */
export interface AppScopeEntry {
  vaultId: string;
  label: string;
  /**
   * Whether this is the member's OWN vault — the durable founding marker
   * (#711). An app's "somewhere other than my own" marker is
   * exactly `personal === false`, never a match on `label`. Optional only
   * because a gateway older than the marker omits it, and "unknown" must read
   * as the member's own (unmarked) rather than falsely marking everything.
   */
  personal?: boolean;
  color?: string;
  icon?: string;
  /** Ownership-sourced writability (#726): a vault you own is writable.
   *  Supplied by the gateway, never derived client-side from a role. */
  canWrite: boolean;
  installed?: boolean;
}

/**
 * The whole scopes answer: the rows this app is mounted over (#599).
 */
export interface AppScopePlane {
  scopes: AppScopeEntry[];
}

/**
 * The scopes plane for one app. `undefined` when the gateway mounts none
 * (route 404s) — an older gateway, not an error; callers fall back to the
 * single ambient scope.
 */
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

/**
 * Just the rows (the shell's own scope registry). `undefined` has the same
 * meaning as above.
 */
export async function listAppScopes(
  appId?: string
): Promise<AppScopeEntry[] | undefined> {
  return (await readAppScopePlane(appId))?.scopes;
}

/** One scope of a grant or a manifest request: schema-wide or one table. */
export interface VaultScope {
  schema: string;
  table?: string | null;
  verbs: string;
  rowFilter?: Array<{ column: string; op: string; value?: unknown }> | null;
  fieldMask?: string[] | null;
}

/** An active grant an enrolled app holds. */
export interface VaultGrant {
  grantId: string;
  purposeConceptId: string;
  purpose: string | null;
  expiresAt: string | null;
  scopes: VaultScope[];
}

/** An enrolled app with its active grants — one row of the consent surface. */
export interface VaultAppEntry {
  appId: string;
  /** The Centraid app id — enrollment stores it as `consent.app.name`. */
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

/** Active enrolled agents, including the stable id used by consent rows. */
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

/** Owner-trust entity search used by stable @-tokens in automation instructions. */
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

/** Owner-trust live anchors used for row/field/span-grade automation tags. */
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

/**
 * An invocation parked for owner confirmation (risk above app ceiling).
 * `callerKind` refines `'agent'` into `'assistant'` when the requester is
 * the vault assistant's own identity, not an automation's — the Approvals
 * row badge reads this to say WHO is asking. `callerId` is the enrolled row
 * id, stable even if the
 * display name changes; `caller` is the display name shown to the owner.
 */
export interface VaultParkedEntry {
  invocationId: string;
  command: string;
  parkedAt: string;
  callerKind: "app" | "agent" | "assistant" | "owner-device";
  callerId: string;
  caller: string | null;
  input: Record<string, unknown>;
}

/**
 * Plane presence. `undefined` means the gateway mounts no vault plane
 * (route 404s) — a valid deployment, not an error.
 */
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

/**
 * Every vault of the registry, active flagged. `undefined` when the gateway
 * mounts no vault registry (route 404s) — a valid deployment, not an error.
 */
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

/**
 * Rename a vault and/or update its presentation (color/icon/blurb — #280:
 * profiles are vaults). Switching which vault is ACTIVE is NOT done here
 * any more (#289) — it is a pure client-side pointer flip via
 * `window.CentraidApi.setActiveVault`; the server holds no active pointer.
 * Vault create/delete are admin acts (server CLI over SSH) and no longer
 * have an HTTP surface — a POST/DELETE here answers 405.
 */
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

/** Enrolled apps with their active grants. */
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

/**
 * Owner approval of an app's requested access. The request is the
 * manifest-declared `vault` block verbatim — the UI never invents scopes
 * the app didn't ask for.
 */
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

/** Revoke one grant (owner act; the cascade runs gateway-side). */
export async function revokeVaultGrant(input: {
  grantId: string;
}): Promise<{ viewsRevoked: number; parkedDropped: number }> {
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

/** Invocations parked for the owner's say-so. */
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

/** Owner decision on one parked invocation. */
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

/** One app's scenario-seed state (#290). */
export interface VaultDemoApp {
  appId: string;
  rows: number;
  seedable: boolean;
}

/** Per-app demo status: which apps ship a scenario, which have rows loaded. */
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

/** Run an app's seed.js scenario generator (demo register, owner act). */
export async function vaultDemoLoad(appId: string): Promise<{ rows: number }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/demo/${enc(appId)}`, {
    method: "POST",
    headers: authHeaders(token),
  });
  return readJson<{ rows: number }>(res, "load demo data");
}

/** One connection's health (#290). */
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

/** Connection health — every connection with its latest run. */
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

/** Pause or resume a connection (owner act). */
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
