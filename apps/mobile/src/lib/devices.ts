// Devices roster client (#765). Gateway-plane: authorization is the iroh
// forwarder's proved caller identity, so `apiHeaders()` rides along inert.
// Scope is ownership (#726) — no person or role is typed here. Wire shapes are
// lean local mirrors; mobile imports no server or client package.

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
  /** The revocation handle — the enrollment row, not the hardware. */
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
  /** A tombstone, never a role; revoked rows stay so attribution resolves. */
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

/** No device plane 404s as a `GatewayError`; never soften that into an empty
 * roster. */
export async function listDevices(): Promise<DeviceRow[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ devices?: DeviceRow[] }>(
    `${base}/centraid/_gateway/devices`,
    { headers: apiHeaders(), method: "GET" }
  );
  return body.devices ?? [];
}

/** `undefined` (not `[]`) when no vault plane is mounted; `[]` would say
 * "you own none". */
export async function listOwnedVaults(): Promise<VaultRow[] | undefined> {
  return listVaults();
}

/** No argument carries every vault the owner owns; `vaultId` narrows to one.
 * 409 `no_iroh_endpoint` means the gateway cannot be paired into. */
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

/** Revoking the LAST live device strands the vault behind filesystem-only
 * recovery, so the gateway 409s unless `confirmVaultName` echoes the vault
 * name — which the member must type, never the screen. */
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
