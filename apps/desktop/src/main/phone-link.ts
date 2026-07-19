// Phone link (issue #263): the desktop side of the iroh tunnel.
//
// One iroh endpoint per desktop install — its secret key persists under
// `<userData>/phone-link/key.bin`, so the desktop's EndpointId (what paired
// phones dial) is stable across launches. Paired phones live in
// `devices.json` next to it: named, EndpointId-keyed, revocable — the
// transport-level replacement for bearer-token pairing.
//
// Tunneled requests forward to the ACTIVE gateway when it is local; while a
// remote gateway is active the phone gets 503s (the phone pairs with this
// desktop, not with remote gateways). The gateway keeps binding 127.0.0.1
// and its HTTP surface is untouched.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow } from 'electron';
import {
  DeviceStore,
  startPreferredDesktopTunnel,
  type DesktopTunnelHandle,
  type PairedDevice,
} from '@centraid/tunnel';
import QRCode from 'qrcode';
import { loadSettings } from './settings.js';

export const PHONE_PAIRED_CHANNEL = 'centraid:phone:paired';

export interface PhoneLinkStatus {
  running: boolean;
  /** Base32 EndpointId phones dial — stable for this install. */
  endpointId?: string;
  error?: string;
  devices: PairedDevice[];
}

export interface PhonePairingInfo {
  /** JSON payload also encoded into the QR (manual fallback). */
  payload: string;
  /** PNG data URL for the Settings panel. */
  qrDataUrl: string;
  expiresAt: number;
}

let handle: DesktopTunnelHandle | undefined;
let starting: Promise<DesktopTunnelHandle> | undefined;
let startError: string | undefined;
let store: DeviceStore | undefined;

function phoneLinkDir(): string {
  return path.join(app.getPath('userData'), 'phone-link');
}

function readOrMintSecretKey(file: string): Uint8Array {
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length === 32) return Uint8Array.from(bytes);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, key, { mode: 0o600 });
  return Uint8Array.from(key);
}

function deviceStore(): DeviceStore {
  store ??= DeviceStore.open(path.join(phoneLinkDir(), 'devices.json'));
  return store;
}

/**
 * Start the tunnel endpoint (idempotent). Called on app ready so the
 * "Connect phone" panel opens with the endpoint already listening, and so
 * previously paired phones can reconnect without any UI open.
 */
export async function ensurePhoneLink(): Promise<DesktopTunnelHandle> {
  if (handle) return handle;
  if (starting) return starting;
  starting = (async () => {
    const started = await startPreferredDesktopTunnel({
      secretKey: readOrMintSecretKey(path.join(phoneLinkDir(), 'key.bin')),
      deviceStore: deviceStore(),
      desktopName: os.hostname().replace(/\.local$/, ''),
      upstream: async () => {
        const settings = await loadSettings();
        if (settings.activeGatewayKind !== 'local') return undefined;
        if (!(settings.gatewayUrl && settings.gatewayToken)) return undefined;
        return { baseUrl: settings.gatewayUrl.replace(/\/+$/, ''), token: settings.gatewayToken };
      },
      onPaired: (device) => {
        for (const win of BrowserWindow.getAllWindows()) {
          if (win.isDestroyed()) continue;
          win.webContents.send(PHONE_PAIRED_CHANNEL, { device });
        }
      },
    });
    handle = started;
    startError = undefined;
    return started;
  })();
  try {
    return await starting;
  } catch (err) {
    startError = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    starting = undefined;
  }
}

export async function phoneLinkStatus(): Promise<PhoneLinkStatus> {
  // Surface bind failures (e.g. an unsupported-platform NAPI binding) as a
  // status string rather than a rejected IPC — the panel renders it inline.
  if (!handle && !startError) await ensurePhoneLink().catch(() => undefined);
  return {
    running: Boolean(handle),
    ...(handle ? { endpointId: handle.endpointId } : {}),
    ...(startError ? { error: startError } : {}),
    devices: deviceStore().list(),
  };
}

export async function beginPhonePairing(): Promise<PhonePairingInfo> {
  const tunnel = await ensurePhoneLink();
  const pairing = tunnel.beginPairing();
  const qrDataUrl = await QRCode.toDataURL(pairing.qrPayload, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 512,
  });
  return { payload: pairing.qrPayload, qrDataUrl, expiresAt: pairing.expiresAt };
}

export function cancelPhonePairing(): void {
  handle?.cancelPairing();
}

export function revokePhoneDevice(deviceId: string): PairedDevice | undefined {
  // The tunnel handle also drops the device's live connections; fall back
  // to a plain store removal if the endpoint never came up.
  if (handle) return handle.revokeDevice(deviceId);
  return deviceStore().remove(deviceId);
}

export async function shutdownPhoneLink(): Promise<void> {
  const current = handle;
  handle = undefined;
  await current?.close().catch(() => undefined);
}
