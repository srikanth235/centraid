// Pairing state + tunnel lifecycle for the phone ↔ desktop link (issue #263).
//
// The phone never holds a gateway bearer. Pairing scans the desktop's
// "Connect phone" QR ({v:1, kind:'centraid-pair', ticket, code}), dials the
// pair ALPN through the native tunnel module, and stores the ticket + this
// device's secret key. From then on `ensureTunnelStarted()` runs a localhost
// HTTP proxy — everything (documents, module imports, SSE) rides the iroh
// tunnel to the desktop, which attaches the bearer on its side.

import { Platform } from 'react-native';
import {
  addTunnelStatusListener,
  generateSecretKey,
  getTunnelStatus,
  isTunnelAvailable,
  pairWithDesktop,
  startTunnel,
  stopTunnel,
} from '../../modules/centraid-tunnel';
import type { TunnelStatus } from '../../modules/centraid-tunnel';
import { getSecure, hydrateSecure, setSecure } from './secure-storage';
import { Store } from '../storage';

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

/**
 * Parse the desktop's pairing QR payload. Local mirror of
 * `parsePairQrPayload` in packages/tunnel/src/protocol.ts — the tunnel
 * package is Node-flavored, so mobile carries its own copy of this one
 * pure function rather than importing the package.
 */
export function parsePairQr(raw: string): { ticket: string; code: string } | undefined {
  try {
    const obj = JSON.parse(raw) as Partial<{
      v: number;
      kind: string;
      ticket: string;
      code: string;
    }>;
    if (obj.v !== 1 || obj.kind !== 'centraid-pair') return undefined;
    if (typeof obj.ticket !== 'string' || typeof obj.code !== 'string') return undefined;
    return { code: obj.code, ticket: obj.ticket };
  } catch {
    return undefined;
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
 * Pair with the desktop from a scanned QR payload. Parses + validates the
 * payload, dials the pair ALPN, and persists the link on success. The
 * one-time code is consumed by the desktop and never stored on the phone.
 * The device secret key is generated once on first pair and reused across
 * re-pairs so this phone keeps a stable EndpointId.
 */
export async function pair(
  qrPayloadString: string,
  deviceName: string,
): Promise<{ desktopName: string; deviceId: string }> {
  const parsed = parsePairQr(qrPayloadString);
  if (!parsed) {
    throw new PhoneLinkError('invalid_qr', 'That QR code is not a Centraid pairing code.');
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
  const result = await pairWithDesktop({
    code: parsed.code,
    deviceName,
    platform: Platform.OS,
    secretKeyB64,
    ticket: parsed.ticket,
  });
  if (!result.ok || !result.deviceId) {
    throw new PhoneLinkError('pair_failed', result.error ?? 'Pairing was refused by the desktop.');
  }
  await setSecure(LINK_TICKET_KEY, parsed.ticket);
  Store.set<string>(LINK_DESKTOP_NAME_KEY, result.desktopName ?? '');
  Store.set<string>(LINK_DEVICE_ID_KEY, result.deviceId);
  return { desktopName: result.desktopName ?? '', deviceId: result.deviceId };
}

/**
 * Forget the desktop link. Keeps the device secret key so a future re-pair
 * presents the same EndpointId (the desktop can also revoke it by name).
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
 * Start (or reuse) the localhost tunnel proxy for the paired desktop.
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
        `Could not reach your desktop: ${err instanceof Error ? err.message : String(err)}`,
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
