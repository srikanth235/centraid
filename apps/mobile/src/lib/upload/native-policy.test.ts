// The Wi-Fi-only / metered / charger transfer policy matrix. The native
// battery/network modules and the durable rule store are injected via mocks so
// the pure decision logic runs under node.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeUploadPolicy } from './native-policy';

const network = { getNetworkStateAsync: vi.fn() };
const battery = { getBatteryStateAsync: vi.fn() };
const store = { hydrate: vi.fn() };

vi.mock('expo-network', () => ({
  getNetworkStateAsync: (...args: unknown[]) => network.getNetworkStateAsync(...args),
  NetworkStateType: { WIFI: 'WIFI', CELLULAR: 'CELLULAR', OTHER: 'OTHER' },
}));
vi.mock('expo-battery', () => ({
  getBatteryStateAsync: (...args: unknown[]) => battery.getBatteryStateAsync(...args),
  BatteryState: { UNKNOWN: 0, UNPLUGGED: 1, CHARGING: 2, FULL: 3 },
}));
vi.mock('../../storage', () => ({ Store: { hydrate: (...a: unknown[]) => store.hydrate(...a) } }));

interface Rules {
  wifiOnly: boolean;
  allowMetered: boolean;
  chargerOnly: boolean;
}

function scenario(opts: {
  rules: Partial<Rules>;
  connected?: boolean;
  type?: 'WIFI' | 'CELLULAR' | 'OTHER';
  batteryState?: number;
}): Promise<boolean> {
  store.hydrate.mockResolvedValue({
    wifiOnly: true,
    allowMetered: false,
    chargerOnly: false,
    ...opts.rules,
  });
  network.getNetworkStateAsync.mockResolvedValue({
    isConnected: opts.connected ?? true,
    type: opts.type ?? 'WIFI',
  });
  battery.getBatteryStateAsync.mockResolvedValue(opts.batteryState ?? 1);
  return Promise.resolve(nativeUploadPolicy().canTransfer());
}

beforeEach(() => {
  store.hydrate.mockReset();
  network.getNetworkStateAsync.mockReset();
  battery.getBatteryStateAsync.mockReset();
});

describe('nativeUploadPolicy', () => {
  it('never transfers while offline, whatever the rules', async () => {
    expect(await scenario({ rules: { wifiOnly: false }, connected: false })).toBe(false);
  });

  it('wifiOnly permits Wi-Fi and blocks cellular', async () => {
    expect(await scenario({ rules: { wifiOnly: true }, type: 'WIFI' })).toBe(true);
    expect(await scenario({ rules: { wifiOnly: true }, type: 'CELLULAR' })).toBe(false);
  });

  it('with wifiOnly off, metered cellular needs allowMetered', async () => {
    expect(
      await scenario({ rules: { wifiOnly: false, allowMetered: false }, type: 'CELLULAR' }),
    ).toBe(false);
    expect(
      await scenario({ rules: { wifiOnly: false, allowMetered: true }, type: 'CELLULAR' }),
    ).toBe(true);
  });

  it('chargerOnly gates on the battery state even on Wi-Fi', async () => {
    expect(
      await scenario({
        rules: { wifiOnly: true, chargerOnly: true },
        type: 'WIFI',
        batteryState: 1,
      }),
    ).toBe(false);
    expect(
      await scenario({
        rules: { wifiOnly: true, chargerOnly: true },
        type: 'WIFI',
        batteryState: 2,
      }),
    ).toBe(true);
    expect(
      await scenario({
        rules: { wifiOnly: true, chargerOnly: true },
        type: 'WIFI',
        batteryState: 3,
      }),
    ).toBe(true);
  });
});
