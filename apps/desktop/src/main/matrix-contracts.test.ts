import { describe, expect, test } from "vitest";

import { mergePersistedSettings } from "./settings-merge.ts";

describe("matrix-contracts", () => {
  test("mergePersistedSettings contract: empty patch is a pure identity on known fields", () => {
    const current = {
      activeGatewayId: "local",
      changelogSeenVersion: "1.0.0",
      onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
      activeVaultByGateway: { local: "v-1" },
    };
    const next = mergePersistedSettings(current, {});
    expect(next.activeGatewayId).toBe("local");
    expect(next.changelogSeenVersion).toBe("1.0.0");
    expect(next.onboardingCompletedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.activeVaultByGateway).toStrictEqual({ local: "v-1" });
  });

  test("blank activeGatewayId never clears the current gateway id", () => {
    const next = mergePersistedSettings(
      { activeGatewayId: "local" },
      { activeGatewayId: "   " }
    );
    expect(next.activeGatewayId).toBe("local");
  });
});
