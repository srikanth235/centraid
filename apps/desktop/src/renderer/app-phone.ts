// The Settings → Phone page (issue #263) — the "Connect phone" surface for
// the iroh tunnel. Pairing is a one-time QR: the phone scans
// `{ticket, code}`, dials the desktop over p2p QUIC, and its EndpointId
// lands in the device allowlist. Devices listed here are named, per-device,
// and revocable — revoking drops live connections at the transport.
//
// Everything talks to the main process (`main/phone-link.ts`) over IPC: the
// tunnel endpoint holds the persistent desktop key and must outlive
// renderer reloads. The React PhoneScreen owns the view; this module threads
// the IPC + the onPhonePaired subscription through its bridge callbacks.

import { requireReactBridge } from './react/bridge.js';

export interface PhonePageInput {
  el: ElHelper;
  host: HTMLElement;
  showToast?: (message: string) => void;
}

// Tracks the React root mounted on a host so a re-render disposes the prior one.
const phoneReactDisposers = new WeakMap<HTMLElement, () => void>();

/** Populate the Phone page. Re-renders itself after pairing/revocation. */
export async function renderPhonePage(input: PhonePageInput): Promise<void> {
  const { host } = input;
  phoneReactDisposers.get(host)?.();
  const dispose = requireReactBridge().mountPhone(host, {
    beginPairing: async (onPaired) => {
      const pairing = await window.CentraidApi.beginPhonePairing().catch(() => undefined);
      if (!pairing) return null;
      const stop = window.CentraidApi.onPhonePaired(({ device }) => {
        stop();
        onPaired(device.name);
      });
      return {
        cancel: () => {
          stop();
          void window.CentraidApi.cancelPhonePairing();
        },
        info: { expiresAt: pairing.expiresAt, qrDataUrl: pairing.qrDataUrl },
      };
    },
    loadStatus: async () => {
      const s = await window.CentraidApi.getPhoneLinkStatus().catch(() => undefined);
      if (!s) return null;
      return {
        devices: s.devices.map((d) => ({
          addedAt: d.addedAt,
          deviceId: d.deviceId,
          endpointId: d.endpointId,
          name: d.name,
          platform: d.platform,
        })),
        error: s.error,
        running: s.running,
      };
    },
    revoke: async (deviceId) => {
      const result = await window.CentraidApi.revokePhoneDevice({ deviceId }).catch(
        () => undefined,
      );
      return result?.removed ?? false;
    },
    showToast: input.showToast,
  });
  phoneReactDisposers.set(host, dispose);
}
