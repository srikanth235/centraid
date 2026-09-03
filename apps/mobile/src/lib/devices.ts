import {
  apiHeaders,
  fetchJson,
  listVaults,
  requireGatewayBase,
} from "./gateway";
import type { VaultRow } from "./gateway";

export interface DeviceComputeProfile {
  contributeWhileCharging: boolean;
  capabilities: {
    previews: boolean;
    poster: boolean;
    pdfText: boolean;
    ocr: boolean;
    embedding: boolean;
    transcript: boolean;
    edgeSeal: boolean;
    backgroundTransfer: boolean;
  };
  updatedAt: string;
}

export interface DeviceRow {
  deviceId: string;
  endpointId: string;
  ownerId: string;
  ownerLabel: string;
  label: string;
  platform?: string;
  vaultId: string;
  vaultName?: string;
  addedAt?: string;
  current?: boolean;
  revoked: boolean;
  rememberDevice: boolean;
  compute?: DeviceComputeProfile;
  checkpoint?: {
    epoch: string;
    seq: number;
    schemaEpoch: number;
    updatedAt: string;
  };
}

export interface DeviceTicketVault {
  vaultId: string;
  vaultName?: string;
}

export interface DeviceTicket {
  ticket: string;
  ownerId: string;
  ownerLabel: string;
  vaults: DeviceTicketVault[];
  vaultId: string;
  vaultName?: string;
  expiresAt: string;
}

export async function listDevices(): Promise<DeviceRow[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ devices?: DeviceRow[] }>(
    `${base}/centraid/_gateway/devices`,
    { headers: apiHeaders(), method: "GET" }
  );
  return body.devices ?? [];
}

export async function listOwnedVaults(): Promise<VaultRow[] | undefined> {
  return listVaults();
}

export async function mintDeviceTicket(input?: {
  vaultId?: string;
  ttlMinutes?: number;
}): Promise<DeviceTicket> {
  const base = await requireGatewayBase();
  return fetchJson<DeviceTicket>(`${base}/centraid/_gateway/devices/ticket`, {
    body: JSON.stringify(input ?? {}),
    headers: apiHeaders({ "content-type": "application/json" }),
    method: "POST",
  });
}

export async function renameDevice(
  deviceId: string,
  label: string
): Promise<DeviceRow> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ device: DeviceRow }>(
    `${base}/centraid/_gateway/devices/${encodeURIComponent(deviceId)}`,
    {
      body: JSON.stringify({ label }),
      headers: apiHeaders({ "content-type": "application/json" }),
      method: "PATCH",
    }
  );
  return body.device;
}

export async function revokeDevice(
  deviceId: string,
  confirmVaultName?: string
): Promise<{ removed: boolean }> {
  const base = await requireGatewayBase();
  return fetchJson<{ removed: boolean }>(
    `${base}/centraid/_gateway/devices/${encodeURIComponent(deviceId)}`,
    {
      body: JSON.stringify(
        confirmVaultName === undefined
          ? {}
          : { confirmLastDevice: confirmVaultName }
      ),
      headers: apiHeaders({ "content-type": "application/json" }),
      method: "DELETE",
    }
  );
}
