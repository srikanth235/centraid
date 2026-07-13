import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DevicesCard from './DevicesCard.js';
import type { CentraidGatewayDevice } from '../../gateway-client.js';

const NOW = Date.UTC(2026, 6, 13, 12, 0, 0);

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.clearAllMocks();
});

function device(over: Partial<CentraidGatewayDevice> = {}): CentraidGatewayDevice {
  return {
    deviceId: 'enr_1',
    endpointId: 'http:abc',
    label: 'Priya’s browser',
    platform: 'web',
    transport: 'http',
    vaultId: 'v1',
    vaultName: 'Personal',
    addedAt: new Date(NOW - 86_400_000).toISOString(),
    lastUsedAt: new Date(NOW - 3_600_000).toISOString(),
    ...over,
  };
}

async function mount(props: {
  loadDevices: () => Promise<CentraidGatewayDevice[]>;
  onRevokeDevice?: (id: string) => Promise<{ removed: boolean }>;
}): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  await act(async () => {
    root = createRoot(container as HTMLDivElement);
    root.render(
      <DevicesCard
        now={NOW}
        loadDevices={props.loadDevices}
        onRevokeDevice={props.onRevokeDevice ?? (() => Promise.resolve({ removed: true }))}
      />,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

describe('DevicesCard', () => {
  it('renders an empty state when no devices are paired', async () => {
    const el = await mount({ loadDevices: vi.fn().mockResolvedValue([]) });
    expect(el.textContent).toContain('No devices are paired');
  });

  it('lists devices with transport chip, vault, and current-device marker', async () => {
    const el = await mount({
      loadDevices: vi
        .fn()
        .mockResolvedValue([
          device({ transport: 'iroh', current: true, label: 'This laptop' }),
          device({ deviceId: 'enr_2', label: 'Old phone', platform: 'ios', transport: 'iroh' }),
        ]),
    });
    expect(el.textContent).toContain('This laptop');
    expect(el.textContent).toContain('This device');
    expect(el.textContent).toContain('Relay');
    expect(el.textContent).toContain('Personal');
    expect(el.textContent).toContain('2 devices');
  });

  it('requires a confirm step before revoking, then calls onRevokeDevice', async () => {
    const onRevoke = vi.fn().mockResolvedValue({ removed: true });
    // The gateway drops the row once revoked, so the post-revoke refresh
    // returns the shorter list — the first load has the device, the rest don't.
    const loadDevices = vi.fn().mockResolvedValueOnce([device()]).mockResolvedValue([]);
    const el = await mount({ loadDevices, onRevokeDevice: onRevoke });
    const revokeBtn = [...el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Revoke'),
    );
    expect(revokeBtn).toBeTruthy();
    // First click only reveals the confirm affordance — no revoke yet.
    await act(async () => revokeBtn!.click());
    expect(onRevoke).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Remove');

    const confirmBtn = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Remove',
    );
    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });
    expect(onRevoke).toHaveBeenCalledWith('enr_1');
    // Row is optimistically dropped.
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.textContent).not.toContain('Priya’s browser');
  });

  it('surfaces a load error', async () => {
    const el = await mount({ loadDevices: vi.fn().mockRejectedValue(new Error('offline')) });
    expect(el.textContent).toContain('Couldn’t list paired devices');
    expect(el.textContent).toContain('offline');
  });
});
