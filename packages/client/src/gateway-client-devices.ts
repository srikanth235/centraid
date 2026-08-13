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

import { readDirectBlob } from "./device-blob-source.js";
import type { DirectBlobDownloadPlan } from "./device-blob-source.js";
import {
  auth,
  authHeaders,
  doFetch,
  enc,
  readJson,
  GatewayClientError,
  VAULT_HEADER,
} from "./gateway-client-core.js";

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
  reason: "search-miss" | "on-view" | "manual";
  detail: string | null;
  /**
   * The wire twin of the gateway's `EnrichmentCapability`, narrowed by issue
   * #724 to the device lane: model-shaped work runs on the gateway's
   * recognition automation and is never leased to a device.
   */
  capability: "previews" | "poster" | "pdfText";
  contributionVariant: string | null;
  deviceId: string;
  token: string;
  expiresAt: string;
  attempt: number;
}

/**
 * One vault a device (or a freshly minted ticket) reaches — the wire twin of
 * the gateway's `DeviceDTO`/ticket `vaults[]` (#726). Ownership replaces
 * roles: a device reaches exactly the vaults its owner owns, so there is
 * nothing per-vault left to grant beyond the vault itself.
 */
export interface GatewayDeviceVault {
  vaultId: string;
  vaultName?: string;
}

/** One paired device (mirrors the gateway route's `DeviceDTO`). */
export interface CentraidGatewayDevice {
  /** The revocation handle (the enrollment row id). */
  deviceId: string;
  /** The device's key (iroh EndpointId, or a synthetic `http:<uuid>`). */
  endpointId: string;
  /** The person this device acts as (#726). The roster groups on it. */
  ownerId: string;
  /** That person's display label, denormalized so a roster needs one call. */
  ownerLabel: string;
  label: string;
  platform?: string;
  transport: "iroh";
  vaultId: string;
  vaultName?: string;
  addedAt?: string;
  lastUsedAt?: string;
  /** True for the device making the request (never set for the admin caller). */
  current?: boolean;
  /** Device tombstone — never a role (#726): the owner and their access are
   *  untouched, this binding just no longer answers for it. */
  revoked: boolean;
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
    const res = await doFetch(baseUrl, "/centraid/_gateway/devices", {
      method: "GET",
      headers: authHeaders(token),
    });
    const out = await readJson<{ devices: CentraidGatewayDevice[] }>(
      res,
      "list devices"
    );
    return out.devices ?? [];
  } catch (error) {
    // A gateway without a device plane (desktop embed) simply has none.
    if (error instanceof GatewayClientError && error.code === "not_found")
      return [];
    throw error;
  }
}

/** A freshly minted one-time pairing ticket (the inverse of revoke). */
export interface GatewayDeviceTicket {
  /** The pasteable one-line token for the client's "Add gateway" dialog. */
  ticket: string;
  /** The person the redeeming device will act as. */
  ownerId: string;
  ownerLabel: string;
  /** Every vault the ticket carries. The first is echoed flat below. */
  vaults: GatewayDeviceVault[];
  vaultId: string;
  vaultName?: string;
  /** Ticket expiry, ISO-8601. */
  expiresAt: string;
}

/**
 * What the panel sends to mint. Ownership admits no cross-person grant
 * (#726): a ticket always lands on the CALLER's own owner, so there is
 * nothing here to name a person or a role with — only which of the caller's
 * own vaults to carry, or none to carry every vault they own.
 *
 * `forPerson` is the one exception (#726 P1 "Add someone"): it mints a NEW
 * owner and a vault of their own, then binds the ticket to THAT pair instead
 * of the caller's. Mutually exclusive with `vaultId`/`vaultIds` — those name
 * a subset of the caller's own vaults, which has no meaning once the ticket
 * is landing somebody else's brand-new one.
 */
export interface GatewayDeviceTicketInput {
  /** Landing vault when `vaultIds` is omitted; also the fallback target. */
  vaultId?: string;
  /** Explicit vault subset, target-first. Omitted = every vault the caller
   *  owns, target-first. */
  vaultIds?: string[];
  /** Mint a vault for a NEW person instead of self-pairing. */
  forPerson?: { label: string; vaultName?: string };
  /**
   * Idempotency key the gateway REQUIRES with `forPerson` (issue #750):
   * generated once per intended mint (a UUID) and reused on retry, so a
   * retried request can never mint a second owner/vault.
   */
  operationId?: string;
  ttlMinutes?: number;
}

/**
 * Mint a device-pairing ticket from the app (the operator twin of
 * `centraid-gateway pair`). The gateway scopes it to the caller's plane and
 * defaults the target vault to the active `x-centraid-vault` when none is given.
 *
 * Every ticket a device caller may mint is either a SELF-PAIR (#726) — it
 * lands on the caller's own owner, reaching exactly the vaults that owner
 * already owns, which is why a bare `{ttlMinutes}` call is safe and
 * sufficient — or an *Add someone* mint (`forPerson`, #726 P1), which lands
 * on a freshly created owner and vault instead. Access is ownership, so
 * there is no third shape: a ticket can never land another EXISTING person
 * in the caller's vaults.
 */
export async function createGatewayDeviceTicket(
  input?: GatewayDeviceTicketInput
): Promise<GatewayDeviceTicket> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/devices/ticket", {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify(input ?? {}),
  });
  return readJson<GatewayDeviceTicket & { ok: true }>(
    res,
    "mint pairing ticket"
  );
}

/**
 * Revoke one paired DEVICE — "this phone was stolen". The person and their
 * other devices are untouched (removing a person is a host-custody act,
 * `owners-routes.ts` — unreachable from this device-token client). Idempotent
 * — `removed:false` when already gone.
 *
 * The row survives as a tombstone (`revoked: true`), so prior attribution
 * still resolves. Revoking the owner's last live device for a vault 409s
 * until `confirmLastDevice` echoes that vault's name back.
 */
export async function revokeGatewayDevice(
  deviceId: string,
  options?: { confirmLastDevice?: string }
): Promise<{ removed: boolean }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/devices/${enc(deviceId)}`,
    {
      method: "DELETE",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify(
        options?.confirmLastDevice
          ? { confirmLastDevice: options.confirmLastDevice }
          : {}
      ),
    }
  );
  return readJson<{ removed: boolean }>(res, "revoke device");
}

export async function renameGatewayDevice(
  deviceId: string,
  label: string
): Promise<CentraidGatewayDevice> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/devices/${enc(deviceId)}`,
    {
      method: "PATCH",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ label }),
    }
  );
  const out = await readJson<{ device: CentraidGatewayDevice }>(
    res,
    "rename device"
  );
  return out.device;
}

const BASIC_BROWSER_COMPUTE: DeviceComputeCapabilities = {
  previews: true,
  poster: true,
  pdfText: true,
  ocr: false,
  embedding: false,
  transcript: false,
  edgeSeal: typeof crypto !== "undefined" && crypto.subtle !== undefined,
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
  contributeWhileCharging: boolean
): Promise<CentraidGatewayDevice> {
  const { baseUrl, token } = await auth();
  const host = device.current
    ? await window.CentraidApi.getHostCapabilities?.()
    : undefined;
  const capabilities = device.current
    ? (host?.compute ?? BASIC_BROWSER_COMPUTE)
    : (device.compute?.capabilities ?? NO_COMPUTE);
  const res = await doFetch(
    baseUrl,
    `/centraid/_gateway/devices/${enc(device.deviceId)}/compute`,
    {
      method: "PUT",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify({ contributeWhileCharging, capabilities }),
    }
  );
  const out = await readJson<{ device: CentraidGatewayDevice }>(
    res,
    "update device compute"
  );
  return out.device;
}

export async function getGatewayDeviceWorkStatus(): Promise<
  GatewayDeviceWorkDepth[]
> {
  const { baseUrl, token } = await auth();
  try {
    const res = await doFetch(
      baseUrl,
      "/centraid/_gateway/device-work/status",
      {
        method: "GET",
        headers: authHeaders(token),
      }
    );
    const out = await readJson<{ vaults: GatewayDeviceWorkDepth[] }>(
      res,
      "device work status"
    );
    return out.vaults;
  } catch (error) {
    if (error instanceof GatewayClientError && error.code === "not_found")
      return [];
    throw error;
  }
}

/** Pull one compatible job only while the caller proves charging + unmetered eligibility. */
export async function leaseGatewayDeviceWork(input: {
  vaultId: string;
  capabilities: DeviceEnrichmentLease["capability"][];
  charging: boolean;
  unmetered: boolean;
  ttlMs?: number;
}): Promise<DeviceEnrichmentLease | null> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/device-work/lease", {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify(input),
  });
  return (
    await readJson<{ lease: DeviceEnrichmentLease | null }>(
      res,
      "lease device work"
    )
  ).lease;
}

export async function finishGatewayDeviceWork(input: {
  vaultId: string;
  requestId: string;
  token: string;
}): Promise<boolean> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(
    baseUrl,
    "/centraid/_gateway/device-work/complete",
    {
      method: "POST",
      headers: authHeaders(token, "application/json"),
      body: JSON.stringify(input),
    }
  );
  return (await readJson<{ completed: boolean }>(res, "complete device work"))
    .completed;
}

export async function releaseGatewayDeviceWork(input: {
  vaultId: string;
  requestId: string;
  token: string;
}): Promise<boolean> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, "/centraid/_gateway/device-work/release", {
    method: "POST",
    headers: authHeaders(token, "application/json"),
    body: JSON.stringify(input),
  });
  return (await readJson<{ released: boolean }>(res, "release device work"))
    .released;
}

function workVaultHeaders(
  token: string | undefined,
  vaultId: string,
  contentType?: string
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
      method: "GET",
      headers: workVaultHeaders(token, input.vaultId),
    }
  );
  if (direct.ok) {
    const plan = await readJson<DirectBlobDownloadPlan>(
      direct,
      "authorize direct device read"
    );
    return readDirectBlob(plan, input.sha256, input.mediaType);
  }
  if (direct.status === 401 || direct.status === 403) {
    await readJson<never>(direct, "authorize direct device read");
  }
  // Local-primary vaults have no provider URL. Their permanent fallback is
  // the ordinary content-id route (never address this route by sha).
  const res = await doFetch(
    baseUrl,
    `/centraid/_vault/blobs/${enc(input.contentId)}`,
    {
      method: "GET",
      headers: workVaultHeaders(token, input.vaultId),
    }
  );
  if (!res.ok) {
    await readJson<never>(res, "read device work source");
    throw new GatewayClientError(
      "gateway_error",
      "read device work source failed"
    );
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
    method: "POST",
    headers: workVaultHeaders(token, input.vaultId, input.mediaType),
    body: input.body,
  });
  await readJson<Record<string, unknown>>(
    res,
    `submit ${input.variant} derivative`
  );
}
