// The Wi-Fi-only / metered / charger transfer policy matrix. The native
// battery/network modules and the durable rule store are injected via mocks so
// the pure decision logic runs under node.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { nativeUploadPolicy } from "./native-policy";

type ExpoBattery = typeof import("expo-battery");
type ExpoNetwork = typeof import("expo-network");

type NetworkStateTestSeam = () => Promise<{
  isConnected: boolean;
  type: "WIFI" | "CELLULAR" | "OTHER";
}>;
type BatteryStateTestSeam = () => Promise<number>;
type HydrateRulesTestSeam = (key: string, fallback: Rules) => Promise<Rules>;

const network = { getNetworkStateAsync: vi.fn<NetworkStateTestSeam>() };
const battery = { getBatteryStateAsync: vi.fn<BatteryStateTestSeam>() };
const store = { hydrate: vi.fn<HydrateRulesTestSeam>() };
const connectivity = {
  getCellularRoamingStatus: vi.fn<() => Promise<boolean | null>>(),
};

vi.mock(import("expo-network") as Promise<unknown>, () => ({
  getNetworkStateAsync: () => network.getNetworkStateAsync(),
  // Real string-enum members (`NetworkStateType.WIFI`, …) are a distinct
  // literal type per member — a plain string like `'WIFI'` is never
  // assignable to an enum-typed property without going through the actual
  // enum, so this partial stand-in (only the members native-policy.ts
  // reads) is asserted to the real type rather than reconstructed.
  NetworkStateType: {
    WIFI: "WIFI",
    CELLULAR: "CELLULAR",
    OTHER: "OTHER",
  } as unknown as ExpoNetwork["NetworkStateType"],
}));
vi.mock(import("expo-battery"), () => ({
  getBatteryStateAsync: () => battery.getBatteryStateAsync(),
  BatteryState: {
    UNKNOWN: 0,
    UNPLUGGED: 1,
    CHARGING: 2,
    FULL: 3,
  } as unknown as ExpoBattery["BatteryState"],
}));
vi.mock(
  import("../../../modules/centraid-network-status") as Promise<unknown>,
  () => ({
    getCellularRoamingStatus: () => connectivity.getCellularRoamingStatus(),
  })
);
vi.mock(import("../../storage") as Promise<unknown>, () => ({
  Store: {
    // Only `hydrate` is exercised here; `get`/`set` are implemented with the
    // real generic signatures (not asserted) since they're trivial to
    // satisfy honestly.
    get: <T>(_key: string, fallback: T): T => fallback,
    hydrate: (key: string, fallback: Rules) => store.hydrate(key, fallback),
    set: <T>(_key: string, _value: T): void => undefined,
  },
}));

interface Rules {
  wifiOnly: boolean;
  allowMetered: boolean;
  allowRoaming: boolean;
  chargerOnly: boolean;
}

function scenario(opts: {
  rules: Partial<Rules>;
  connected?: boolean;
  type?: "WIFI" | "CELLULAR" | "OTHER";
  batteryState?: number;
  roaming?: boolean | null;
}): Promise<boolean> {
  store.hydrate.mockResolvedValue({
    wifiOnly: true,
    allowMetered: false,
    allowRoaming: false,
    chargerOnly: false,
    ...opts.rules,
  });
  network.getNetworkStateAsync.mockResolvedValue({
    isConnected: opts.connected ?? true,
    type: opts.type ?? "WIFI",
  });
  battery.getBatteryStateAsync.mockResolvedValue(opts.batteryState ?? 1);
  connectivity.getCellularRoamingStatus.mockResolvedValue(
    opts.roaming === undefined ? false : opts.roaming
  );
  return Promise.resolve(nativeUploadPolicy().canTransfer());
}

describe("native-policy", () => {
  beforeEach(() => {
    store.hydrate.mockReset();
    network.getNetworkStateAsync.mockReset();
    battery.getBatteryStateAsync.mockReset();
    connectivity.getCellularRoamingStatus.mockReset();
  });

  describe(nativeUploadPolicy, () => {
    it("never transfers while offline, whatever the rules", async () => {
      await expect(
        scenario({ rules: { wifiOnly: false }, connected: false })
      ).resolves.toBe(false);
    });

    it("wifiOnly permits Wi-Fi and blocks cellular", async () => {
      await expect(
        scenario({ rules: { wifiOnly: true }, type: "WIFI" })
      ).resolves.toBe(true);
      await expect(
        scenario({ rules: { wifiOnly: true }, type: "CELLULAR" })
      ).resolves.toBe(false);
    });

    it("with wifiOnly off, metered cellular needs allowMetered", async () => {
      await expect(
        scenario({
          rules: { wifiOnly: false, allowMetered: false },
          type: "CELLULAR",
        })
      ).resolves.toBe(false);
      await expect(
        scenario({
          rules: { wifiOnly: false, allowMetered: true },
          type: "CELLULAR",
        })
      ).resolves.toBe(true);
    });

    it("chargerOnly gates on the battery state even on Wi-Fi", async () => {
      await expect(
        scenario({
          rules: { wifiOnly: true, chargerOnly: true },
          type: "WIFI",
          batteryState: 1,
        })
      ).resolves.toBe(false);
      await expect(
        scenario({
          rules: { wifiOnly: true, chargerOnly: true },
          type: "WIFI",
          batteryState: 2,
        })
      ).resolves.toBe(true);
      await expect(
        scenario({
          rules: { wifiOnly: true, chargerOnly: true },
          type: "WIFI",
          batteryState: 3,
        })
      ).resolves.toBe(true);
    });

    it("blocks roaming or unknown cellular unless explicitly allowed", async () => {
      await expect(
        scenario({
          rules: {
            wifiOnly: false,
            allowMetered: true,
            allowRoaming: false,
          },
          type: "CELLULAR",
          roaming: true,
        })
      ).resolves.toBe(false);
      await expect(
        scenario({
          rules: {
            wifiOnly: false,
            allowMetered: true,
            allowRoaming: false,
          },
          type: "CELLULAR",
          roaming: null,
        })
      ).resolves.toBe(false);
      await expect(
        scenario({
          rules: {
            wifiOnly: false,
            allowMetered: true,
            allowRoaming: true,
          },
          type: "CELLULAR",
          roaming: true,
        })
      ).resolves.toBe(true);
    });
  });
});
