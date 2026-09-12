// Phone link (#263): the desktop side of the iroh tunnel.
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
//
// A PAIRED PHONE IS ALSO AN ENROLMENT (#1015, ruling R-NY-18). `devices.json`
// is the transport allowlist and nothing more; the vault doors read the
// gateway's enrolment store, and since a tunnelled phone now reaches them as
// ITSELF rather than as the host, both gestures here have a second half:
// pairing vouches for the phone's EndpointId, revoking tombstones it.

import os from "node:os";
import path from "node:path";

import { app, BrowserWindow } from "electron";
import QRCode from "qrcode";

import {
  DeviceStore,
  loadEndpointSecret,
  startPreferredDesktopTunnel,
} from "@centraid/tunnel";
import type { DesktopTunnelHandle, PairedDevice } from "@centraid/tunnel";

import { deviceIrohKeyPersistence } from "./gateway-secrets.js";
import { vouchPhoneDevice } from "./phone-link-vouch-core.js";
import type { VouchUpstream } from "./phone-link-vouch-core.js";
import { loadSettings } from "./settings.js";

export const PHONE_PAIRED_CHANNEL = "centraid:phone:paired";

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
  return path.join(app.getPath("userData"), "phone-link");
}

function deviceStore(): DeviceStore {
  store ??= DeviceStore.open(path.join(phoneLinkDir(), "devices.json"));
  return store;
}

/**
 * Start the tunnel endpoint (idempotent). Called on app ready so the
 * "Connect phone" panel opens with the endpoint already listening, and so
 * previously paired phones can reconnect without any UI open.
 */
/** The local gateway, or `undefined` while a remote one is active. */
async function localUpstream(): Promise<VouchUpstream | undefined> {
  const settings = await loadSettings();
  if (settings.activeGatewayKind !== "local") return undefined;
  if (!(settings.gatewayUrl && settings.gatewayToken)) return undefined;
  return {
    baseUrl: settings.gatewayUrl.replace(/\/+$/u, ""),
    token: settings.gatewayToken,
  };
}

export async function ensurePhoneLink(): Promise<DesktopTunnelHandle> {
  if (handle) return handle;
  if (starting) return starting;
  starting = (async () => {
    const started = await startPreferredDesktopTunnel({
      secretKey: loadEndpointSecret({
        persistence: deviceIrohKeyPersistence("phone-link"),
        onCorrupt: "remint",
        label: "desktop phone-link device key",
        warn: (message) => console.warn(`phone link: ${message}`),
      }),
      deviceStore: deviceStore(),
      desktopName: os.hostname().replace(/\.local$/u, ""),
      upstream: localUpstream,
      onPaired: (device) => {
        // The enrolment the QR gesture owes the vault doors (#1015, R-NY-18).
        // A refusal is logged, never thrown: the phone is paired at the
        // transport either way, and the panel would have nowhere to put an
        // exception raised inside the tunnel's own callback.
        void (async () => {
          const answer = await vouchPhoneDevice(await localUpstream(), {
            action: "enrol",
            endpointId: device.endpointId,
            label: device.name,
            platform: device.platform,
          });
          if (!answer.ok) {
            console.warn(
              `phone link: the gateway did not enrol ${device.name} (${answer.error ?? answer.status})`
            );
          }
        })();
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
  } catch (error) {
    startError = error instanceof Error ? error.message : String(error);
    throw error;
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
    errorCorrectionLevel: "M",
    margin: 1,
    width: 512,
  });
  return {
    payload: pairing.qrPayload,
    qrDataUrl,
    expiresAt: pairing.expiresAt,
  };
}

export function cancelPhonePairing(): void {
  handle?.cancelPairing();
}

export async function revokePhoneDevice(
  deviceId: string
): Promise<PairedDevice | undefined> {
  // The tunnel handle also drops the device's live connections; fall back
  // to a plain store removal if the endpoint never came up.
  const removed = handle
    ? handle.revokeDevice(deviceId)
    : deviceStore().remove(deviceId);
  if (!removed) return undefined;
  // THE SECOND HALF (#1015, R-NY-18): the transport row is gone, so this
  // phone can no longer dial in — but a phone is its own principal at the
  // vault doors now, and "revoked" has to be true in the store those doors
  // read, whichever way the device comes back. Awaited, unlike the enrolment
  // above: a revoke the member asked for must not race the answer they get.
  const answer = await vouchPhoneDevice(await localUpstream(), {
    action: "revoke",
    endpointId: removed.endpointId,
  });
  if (!answer.ok) {
    console.warn(
      `phone link: the gateway did not tombstone ${removed.name} (${answer.error ?? answer.status})`
    );
  }
  return removed;
}

export async function shutdownPhoneLink(): Promise<void> {
  const current = handle;
  handle = undefined;
  await current?.close().catch(() => undefined);
}
