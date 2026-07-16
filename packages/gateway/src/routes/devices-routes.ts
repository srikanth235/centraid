/*
 * `GET/DELETE /centraid/_gateway/devices` — the paired-device roster + its
 * revoke gesture over HTTP (issue #376), the wire twin of `cli/device-admin.ts`'s
 * `devices list` / `devices revoke`. Backs the desktop's Gateway → Devices card.
 *
 * `POST /centraid/_gateway/devices/ticket` — the inverse of revoke: MINT a
 * one-time pairing ticket from the app, the HTTP twin of `centraid-gateway
 * pair`. Same caller-plane scope; the target vault is `body.vaultId` or the
 * addressed `x-centraid-vault`. Requires the daemon's iroh endpoint (the
 * ticket's `gw` pin) — 409 `no_iroh_endpoint` when absent.
 *
 * Scope is caller-plane, NOT admin-only — the browser PWA shell authorizes as
 * the DEVICE plane (a per-device HTTP token, `device-token-store.ts`), and a
 * user must be able to see + revoke their own device from that shell. The
 * app-engine HTTP server stamps the caller's device key onto
 * `AUTHED_DEVICE_HEADER` after a device-token auth (absent for the landlord's
 * shared admin bearer):
 *
 *   - device caller  → limited to the vaults that key is enrolled in;
 *   - admin caller   → every vault (the landlord sees the whole roster).
 *
 * The revoke cascade mirrors device-admin.ts exactly: revoke the enrollment
 * row(s), then kill the per-device HTTP token of any key that no longer holds
 * ANY enrollment (a key that still opens another vault keeps its token — that
 * is "leave this vault", not "kill the device"). Live web control/app cookies
 * die on their next request via `web-app-sessions.ts`'s `isDeviceValid`
 * re-check against `enrollments.isEnrolled`, which this cascade flips — no
 * extra wiring needed here.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AUTHED_DEVICE_HEADER } from '@centraid/app-engine';
import type { RouteHandler } from '../serve/build-gateway.js';
import type {
  DeviceComputeCapabilities,
  DeviceComputeProfile,
  EnrollmentStore,
  DeviceEnrollment,
} from '../serve/enrollment-store.js';
import type { DeviceTokenStore } from '../serve/device-token-store.js';
import type { PairingTicketStore } from '../serve/pairing-store.js';
import { encodePairingTicket, DEFAULT_TICKET_TTL_MS } from '../serve/pairing-store.js';
import { readJson, sendJson } from './route-helpers.js';

const DEVICES_PATH = '/centraid/_gateway/devices';
const DEVICES_TICKET_PATH = `${DEVICES_PATH}/ticket`;
/** The canonical vault-addressing header (mirrors the client's `VAULT_HEADER`). */
const VAULT_HEADER = 'x-centraid-vault';

/**
 * One paired device on the wire (mirrors the client's `CentraidGatewayDevice`
 * in `@centraid/client`'s `gateway-client-devices.ts` — kept in step by hand,
 * the gateway does not depend on the client package).
 */
interface DeviceDTO {
  deviceId: string;
  endpointId: string;
  label: string;
  platform?: string;
  transport: 'iroh' | 'http';
  vaultId: string;
  vaultName?: string;
  addedAt?: string;
  lastUsedAt?: string;
  current?: boolean;
  trust: 'full' | 'readonly' | 'revoked';
  rememberDevice: boolean;
  compute?: DeviceComputeProfile;
  checkpoint?: {
    epoch: string;
    seq: number;
    schemaEpoch: number;
    updatedAt: string;
  };
}

export interface DevicesRouteDeps {
  enrollments: EnrollmentStore;
  deviceTokens: DeviceTokenStore;
  /** One-time pairing-ticket mint store — the `POST /devices/ticket` twin of `pair`. */
  tickets: PairingTicketStore;
  /** Resolves a vault id to its owner-facing name; undefined when unknown. */
  vaultName: (vaultId: string) => string | undefined;
  /**
   * The gateway's iroh EndpointTicket (identity pin + relay hint) for a minted
   * ticket's `gw` field, read lazily at mint time; undefined before the daemon
   * has an endpoint (or on the desktop embed).
   */
  endpointTicket?: () => string | undefined;
  /** Purge vault-local protocol state owned by removed enrollment rows. */
  onRevoked?: (rows: DeviceEnrollment[]) => void;
}

/** The caller's device key when it authorized as the device plane, else undefined (admin). */
function callerDeviceKey(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function makeDevicesRouteHandler(deps: DevicesRouteDeps): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');
    if (url.pathname !== DEVICES_PATH && !url.pathname.startsWith(`${DEVICES_PATH}/`)) {
      return false;
    }

    const callerKey = callerDeviceKey(req);
    // undefined = admin (every vault allowed); a Set = the device's enrollments.
    const allowedVaults =
      callerKey === undefined ? undefined : new Set(deps.enrollments.vaultsFor(callerKey));
    const isAllowed = (vaultId: string): boolean =>
      allowedVaults === undefined || allowedVaults.has(vaultId);

    const method = req.method ?? 'GET';

    if (url.pathname === DEVICES_PATH) {
      if (method !== 'GET') {
        return sendJson(res, 405, { error: 'method_not_allowed' });
      }
      const tokens = deps.deviceTokens.list();
      const lastUsedFor = (endpointId: string): string | undefined =>
        tokens.find((t) => t.deviceKey === endpointId)?.lastUsedAt;
      const devices = deps.enrollments
        .list()
        .filter((row) => isAllowed(row.vaultId))
        .map((row) => toDto(row, deps, callerKey, lastUsedFor(row.endpointId)))
        .sort(compareDevices);
      return sendJson(res, 200, { devices });
    }

    // POST /centraid/_gateway/devices/ticket — mint a one-time pairing ticket
    // (the inverse of revoke; the wire twin of `cli/device-admin.ts`'s `pair`).
    // Matched BEFORE the DELETE `/:id` branch so `ticket` isn't read as an id.
    if (url.pathname === DEVICES_TICKET_PATH) {
      if (method !== 'POST') {
        return sendJson(res, 405, { error: 'method_not_allowed' });
      }
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid_body' });
      }
      // Target vault: explicit `body.vaultId`, else the addressed-vault header
      // the shell/web control session stamps on every request.
      const headerVault = req.headers[VAULT_HEADER];
      const target =
        typeof body.vaultId === 'string'
          ? body.vaultId
          : typeof headerVault === 'string'
            ? headerVault
            : undefined;
      if (target === undefined) {
        return sendJson(res, 400, { error: 'vault_required' });
      }
      // Scope + existence guard (no existence leak — a device caller outside
      // the vault, or an unknown vault, both 404 the same way).
      if (!isAllowed(target) || deps.vaultName(target) === undefined) {
        return sendJson(res, 404, { error: 'not_found' });
      }
      const ttlMs =
        typeof body.ttlMinutes === 'number' && body.ttlMinutes > 0
          ? body.ttlMinutes * 60_000
          : DEFAULT_TICKET_TTL_MS;
      // `gw` is required in `PairingTicketPayload`; a ticket without the iroh
      // endpoint pin can't be redeemed, so refuse rather than mint a dud.
      const gw = deps.endpointTicket?.();
      if (gw === undefined) {
        return sendJson(res, 409, {
          error: 'no_iroh_endpoint',
          message:
            'gateway has no iroh endpoint identity yet — start the daemon so it mints its endpoint',
        });
      }
      const minted = deps.tickets.mint(target, ttlMs);
      const token = encodePairingTicket({
        v: 1,
        kind: 'centraid-gw-pair',
        gw,
        t: minted.ticketId,
        s: minted.secret,
        vaultName: deps.vaultName(target) ?? target,
        exp: minted.expiresAt,
      });
      return sendJson(res, 200, {
        ok: true,
        ticket: token,
        vaultId: target,
        vaultName: deps.vaultName(target),
        expiresAt: new Date(minted.expiresAt).toISOString(),
      });
    }

    // PUT /centraid/_gateway/devices/:enrollmentId/compute — advertise what
    // this device can do and opt it into charging + unmetered work leases.
    if (url.pathname.endsWith('/compute')) {
      if (method !== 'PUT') return sendJson(res, 405, { error: 'method_not_allowed' });
      const enrollmentId = decodeURIComponent(
        url.pathname.slice(`${DEVICES_PATH}/`.length, -'/compute'.length),
      );
      const target = deps.enrollments.list().find((row) => row.enrollmentId === enrollmentId);
      if (!target || !isAllowed(target.vaultId)) {
        return sendJson(res, 404, { error: 'not_found' });
      }
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return sendJson(res, 400, { error: 'invalid_body' });
      }
      const compute = parseComputeProfile(body);
      if (!compute) {
        return sendJson(res, 400, {
          error: 'invalid_compute_profile',
          message: 'contribution preference and every capability must be boolean',
        });
      }
      const updated = deps.enrollments.setCompute(enrollmentId, compute);
      return sendJson(res, 200, { device: toDto(updated, deps, callerKey, undefined) });
    }

    // /centraid/_gateway/devices/:enrollmentId
    const enrollmentId = decodeURIComponent(url.pathname.slice(`${DEVICES_PATH}/`.length));
    if (method !== 'DELETE') {
      return sendJson(res, 405, { error: 'method_not_allowed' });
    }
    if (!enrollmentId) return false;

    // Refuse to touch — or even acknowledge — an enrollment outside the
    // caller's allowed vaults (don't leak another vault's device existence).
    const target = deps.enrollments.list().find((row) => row.enrollmentId === enrollmentId);
    if (target && !isAllowed(target.vaultId)) {
      return sendJson(res, 404, { error: 'not_found' });
    }

    const removed = deps.enrollments.revoke(enrollmentId);
    if (removed.length === 0) {
      // Already gone — idempotent, not an error.
      return sendJson(res, 200, { removed: false });
    }
    deps.onRevoked?.(removed);
    // A device key that no longer holds ANY enrollment loses its HTTP token
    // too (mirrors device-admin.ts): the ACL bit is gone; the token dies with
    // it. A key still holding another vault's row keeps its token.
    const deadKeys = new Set(
      removed.map((r) => r.endpointId).filter((key) => !deps.enrollments.isEnrolled(key)),
    );
    for (const key of deadKeys) deps.deviceTokens.revokeForDeviceKey(key);
    return sendJson(res, 200, { removed: true });
  };
}

function toDto(
  row: DeviceEnrollment,
  deps: DevicesRouteDeps,
  callerKey: string | undefined,
  lastUsedAt: string | undefined,
): DeviceDTO {
  const vaultName = deps.vaultName(row.vaultId);
  return {
    deviceId: row.enrollmentId,
    endpointId: row.endpointId,
    label: row.label,
    ...(row.platform !== undefined ? { platform: row.platform } : {}),
    transport: row.endpointId.startsWith('http:') ? 'http' : 'iroh',
    vaultId: row.vaultId,
    ...(vaultName !== undefined ? { vaultName } : {}),
    addedAt: row.addedAt,
    ...(lastUsedAt !== undefined ? { lastUsedAt } : {}),
    current: callerKey !== undefined && row.endpointId === callerKey,
    trust: row.trust,
    rememberDevice: row.rememberDevice,
    ...(row.compute ? { compute: row.compute } : {}),
    ...(row.checkpoint ? { checkpoint: row.checkpoint } : {}),
  };
}

const COMPUTE_KEYS: readonly (keyof DeviceComputeCapabilities)[] = [
  'previews',
  'poster',
  'pdfText',
  'ocr',
  'embedding',
  'transcript',
  'edgeSeal',
  'backgroundTransfer',
];

function parseComputeProfile(
  body: Record<string, unknown>,
): Omit<DeviceComputeProfile, 'updatedAt'> | undefined {
  if (
    typeof body.contributeWhileCharging !== 'boolean' ||
    typeof body.capabilities !== 'object' ||
    body.capabilities === null
  ) {
    return undefined;
  }
  const raw = body.capabilities as Record<string, unknown>;
  if (!COMPUTE_KEYS.every((key) => typeof raw[key] === 'boolean')) return undefined;
  return {
    contributeWhileCharging: body.contributeWhileCharging,
    capabilities: Object.fromEntries(
      COMPUTE_KEYS.map((key) => [key, raw[key]]),
    ) as unknown as DeviceComputeCapabilities,
  };
}

/** Current device first, then by label (locale compare). */
function compareDevices(a: DeviceDTO, b: DeviceDTO): number {
  if (a.current && !b.current) return -1;
  if (b.current && !a.current) return 1;
  return a.label.localeCompare(b.label);
}
