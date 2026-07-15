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
} from './gateway-client-core.js';

/** One paired device (mirrors the gateway route's `DeviceDTO`). */
export interface CentraidGatewayDevice {
  /** The revocation handle (the enrollment row id). */
  deviceId: string;
  /** The device's key (iroh EndpointId, or a synthetic `http:<uuid>`). */
  endpointId: string;
  label: string;
  platform?: string;
  transport: 'iroh' | 'http';
  vaultId: string;
  vaultName?: string;
  addedAt?: string;
  lastUsedAt?: string;
  /** True for the device making the request (never set for the admin caller). */
  current?: boolean;
  /** Server-enforced device tier used to clamp replica shapes and intents. */
  trust: 'full' | 'readonly' | 'revoked';
  /** Whether this device consented to durable OPFS/IndexedDB state. */
  rememberDevice: boolean;
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
  vaultId: string;
  vaultName?: string;
  /** Ticket expiry, ISO-8601. */
  expiresAt: string;
}

/**
 * Mint a device-pairing ticket from the app (the operator twin of
 * `centraid-gateway pair`). The gateway scopes it to the caller's plane and
 * defaults the target vault to the active `x-centraid-vault` when none is given.
 */
export async function createGatewayDeviceTicket(input?: {
  vaultId?: string;
  ttlMinutes?: number;
  label?: string;
}): Promise<GatewayDeviceTicket> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, '/centraid/_gateway/devices/ticket', {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(input ?? {}),
  });
  return readJson<GatewayDeviceTicket & { ok: true }>(res, 'mint pairing ticket');
}

/** Revoke one paired device (cascades its HTTP token). Idempotent — `removed:false` when already gone. */
export async function revokeGatewayDevice(deviceId: string): Promise<{ removed: boolean }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_gateway/devices/${enc(deviceId)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  return readJson<{ removed: boolean }>(res, 'revoke device');
}
