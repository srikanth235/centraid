// Pairing state + tunnel lifecycle for the phone ↔ gateway link (issue #263).
//
// Two ticket shapes, one Settings entry point:
//
// 1. Desktop "Connect phone" QR — JSON `{v:1, kind:'centraid-pair', ticket, code}`
//    redeemed over `centraid/pair/1` (pairWithDesktop).
// 2. Headless VPS ticket — base64url JSON `{v:1, kind:'centraid-gw-pair', gw, t, s, …}`
//    from `centraid-gateway pair` / `pair --qr`, redeemed over `centraid/gw-pair/1`
//    (pairWithGateway). The stored tunnel ticket is `gw` (gateway EndpointTicket).
//
// From then on `ensureTunnelStarted()` runs a localhost HTTP proxy — everything
// rides the iroh tunnel; the gateway/desktop attaches auth on its side.

import { Platform } from 'react-native';
import {
  addTunnelStatusListener,
  generateSecretKey,
  getTunnelStatus,
  isTunnelAvailable,
  pairWithDesktop,
  pairWithGateway,
  startTunnel,
  stopTunnel,
} from '../../modules/centraid-tunnel';
import type { TunnelStatus } from '../../modules/centraid-tunnel';
import { getSecure, hydrateSecure, setSecure } from './secure-storage';
import { Store } from '../storage';
import { parsePairingInput } from './phone-link-parse';

export { parsePairingInput, parsePairQr } from './phone-link-parse';
export type { DesktopPairPayload, GatewayPairPayload, PairingInput } from './phone-link-parse';

export const LINK_TICKET_KEY = 'phoneLink.ticket';
export const LINK_DESKTOP_NAME_KEY = 'phoneLink.desktopName';
export const LINK_DEVICE_ID_KEY = 'phoneLink.deviceId';
export const LINK_SECRET_KEY = 'phoneLink.secretKey';

export class PhoneLinkError extends Error {
  constructor(
    public readonly kind: 'invalid_qr' | 'module_unavailable' | 'pair_failed' | 'tunnel_failed',
    message: string,
  ) {
    super(message);
    this.name = 'PhoneLinkError';
  }
}

/** Pull link prefs into Store + secrets into secure storage. Idempotent. */
export async function hydratePhoneLink(): Promise<void> {
  await Promise.all([
    hydrateSecure(LINK_TICKET_KEY, ''),
    Store.hydrate<string>(LINK_DESKTOP_NAME_KEY, ''),
    Store.hydrate<string>(LINK_DEVICE_ID_KEY, ''),
    hydrateSecure(LINK_SECRET_KEY, ''),
  ]);
}

export function isPaired(): boolean {
  return Boolean(getSecure(LINK_TICKET_KEY, '') && getSecure(LINK_SECRET_KEY, ''));
}

export function getDesktopName(): string {
  return Store.get<string>(LINK_DESKTOP_NAME_KEY, '');
}

/**
 * Pair from a scanned QR payload or a pasted ticket. Accepts desktop
 * `centraid-pair` JSON and headless `centraid-gw-pair` one-liners.
 */
export async function pair(
  qrPayloadString: string,
  deviceName: string,
): Promise<{ desktopName: string; deviceId: string }> {
  const parsed = parsePairingInput(qrPayloadString);
  if (!parsed) {
    throw new PhoneLinkError(
      'invalid_qr',
      'That is not a Centraid pairing code. Scan the desktop QR, or paste a ticket from `centraid-gateway pair`.',
    );
  }
  if (parsed.kind === 'centraid-gw-pair' && parsed.exp <= Date.now()) {
    throw new PhoneLinkError(
      'invalid_qr',
      'This pairing ticket has expired — mint a new one on the gateway.',
    );
  }
  if (!isTunnelAvailable()) {
    throw new PhoneLinkError(
      'module_unavailable',
      'Pairing needs the native tunnel module — use a development build, not Expo Go.',
    );
  }
  await hydratePhoneLink();
  let secretKeyB64 = getSecure(LINK_SECRET_KEY, '');
  if (!secretKeyB64) {
    secretKeyB64 = await generateSecretKey();
    await setSecure(LINK_SECRET_KEY, secretKeyB64);
  }

  if (parsed.kind === 'centraid-pair') {
    const result = await pairWithDesktop({
      code: parsed.code,
      deviceName,
      platform: Platform.OS,
      secretKeyB64,
      ticket: parsed.ticket,
    });
    if (!result.ok || !result.deviceId) {
      throw new PhoneLinkError(
        'pair_failed',
        result.error ?? 'Pairing was refused by the desktop.',
      );
    }
    await setSecure(LINK_TICKET_KEY, parsed.ticket);
    const desktopName = result.desktopName ?? '';
    Store.set<string>(LINK_DESKTOP_NAME_KEY, desktopName);
    Store.set<string>(LINK_DEVICE_ID_KEY, result.deviceId);
    return { desktopName, deviceId: result.deviceId };
  }

  // Headless gateway ticket.
  const result = await pairWithGateway({
    ticket: parsed.gw,
    ticketId: parsed.t,
    secret: parsed.s,
    deviceName,
    platform: Platform.OS,
    secretKeyB64,
  });
  if (!result.ok) {
    throw new PhoneLinkError('pair_failed', result.error ?? 'Pairing was refused by the gateway.');
  }
  // Tunnel dials the gateway EndpointTicket embedded in the pairing token.
  await setSecure(LINK_TICKET_KEY, parsed.gw);
  const desktopName = result.vaultName || result.gatewayName || parsed.vaultName || 'Gateway';
  const deviceId = result.enrollmentId || result.gatewayId || result.deviceId || 'gateway';
  Store.set<string>(LINK_DESKTOP_NAME_KEY, desktopName);
  Store.set<string>(LINK_DEVICE_ID_KEY, deviceId);
  return { desktopName, deviceId };
}

/**
 * Forget the desktop/gateway link. Keeps the device secret key so a future re-pair
 * presents the same EndpointId (the peer can also revoke it by name).
 */
export async function unpair(): Promise<void> {
  if (isTunnelAvailable()) {
    await stopTunnel().catch(() => {
      /* already stopped */
    });
  }
  await setSecure(LINK_TICKET_KEY, '');
  Store.set<string>(LINK_DESKTOP_NAME_KEY, '');
  Store.set<string>(LINK_DEVICE_ID_KEY, '');
}

// Deduplicate concurrent starts (Home + AppDetail can race on mount).
let startInFlight: Promise<{ baseUrl: string } | undefined> | undefined;

/**
 * Start (or reuse) the localhost tunnel proxy for the paired peer.
 * Resolves the base URL every WebView + RN fetch should use. Returns
 * `undefined` when unpaired or when the native module is unavailable
 * (Expo Go); throws PhoneLinkError when a start attempt fails.
 */
export async function ensureTunnelStarted(): Promise<{ baseUrl: string } | undefined> {
  if (startInFlight) return startInFlight;
  startInFlight = (async () => {
    await hydratePhoneLink();
    if (!isPaired() || !isTunnelAvailable()) return undefined;
    const status = await getTunnelStatus();
    if (status.state === 'running' && status.port) {
      return { baseUrl: `http://127.0.0.1:${status.port}` };
    }
    try {
      const { port } = await startTunnel({
        secretKeyB64: getSecure(LINK_SECRET_KEY, ''),
        ticket: getSecure(LINK_TICKET_KEY, ''),
      });
      return { baseUrl: `http://127.0.0.1:${port}` };
    } catch (err) {
      throw new PhoneLinkError(
        'tunnel_failed',
        `Could not reach your gateway: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();
  try {
    return await startInFlight;
  } finally {
    startInFlight = undefined;
  }
}

/** Status subscription passthrough — no-op remover when the module is unavailable. */
export function subscribeTunnelStatus(cb: (status: TunnelStatus) => void): { remove(): void } {
  if (!isTunnelAvailable()) {
    return {
      remove: () => {
        /* noop */
      },
    };
  }
  return addTunnelStatusListener(cb);
}

export { getTunnelStatus, isTunnelAvailable };
export type { TunnelStatus };
