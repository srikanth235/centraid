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

import { auth, authHeaders, doFetch, enc, readJson } from './gateway-client-core.js';

/** Plane presence + the ACTIVE vault's identity, from `GET /_vault/status`. */
export interface VaultStatus {
  active: boolean;
  vaultId: string;
  name: string;
  ownerPartyId: string;
  fresh: boolean;
}

/** One vault of the registry, from `GET /_vault/vaults`. */
export interface VaultListEntry {
  vaultId: string;
  name: string;
  /** Whether this vault is the gateway's active one (`ctx.vault` target). */
  active: boolean;
  ownerPartyId: string;
}

/** One scope of a grant or a manifest request: schema-wide or one table. */
export interface VaultScope {
  schema: string;
  table?: string | null;
  verbs: string;
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

/** An invocation parked for owner confirmation (risk above app ceiling). */
export interface VaultParkedEntry {
  invocationId: string;
  command: string;
  parkedAt: string;
  callerKind: 'app' | 'agent' | 'owner-device';
  caller: string | null;
  input: Record<string, unknown>;
}

/**
 * Plane presence. `undefined` means the gateway mounts no vault plane
 * (route 404s) — a valid deployment, not an error.
 */
export async function vaultStatus(): Promise<VaultStatus | undefined> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/status', {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  return readJson<VaultStatus>(res, 'fetch vault status');
}

/**
 * Every vault of the registry, active flagged. `undefined` when the gateway
 * mounts no vault registry (route 404s) — a valid deployment, not an error.
 */
export async function listVaults(): Promise<VaultListEntry[] | undefined> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/vaults', {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  const body = await readJson<{ vaults: VaultListEntry[] }>(res, 'list vaults');
  return body.vaults;
}

/** Create a fresh vault. It does NOT become active implicitly. */
export async function createVault(input: { name?: string }): Promise<VaultListEntry> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/vaults', {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(input.name ? { name: input.name } : {}),
  });
  return readJson<VaultListEntry>(res, 'create vault');
}

/** Rename a vault and/or make it the active one. */
export async function updateVault(input: {
  vaultId: string;
  name?: string;
  active?: true;
}): Promise<VaultListEntry> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/vaults/${enc(input.vaultId)}`, {
    method: 'PATCH',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.active ? { active: true } : {}),
    }),
  });
  return readJson<VaultListEntry>(res, 'update vault');
}

/**
 * Delete a vault — its two SQLite files are removed for good. The gateway
 * refuses to delete the ACTIVE vault (409): switch to another vault first.
 */
export async function deleteVault(input: { vaultId: string }): Promise<{ deleted: boolean }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/vaults/${enc(input.vaultId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  return readJson<{ deleted: boolean }>(res, 'delete vault');
}

/** Enrolled apps with their active grants. */
export async function vaultApps(): Promise<VaultAppEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/apps', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const body = await readJson<{ apps: VaultAppEntry[] }>(res, 'list vault apps');
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
  const res = await doFetch(baseUrl, `/centraid/_vault/apps/${enc(input.appId)}/grants`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({
      purpose: input.purpose,
      scopes: input.scopes,
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    }),
  });
  return readJson<{ grantId: string }>(res, 'approve vault grant');
}

/** Revoke one grant (owner act; the cascade runs gateway-side). */
export async function revokeVaultGrant(input: {
  grantId: string;
}): Promise<{ viewsRevoked: number; parkedDropped: number }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/grants/${enc(input.grantId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  return readJson(res, 'revoke vault grant');
}

/** Invocations parked for the owner's say-so. */
export async function vaultParked(): Promise<VaultParkedEntry[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/parked', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const body = await readJson<{ parked: VaultParkedEntry[] }>(res, 'list parked invocations');
  return body.parked;
}

/** Owner decision on one parked invocation. */
export async function confirmVaultParked(input: {
  invocationId: string;
  approve: boolean;
}): Promise<{ status: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/parked/${enc(input.invocationId)}`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ approve: input.approve }),
  });
  return readJson<{ status: string }>(res, 'confirm parked invocation');
}
