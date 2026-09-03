import { describe, expect, test } from "vitest";

import { mergePersistedSettings } from "./settings-merge.ts";

describe("settings-merge", () => {
  test("an unrelated save preserves other top-level fields intact", () => {
    const next = mergePersistedSettings(
      {
        activeGatewayId: "local",
        changelogSeenVersion: "1.0.0",
        onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      },
      { changelogSeenVersion: "1.1.0" }
    );
    expect(next.changelogSeenVersion).toBe("1.1.0");
    expect(next.onboardingCompletedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.activeGatewayId).toBe("local");
  });

  test("activeGatewayId falls back to current when patch omits/blanks it", () => {
    expect(
      mergePersistedSettings({ activeGatewayId: "local" }, {}).activeGatewayId
    ).toBe("local");
    expect(
      mergePersistedSettings(
        { activeGatewayId: "local" },
        { activeGatewayId: "   " }
      ).activeGatewayId
    ).toBe("local");
    expect(
      mergePersistedSettings(
        { activeGatewayId: "local" },
        { activeGatewayId: "remote-1" }
      ).activeGatewayId
    ).toBe("remote-1");
  });

  test("activeVaultByGateway is carried through an unrelated save (issue #289)", () => {
    const next = mergePersistedSettings(
      {
        activeGatewayId: "local",
        activeVaultByGateway: { local: "v-1", "gw-2": "v-9" },
      },
      { changelogSeenVersion: "1.0.0" }
    );
    expect(next.activeVaultByGateway).toStrictEqual({
      local: "v-1",
      "gw-2": "v-9",
    });
  });

  test("activeVaultByGateway is replaced wholesale when the patch sets it", () => {
    const next = mergePersistedSettings(
      { activeGatewayId: "local", activeVaultByGateway: { local: "v-1" } },
      { activeVaultByGateway: { local: "v-2", "gw-2": "v-9" } }
    );
    expect(next.activeVaultByGateway).toStrictEqual({
      local: "v-2",
      "gw-2": "v-9",
    });
  });

  test("an emptied vault map is dropped, not persisted empty", () => {
    const next = mergePersistedSettings(
      { activeGatewayId: "local", activeVaultByGateway: { local: "v-1" } },
      { activeVaultByGateway: {} }
    );
    expect(next.activeVaultByGateway).toBeUndefined();
  });

  test("gateway alert fields preserve-or-set, clamping the threshold on write", () => {
    const carried = mergePersistedSettings(
      {
        activeGatewayId: "local",
        gatewayAlertSeconds: 300,
        gatewayAlertsEnabled: false,
      },
      { changelogSeenVersion: "1.0.0" }
    );
    expect(carried.gatewayAlertSeconds).toBe(300);
    expect(carried.gatewayAlertsEnabled).toBe(false);

    const set = mergePersistedSettings(
      { activeGatewayId: "local" },
      { gatewayAlertSeconds: 5, gatewayAlertsEnabled: true }
    );
    expect(set.gatewayAlertSeconds).toBe(15);
    expect(set.gatewayAlertsEnabled).toBe(true);
    expect(
      mergePersistedSettings(
        { activeGatewayId: "local" },
        { gatewayAlertSeconds: 99_999 }
      ).gatewayAlertSeconds
    ).toBe(3600);

    const garbage = mergePersistedSettings(
      { activeGatewayId: "local", gatewayAlertSeconds: 120 },
      { gatewayAlertSeconds: Number.NaN }
    );
    expect(garbage.gatewayAlertSeconds).toBe(120);

    const absent = mergePersistedSettings({ activeGatewayId: "local" }, {});
    expect(absent.gatewayAlertSeconds).toBeUndefined();
    expect(absent.gatewayAlertsEnabled).toBeUndefined();
  });

  test("launchAtLogin preserve-or-sets like a plain boolean field (issue #351)", () => {
    expect(
      mergePersistedSettings({ activeGatewayId: "local" }, {}).launchAtLogin
    ).toBeUndefined();

    expect(
      mergePersistedSettings(
        { activeGatewayId: "local" },
        { launchAtLogin: true }
      ).launchAtLogin
    ).toBe(true);

    expect(
      mergePersistedSettings(
        { activeGatewayId: "local", launchAtLogin: true },
        { changelogSeenVersion: "1.0.0" }
      ).launchAtLogin
    ).toBe(true);

    expect(
      mergePersistedSettings(
        { activeGatewayId: "local", launchAtLogin: true },
        { launchAtLogin: false }
      ).launchAtLogin
    ).toBe(false);
  });
});
