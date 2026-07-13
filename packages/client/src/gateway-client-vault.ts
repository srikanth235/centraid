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
   * Presentation out of `core_vault.settings_json` (#280: profiles are
   * vaults — the switcher's color/icon/blurb live IN the vault).
   */
  color?: string;
  icon?: string;
  blurb?: string;
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

/**
 * An invocation parked for owner confirmation (risk above app ceiling).
 * `callerKind` refines `'agent'` into `'assistant'` when the requester is
 * the vault assistant's own identity, not an automation's — the Approvals
 * row badge reads this to say WHO is asking (issue: parked-invocation
 * trust legibility). `callerId` is the enrolled row id, stable even if the
 * display name changes; `caller` is the display name shown to the owner.
 */
export interface VaultParkedEntry {
  invocationId: string;
  command: string;
  parkedAt: string;
  callerKind: 'app' | 'agent' | 'assistant' | 'owner-device';
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
  const res = await doFetch(baseUrl, `/centraid/_vault/vaults/${enc(input.vaultId)}`, {
    method: 'PATCH',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.blurb !== undefined ? { blurb: input.blurb } : {}),
    }),
  });
  return readJson<VaultListEntry>(res, 'update vault');
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

/** One app's scenario-seed state (issue #290 phase 1). */
export interface VaultDemoApp {
  appId: string;
  rows: number;
  seedable: boolean;
}

/** Per-app demo status: which apps ship a scenario, which have rows loaded. */
export async function vaultDemoStatus(): Promise<VaultDemoApp[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/demo', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const body = await readJson<{ apps: VaultDemoApp[] }>(res, 'read demo status');
  return body.apps;
}

/** Run an app's seed.js scenario generator (demo register, owner act). */
export async function vaultDemoLoad(appId: string): Promise<{ rows: number }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/demo/${enc(appId)}`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  return readJson<{ rows: number }>(res, 'load demo data');
}

/** One staged import batch as the shell lists it (issue #290 phase 2). */
export interface VaultImportBatch {
  batchId: string;
  status: 'draft' | 'published' | 'discarded';
  createdAt: string;
  resolvedAt: string | null;
  summary: Record<string, number>;
  kind: string | null;
  label: string | null;
}

/** One staged row for review. */
export interface VaultImportRow {
  seq: number;
  entityType: string;
  externalId: string;
  disposition: 'create' | 'update' | 'skip' | 'merge-candidate';
  note: string | null;
  publishedEntityId: string | null;
}

/** Stage a dropped file into a reviewable draft batch. */
export async function vaultImportStage(input: {
  filename: string;
  text?: string;
  base64?: string;
  accountName?: string;
  currency?: string;
}): Promise<{
  batchId: string;
  kind: string;
  staged: Record<string, number>;
  total: number;
  unrouted: string[];
}> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/imports', {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(input),
  });
  return readJson(res, 'stage import');
}

/** Batches, newest first. */
export async function vaultImportsList(): Promise<VaultImportBatch[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_vault/imports', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const body = await readJson<{ batches: VaultImportBatch[] }>(res, 'list imports');
  return body.batches;
}

/** The staged rows of one batch, for review. */
export async function vaultImportRows(batchId: string): Promise<VaultImportRow[]> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/imports/${enc(batchId)}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  const body = await readJson<{ rows: VaultImportRow[] }>(res, 'read import batch');
  return body.rows;
}

/** Publish a reviewed draft batch. */
export async function vaultImportPublish(
  batchId: string,
): Promise<{ created: number; updated: number; skipped: number; failed: unknown[] }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/imports/${enc(batchId)}/publish`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  return readJson(res, 'publish import');
}

/** Discard a draft batch. */
export async function vaultImportDiscard(batchId: string): Promise<{ receiptId: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/imports/${enc(batchId)}/discard`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  return readJson(res, 'discard import');
}

/** One connection's health (issue #290 phase 4). */
export interface VaultConnection {
  connectionId: string;
  kind: string;
  label: string;
  principal: string | null;
  status: 'active' | 'needs-auth' | 'failing' | 'paused';
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
  const res = await doFetch(baseUrl, '/centraid/_vault/imports/connections', {
    method: 'GET',
    headers: authHeaders(token),
  });
  const body = await readJson<{ connections: VaultConnection[] }>(res, 'read connections');
  return body.connections;
}

/** Pause or resume a connection (owner act). */
export async function vaultConnectionSetStatus(
  connectionId: string,
  status: 'paused' | 'active',
): Promise<void> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/imports/connections/${enc(connectionId)}/status`,
    {
      method: 'POST',
      headers: authHeaders(token, 'application/json'),
      body: JSON.stringify({ status }),
    },
  );
  await readJson(res, 'set connection status');
}

/** Purge demo rows — one app's, or every app's when appId is omitted. */
export async function vaultDemoPurge(
  appId?: string,
): Promise<{ purged: number; blocked: unknown[] }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_vault/demo${appId ? `/${enc(appId)}` : ''}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  return readJson<{ purged: number; blocked: unknown[] }>(res, 'purge demo data');
}
