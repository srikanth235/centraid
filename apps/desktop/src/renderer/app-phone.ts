// The Settings → Phone page (issue #263) — the "Connect phone" surface for
// the iroh tunnel. Pairing is a one-time QR: the phone scans
// `{ticket, code}`, dials the desktop over p2p QUIC, and its EndpointId
// lands in the device allowlist. Devices listed here are named, per-device,
// and revocable — revoking drops live connections at the transport.
//
// Everything talks to the main process (`main/phone-link.ts`) over IPC: the
// tunnel endpoint holds the persistent desktop key and must outlive
// renderer reloads.

import type { CentraidPhoneDevice } from './centraid-api.js';

export interface PhonePageInput {
  el: ElHelper;
  host: HTMLElement;
  showToast?: (message: string) => void;
}

// Tracks the React root mounted on a host so a re-render disposes the prior one.
const phoneReactDisposers = new WeakMap<HTMLElement, () => void>();

/** Populate the Phone page. Re-renders itself after pairing/revocation. */
export async function renderPhonePage(input: PhonePageInput): Promise<void> {
  const { el, host } = input;
  const note = (text: string): HTMLElement => el('div', { class: 'cd-app-settings-note' }, text);

  // Phase 3 (#325): delegate the pane to the React PhoneScreen when the bundle
  // is loaded. IPC (window.CentraidApi.*) + the onPhonePaired subscription stay
  // vanilla, threaded through the bridge callbacks; React owns the view + its
  // own load/pairing state. Vanilla builder below is the fallback.
  const bridge = window.CentraidReact;
  if (bridge?.mountPhone) {
    phoneReactDisposers.get(host)?.();
    const dispose = bridge.mountPhone(host, {
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
    return;
  }

  const status = await window.CentraidApi.getPhoneLinkStatus().catch(() => undefined);
  if (!host.isConnected) return;
  if (!status) {
    host.replaceChildren(note('Could not read the phone link status.'));
    return;
  }

  const rerender = (): void => void renderPhonePage(input);
  const children: HTMLElement[] = [];

  if (status.error) {
    children.push(note(`The tunnel endpoint failed to start: ${status.error}`));
  } else if (!status.running) {
    children.push(note('The tunnel endpoint is starting…'));
  }

  children.push(pairingSection(input, rerender));

  const deviceRows = status.devices.map((device) => deviceRow(input, device, rerender));
  children.push(
    el('div', { class: 'cd-phone-devices' }, [
      el('div', { class: 'drawer-group-label' }, 'Paired phones'),
      ...(deviceRows.length > 0
        ? deviceRows
        : [
            note(
              'No phones paired yet. Scan the QR code from the Centraid mobile app to connect one.',
            ),
          ]),
    ]),
  );

  host.replaceChildren(...children);
}

/** "Connect a phone" — mint a one-time code and show the QR until it's used. */
function pairingSection(input: PhonePageInput, rerender: () => void): HTMLElement {
  const { el, showToast } = input;
  const body = el('div', { class: 'cd-phone-pairing' });

  const start = el(
    'button',
    {
      class: 'cd-btn cd-btn-primary',
      type: 'button',
      onClick: () => {
        void (async () => {
          const pairing = await window.CentraidApi.beginPhonePairing().catch(() => undefined);
          if (!pairing) {
            showToast?.('Could not start pairing.');
            return;
          }
          const stop = window.CentraidApi.onPhonePaired(({ device }) => {
            stop();
            showToast?.(`Paired ${device.name}.`);
            rerender();
          });
          const qr = el('img', {
            alt: 'Pairing QR code — scan from the Centraid mobile app',
            class: 'cd-phone-qr',
          }) as HTMLImageElement;
          qr.src = pairing.qrDataUrl;
          const expiresAtLabel = new Date(pairing.expiresAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          });
          body.replaceChildren(
            qr,
            el(
              'div',
              { class: 'cd-app-settings-note' },
              `Open the Centraid app on your phone → Settings → Pair with desktop, and scan this code. It works once and expires at ${expiresAtLabel}.`,
            ),
            el(
              'button',
              {
                class: 'cd-link-btn',
                type: 'button',
                onClick: () => {
                  stop();
                  void window.CentraidApi.cancelPhonePairing();
                  rerender();
                },
              },
              'Cancel pairing',
            ),
          );
        })();
      },
    },
    'Connect a phone',
  );

  body.replaceChildren(
    el(
      'div',
      { class: 'cd-app-settings-note' },
      'Your phone connects directly to this desktop over an end-to-end encrypted tunnel — from any network, with the gateway never exposed. Publish an app here, open it there.',
    ),
    start,
  );
  return body;
}

/** One paired phone: name + platform + added date, and Revoke. */
function deviceRow(
  input: PhonePageInput,
  device: CentraidPhoneDevice,
  rerender: () => void,
): HTMLElement {
  const { el, showToast } = input;
  const added = new Date(device.addedAt);
  const addedLabel = Number.isNaN(added.getTime()) ? '' : ` · added ${added.toLocaleDateString()}`;
  return el('div', { class: 'cd-phone-device-row' }, [
    el('div', { class: 'cd-phone-device-info' }, [
      el('div', { class: 'cd-phone-device-name' }, device.name),
      el(
        'div',
        { class: 'cd-phone-device-meta' },
        `${device.platform}${addedLabel} · ${device.endpointId.slice(0, 10)}…`,
      ),
    ]),
    el(
      'button',
      {
        class: 'cd-phone-revoke-btn',
        type: 'button',
        onClick: () => {
          void (async () => {
            const result = await window.CentraidApi.revokePhoneDevice({
              deviceId: device.deviceId,
            }).catch(() => undefined);
            showToast?.(result?.removed ? `Revoked ${device.name}.` : 'Could not revoke device.');
            rerender();
          })();
        },
      },
      'Revoke',
    ),
  ]);
}
