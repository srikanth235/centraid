// Mobile devices client — the roster behind the Devices place (#765).
//
//   GET    /centraid/_gateway/devices          → { devices: [...] }
//   POST   /centraid/_gateway/devices/ticket   → mint a one-time pairing ticket
//   PATCH  /centraid/_gateway/devices/<id>     → { label } rename
//   DELETE /centraid/_gateway/devices/<id>     → revoke (tombstone, not delete)
//
// These are GATEWAY-plane routes, not vault ones, but the phone still sends
// `apiHeaders()` — the same header set `readSelfMemberName()` in
// `lib/gateway.ts` already sends to the first of them. The gateway's real
// authorization is the iroh forwarder's proved caller identity, which the
// paired tunnel stamps on; the vault header is inert here and costs nothing.
//
// Scope is ownership (#726): a caller sees exactly the devices belonging to the
// vaults its owner owns, and every ticket it mints is a self-pair onto that
// same owner. There is no cross-person grant on this wire, so nothing in this
// file takes a person or a role — the "Add someone" mint lane exists gateway-
// side but has no mobile surface, and is deliberately not typed here.
//
// Wire shapes mirror the route's own `DeviceDTO` as lean local interfaces
// (mobile depends on neither `@centraid/server` nor `@centraid/client` — the
// `lib/insights.ts` convention). Two fields the DTO declares but `toDto` never
// emits (`lastUsedAt`, and the transport discriminator, which is always
// `iroh`) are left out rather than typed as facts the screen would then have
// to render as always-missing.
//
// The vaults section wraps the app's existing `listVaults` rather than issuing
// its own registry read — one listing, which the Vaults switcher and this
// screen agree about by construction. Its row type stays where it is defined
// (`VaultRow` in `lib/gateway.ts`); a screen naming it imports it from there,
// so there is exactly one declaration and no re-export to drift.

import {
  apiHeaders,
  fetchJson,
  listVaults,
  requireGatewayBase,
} from "./gateway";
import type { VaultRow } from "./gateway";

/** What a device can be asked to compute, when it offers to help at all. */
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

/** One paired device (the route's `DeviceDTO`). */
export interface DeviceRow {
  /** The revocation handle — the enrollment row's id, not the hardware's. */
  deviceId: string;
  /** The device's key: an iroh EndpointId. */
  endpointId: string;
  /** The person this device acts as (#726); the roster groups on it. */
  ownerId: string;
  /** That person's display label, denormalized so a roster needs one call. */
  ownerLabel: string;
  label: string;
  platform?: string;
  vaultId: string;
  vaultName?: string;
  addedAt?: string;
  /** True for the phone making the request — "this device", in the roster. */
  current?: boolean;
  /** A tombstone, never a role: the person keeps their access, this binding
   *  just stops answering. Revoked rows stay so past attribution resolves. */
  revoked: boolean;
  /** Whether the device consented to durable local state. */
  rememberDevice: boolean;
  compute?: DeviceComputeProfile;
  checkpoint?: {
    epoch: string;
    seq: number;
    schemaEpoch: number;
    updatedAt: string;
  };
}

/** One vault a freshly minted ticket carries. */
export interface DeviceTicketVault {
  vaultId: string;
  vaultName?: string;
}

/** A one-time pairing ticket — what the other device scans or pastes. */
export interface DeviceTicket {
  /** The pasteable one-line token. */
  ticket: string;
  ownerId: string;
  ownerLabel: string;
  /** Every vault the ticket carries; the first is echoed flat below. */
  vaults: DeviceTicketVault[];
  vaultId: string;
  vaultName?: string;
  /** ISO-8601. A ticket is short-lived by design. */
  expiresAt: string;
}

/**
 * Every device the caller may see, in the gateway's own ordering.
 *
 * A gateway with no device plane at all answers 404 here, which surfaces as a
 * `GatewayError` like any other failed read — this does NOT quietly become an
 * empty roster. An empty roster and an absent device plane are different
 * facts, and the screen's error state can say which without guessing.
 */
export async function listDevices(): Promise<DeviceRow[]> {
  const base = await requireGatewayBase();
  const body = await fetchJson<{ devices?: DeviceRow[] }>(
    `${base}/centraid/_gateway/devices`,
    { headers: apiHeaders(), method: "GET" }
  );
  return body.devices ?? [];
}

/**
 * The vaults this owner owns — the same registry read the Vaults switcher
 * makes, wrapped so the Devices screen has one import site.
 *
 * `undefined` (not `[]`) when the gateway mounts no vault plane at all: that
 * is a valid deployment, and the section simply does not render. An empty
 * array would say "you own none", which is a different sentence.
 */
export async function listOwnedVaults(): Promise<VaultRow[] | undefined> {
  return listVaults();
}

/**
 * Mint a pairing ticket from the phone (the operator twin of
 * `centraid-gateway pair`). With no argument the ticket carries every vault
 * the caller's owner owns; naming `vaultId` lands it on that one.
 *
 * The gateway 409s `no_iroh_endpoint` when the daemon has no endpoint to pin
 * the ticket to — a desktop-embedded gateway cannot be paired into at all.
 */
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

/** Rename one device. The label is the person's word for it, never the OS's. */
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

/**
 * Revoke one device — "this phone was stolen". Idempotent: `removed:false`
 * when the enrollment was already gone.
 *
 * Revoking the owner's LAST live device for a vault strands that vault behind
 * filesystem-only recovery, so the gateway refuses with 409 unless the vault's
 * own name is echoed back in `confirmLastDevice`. Pass `confirmVaultName` to
 * do that — the screen must have typed it from the member, never filled it in
 * on their behalf, or the confirmation has confirmed nothing.
 */
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
