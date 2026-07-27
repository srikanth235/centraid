/*
 * Renderer-side client for the gateway's paired-device surface (issue #376 —
 * `packages/gateway/src/routes/devices-routes.ts`). Backs the Gateway page's
 * Devices card (list + revoke).
 *
 *   GET    /centraid/_gateway/devices
 *   DELETE /centraid/_gateway/devices/<enrollmentId>
 *
 * The gateway scopes the roster to the caller's plane: the browser PWA shell
 * (device-token auth) sees only its own vaults' devices and its own row marked
 * `current`; the desktop's admin bearer sees every vault's devices. A gateway
 * with no device plane at all (the desktop embed) has no such surface — the
 * routes 404, which `listGatewayDevices` reports as an empty roster.
 */

import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
  GatewayClientError,
  VAULT_HEADER,
} from './gateway-client-core.js';
import { readDirectBlob, type DirectBlobDownloadPlan } from './device-blob-source.js';

export interface DeviceComputeCapabilities {
  previews: boolean;
  poster: boolean;
  pdfText: boolean;
  ocr: boolean;
  embedding: boolean;
  transcript: boolean;
  edgeSeal: boolean;
  backgroundTransfer: boolean;
}

export interface DeviceComputeProfile {
  contributeWhileCharging: boolean;
  capabilities: DeviceComputeCapabilities;
  updatedAt: string;
}

export interface GatewayDeviceWorkDepth {
  vaultId: string;
  name?: string;
  total: number;
  available: number;
  leased: number;
}

export interface DeviceEnrichmentLease {
  requestId: string;
  entityType: string;
  entityId: string | null;
  reason: 'search-miss' | 'on-view' | 'manual';
  detail: string | null;
  capability: 'previews' | 'poster' | 'pdfText' | 'ocr' | 'transcript' | 'embedding';
  contributionVariant: string | null;
  deviceId: string;
  token: string;
  expiresAt: string;
  attempt: number;
}

/**
 * The roles the owner may grant when minting a ticket — the wire twin of the
 * gateway's `GrantableRole` and of `centraid-gateway pair --role`. `revoked`
 * is a state a device is put INTO, never a role handed out, so it is not here.
 */
export type GatewayDeviceRole = 'admin' | 'write' | 'read';

/**
 * One (space, role) pair — the unit authority is authored in since #599.
 * Roles hang off the MEMBER; a device only inherits its member's grants.
 */
export interface GatewayVaultGrant {
  vaultId: string;
  vaultName?: string;
  role: GatewayDeviceRole;
}

/** One paired device (mirrors the gateway route's `DeviceDTO`). */
export interface CentraidGatewayDevice {
  /** The revocation handle (the enrollment row id). */
  deviceId: string;
  /** The device's key (iroh EndpointId, or a synthetic `http:<uuid>`). */
  endpointId: string;
  /** The person this device acts as (#599 L2). The roster groups on it. */
  memberId: string;
  /** That person's display label, denormalized so a roster needs one call. */
  memberLabel: string;
  label: string;
  platform?: string;
  transport: 'iroh';
  vaultId: string;
  vaultName?: string;
  addedAt?: string;
  lastUsedAt?: string;
  /** True for the device making the request (never set for the admin caller). */
  current?: boolean;
  /**
   * Server-enforced device role used to clamp replica shapes and intents.
   * `admin` is `write` plus pairing/revocation authority — the founding device
   * always holds it, so a roster type without it could not describe the one
   * device every gateway has. `revoked` is a tombstone, never a granted role.
   */
  role: GatewayDeviceRole | 'revoked';
  /** Whether this device consented to durable OPFS/IndexedDB state. */
  rememberDevice: boolean;
  /** Server-enforced app allow-list for a constrained Companion device. */
  grantProfile?: string[];
  compute?: DeviceComputeProfile;
  checkpoint?: {
    epoch: string;
    seq: number;
    schemaEpoch: number;
    updatedAt: string;
  };
}

/** Every paired device the caller may see; `[]` when the gateway has no device plane. */
export async function listGatewayDevices(): Promise<CentraidGatewayDevice[]> {
  const { baseUrl, token } = await auth();
  try {
    const res = await doFetch(baseUrl, '/centraid/_gateway/devices', {
      method: 'GET',
      headers: authHeaders(token),
    });
    const out = await readJson<{ devices: CentraidGatewayDevice[] }>(res, 'list devices');
    return out.devices ?? [];
  } catch (err) {
    // A gateway without a device plane (desktop embed) simply has none.
    if (err instanceof GatewayClientError && err.code === 'not_found') return [];
    throw err;
  }
}

/** A freshly minted one-time pairing ticket (the inverse of revoke). */
export interface GatewayDeviceTicket {
  /** The pasteable one-line token for the client's "Add gateway" dialog. */
  ticket: string;
  /** The person the redeeming device will act as. */
  memberId: string;
  memberLabel: string;
  /** Every (space, role) the ticket carries. The first is echoed flat below. */
  grants: GatewayVaultGrant[];
  vaultId: string;
  vaultName?: string;
  /** Ticket expiry, ISO-8601. */
  expiresAt: string;
  /** The tier the redeeming device will be enrolled at. Echoed by the gateway. */
  role: GatewayDeviceRole;
}

/** What the panel sends to mint — a person plus what they may reach. */
export interface GatewayDeviceTicketInput {
  vaultId?: string;
  ttlMinutes?: number;
  label?: string;
  role?: GatewayDeviceRole;
  /** An EXISTING person: member id (or exact label, for CLI parity). */
  memberId?: string;
  /** A NEW person, created by this mint. Never combine with `memberId`. */
  newMemberLabel?: string;
  /** Per-space roles. Omitted with no member = self-pair at your own roles. */
  grants?: { vaultId: string; role: GatewayDeviceRole }[];
}

/**
 * Mint a device-pairing ticket from the app (the operator twin of
 * `centraid-gateway pair`). The gateway scopes it to the caller's plane and
 * defaults the target vault to the active `x-centraid-vault` when none is given.
 *
 * Naming NO member is a SELF-PAIR — the ticket lands on the caller's own
 * member at the roles they already hold (#599 Decision 5), which is why a
 * bare `{ttlMinutes}` call is safe. Naming another person (`memberId`, or
 * `newMemberLabel` to create one) is an invite, and requires the caller hold
 * `admin` in every granted space: the ticket leaves this machine, so the
 * grants travel with it.
 */
export async function createGatewayDeviceTicket(
  input?: GatewayDeviceTicketInput,
): Promise<GatewayDeviceTicket> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/devices/ticket', {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(input ?? {}),
  });
  return readJson<GatewayDeviceTicket & { ok: true }>(res, 'mint pairing ticket');
}

/**
 * Revoke one paired DEVICE — "this phone was stolen". The person and their
 * other devices are untouched (removing a person is `removeGatewayMember`).
 * Idempotent — `removed:false` when already gone.
 *
 * The row survives as a tombstone at role `revoked`, so prior attribution
 * still resolves. Revoking the last live device of a space's last owner 409s
 * until `confirmLastAdmin` echoes that space's name back.
 */
export async function revokeGatewayDevice(
  deviceId: string,
  options?: { confirmLastAdmin?: string },
): Promise<{ removed: boolean }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_gateway/devices/${enc(deviceId)}`, {
    method: 'DELETE',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(
      options?.confirmLastAdmin ? { confirmLastAdmin: options.confirmLastAdmin } : {},
    ),
  });
  return readJson<{ removed: boolean }>(res, 'revoke device');
}

const BASIC_BROWSER_COMPUTE: DeviceComputeCapabilities = {
  previews: true,
  poster: true,
  pdfText: true,
  ocr: false,
  embedding: false,
  transcript: false,
  edgeSeal: typeof crypto !== 'undefined' && crypto.subtle !== undefined,
  backgroundTransfer: false,
};

const NO_COMPUTE: DeviceComputeCapabilities = {
  previews: false,
  poster: false,
  pdfText: false,
  ocr: false,
  embedding: false,
  transcript: false,
  edgeSeal: false,
  backgroundTransfer: false,
};

/** Toggle idle-device contribution and refresh the current device's capability advertisement. */
export async function setGatewayDeviceCompute(
  device: CentraidGatewayDevice,
  contributeWhileCharging: boolean,
): Promise<CentraidGatewayDevice> {
  const { baseUrl, token } = await auth();
  const host = device.current ? await window.CentraidApi.getHostCapabilities?.() : undefined;
  const capabilities = device.current
    ? (host?.compute ?? BASIC_BROWSER_COMPUTE)
    : (device.compute?.capabilities ?? NO_COMPUTE);
  const res = await doFetch(baseUrl, `/centraid/_gateway/devices/${enc(device.deviceId)}/compute`, {
    method: 'PUT',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ contributeWhileCharging, capabilities }),
  });
  const out = await readJson<{ device: CentraidGatewayDevice }>(res, 'update device compute');
  return out.device;
}

export async function getGatewayDeviceWorkStatus(): Promise<GatewayDeviceWorkDepth[]> {
  const { baseUrl, token } = await auth();
  try {
    const res = await doFetch(baseUrl, '/centraid/_gateway/device-work/status', {
      method: 'GET',
      headers: authHeaders(token),
    });
    const out = await readJson<{ vaults: GatewayDeviceWorkDepth[] }>(res, 'device work status');
    return out.vaults;
  } catch (error) {
    if (error instanceof GatewayClientError && error.code === 'not_found') return [];
    throw error;
  }
}

/** Pull one compatible job only while the caller proves charging + unmetered eligibility. */
export async function leaseGatewayDeviceWork(input: {
  vaultId: string;
  capabilities: DeviceEnrichmentLease['capability'][];
  charging: boolean;
  unmetered: boolean;
  ttlMs?: number;
}): Promise<DeviceEnrichmentLease | null> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/device-work/lease', {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(input),
  });
  return (await readJson<{ lease: DeviceEnrichmentLease | null }>(res, 'lease device work')).lease;
}

export async function finishGatewayDeviceWork(input: {
  vaultId: string;
  requestId: string;
  token: string;
}): Promise<boolean> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/device-work/complete', {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(input),
  });
  return (await readJson<{ completed: boolean }>(res, 'complete device work')).completed;
}

export async function releaseGatewayDeviceWork(input: {
  vaultId: string;
  requestId: string;
  token: string;
}): Promise<boolean> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/device-work/release', {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(input),
  });
  return (await readJson<{ released: boolean }>(res, 'release device work')).released;
}

function workVaultHeaders(
  token: string | undefined,
  vaultId: string,
  contentType?: string,
): Record<string, string> {
  return { ...authHeaders(token, contentType), [VAULT_HEADER]: vaultId };
}

/** Read the original bytes for a leased job from that job's vault. */
export async function readGatewayDeviceWorkSource(input: {
  vaultId: string;
  contentId: string;
  sha256: string;
  mediaType: string;
}): Promise<Blob> {
  const { baseUrl, token } = await auth();
  const direct = await doFetch(
    baseUrl,
    `/centraid/_vault/blobs/direct/${enc(input.sha256)}/download`,
    {
      method: 'GET',
      headers: workVaultHeaders(token, input.vaultId),
    },
  );
  if (direct.ok) {
    const plan = await readJson<DirectBlobDownloadPlan>(direct, 'authorize direct device read');
    return readDirectBlob(plan, input.sha256, input.mediaType);
  }
  if (direct.status === 401 || direct.status === 403) {
    await readJson<never>(direct, 'authorize direct device read');
  }
  // Local-primary vaults have no provider URL. Their permanent fallback is
  // the ordinary content-id route (never address this route by sha).
  const res = await doFetch(baseUrl, `/centraid/_vault/blobs/${enc(input.contentId)}`, {
    method: 'GET',
    headers: workVaultHeaders(token, input.vaultId),
  });
  if (!res.ok) {
    await readJson<never>(res, 'read device work source');
    throw new GatewayClientError('gateway_error', 'read device work source failed');
  }
  return res.blob();
}

/** Submit one device-produced derivative through the verified contribution door. */
export async function stageGatewayDeviceWorkDerivative(input: {
  vaultId: string;
  parentSha256: string;
  variant: string;
  body: Blob;
  mediaType: string;
}): Promise<void> {
  const { baseUrl, token } = await auth();
  const query = new URLSearchParams({
    variant: input.variant,
    variant_of: input.parentSha256,
    media_type: input.mediaType,
  });
  const res = await doFetch(baseUrl, `/centraid/_vault/blobs?${query}`, {
    method: 'POST',
    headers: workVaultHeaders(token, input.vaultId, input.mediaType),
    body: input.body,
  });
  await readJson<Record<string, unknown>>(res, `submit ${input.variant} derivative`);
}
