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
  capability: "previews" | "poster" | "pdfText";
  contributionVariant: string | null;
  deviceId: string;
  token: string;
  expiresAt: string;
  attempt: number;
}

export interface GatewayDeviceVault {
  vaultId: string;
  vaultName?: string;
}

export interface CentraidGatewayDevice {
  deviceId: string;
  endpointId: string;
  ownerId: string;
  ownerLabel: string;
  label: string;
  platform?: string;
  transport: "iroh";
  vaultId: string;
  vaultName?: string;
  addedAt?: string;
  lastUsedAt?: string;
  current?: boolean;
  revoked: boolean;
  rememberDevice: boolean;
  grantProfile?: string[];
  compute?: DeviceComputeProfile;
  checkpoint?: {
    epoch: string;
    seq: number;
    schemaEpoch: number;
    updatedAt: string;
  };
}

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
    if (error instanceof GatewayClientError && error.code === "not_found")
      return [];
    throw error;
  }
}

export interface GatewayDeviceTicket {
  ticket: string;
  ownerId: string;
  ownerLabel: string;
  vaults: GatewayDeviceVault[];
  vaultId: string;
  vaultName?: string;
  expiresAt: string;
}

export interface GatewayDeviceTicketInput {
  vaultId?: string;
  vaultIds?: string[];
  forPerson?: { label: string; vaultName?: string };
  operationId?: string;
  ttlMinutes?: number;
}

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
    return out.vaults ?? [];
  } catch (error) {
    if (error instanceof GatewayClientError && error.code === "not_found")
      return [];
    throw error;
  }
}

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
