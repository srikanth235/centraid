import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PhoneBridgeProps, PhoneStatusDTO } from '../bridge.js';
import PhoneScreen from './PhoneScreen.js';

const statusWithDevice: PhoneStatusDTO = {
  running: true,
  devices: [
    {
      deviceId: 'd1',
      name: 'Pixel 9',
      platform: 'android',
      endpointId: 'abcdefghijklmnop',
      addedAt: '2026-07-01T00:00:00.000Z',
    },
  ],
};

const emptyStatus: PhoneStatusDTO = { running: true, devices: [] };

function makeProps(over: Partial<PhoneBridgeProps> = {}): PhoneBridgeProps {
  return {
    loadStatus: vi.fn().mockResolvedValue(emptyStatus),
    beginPairing: vi.fn().mockResolvedValue(null),
    revoke: vi.fn().mockResolvedValue(true),
    showToast: vi.fn(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});
async function mount(props: PhoneBridgeProps): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(<PhoneScreen {...props} />);
  });
  return container;
}

describe('PhoneScreen', () => {
  it('shows the connect CTA + empty state when no phones are paired', async () => {
    const el = await mount(makeProps());
    expect(el.textContent).toContain('Connect a phone');
    expect(el.textContent).toContain('No phones paired yet');
  });

  it('lists paired devices with a revoke button that reloads', async () => {
    const loadStatus = vi.fn().mockResolvedValue(statusWithDevice);
    const props = makeProps({ loadStatus });
    const el = await mount(props);
    expect(el.textContent).toContain('Pixel 9');
    expect(el.textContent).toContain('android');
    const revokeBtn = el.querySelector('.cd-phone-revoke-btn') as HTMLButtonElement;
    await act(async () => revokeBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.revoke).toHaveBeenCalledWith('d1');
    expect(loadStatus).toHaveBeenCalledTimes(2); // initial + after revoke
  });

  it('begins pairing and shows the QR + expiry, then clears on pairing completion', async () => {
    let firePaired: ((name: string) => void) | null = null;
    const beginPairing = vi.fn(async (onPaired: (n: string) => void) => {
      firePaired = onPaired;
      return { info: { qrDataUrl: 'data:image/png;base64,AAAA', expiresAt: 0 }, cancel: vi.fn() };
    });
    const props = makeProps({ beginPairing });
    const el = await mount(props);
    const connect = el.querySelector('.cd-btn-primary') as HTMLButtonElement;
    await act(async () => connect.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(el.querySelector('.cd-phone-qr')).toBeTruthy();
    expect(el.textContent).toContain('Cancel pairing');
    // Complete the pairing via the wired callback.
    await act(async () => firePaired?.('Pixel 9'));
    expect(props.showToast).toHaveBeenCalledWith('Paired Pixel 9.');
    expect(el.querySelector('.cd-phone-qr')).toBeNull();
  });

  it('renders the error note when the status cannot be read', async () => {
    const el = await mount(makeProps({ loadStatus: vi.fn().mockResolvedValue(null) }));
    expect(el.textContent).toContain('Could not read the phone link status.');
  });
});
