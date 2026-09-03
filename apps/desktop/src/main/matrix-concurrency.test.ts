/**
 * Matrix cell desktop.concurrency (#535 coverable-today).
 * mergePersistedSettings is pure — concurrent patches on the same base do not share outputs.
 */
import { describe, expect, test } from "vitest";

import { mergePersistedSettings } from "./settings-merge.ts";

describe("matrix-concurrency", () => {
  test("parallel merges from one base keep per-call patch isolation", () => {
    const base = {
      activeGatewayId: "local",
      activeVaultByGateway: { local: "v-0" },
    };
    const results = Array.from({ length: 20 }, (_, i) =>
      mergePersistedSettings(base, {
        changelogSeenVersion: `1.0.${i}`,
        activeVaultByGateway: { local: `v-${i}` },
      })
    );
    for (let i = 0; i < results.length; i += 1) {
      expect(results[i]!.changelogSeenVersion).toBe(`1.0.${i}`);
      expect(results[i]!.activeVaultByGateway).toStrictEqual({
        local: `v-${i}`,
      });
    }
    results[0]!.changelogSeenVersion = "MUTATED";
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i]!.changelogSeenVersion).toBe(`1.0.${i}`);
    }
    expect(base.activeGatewayId).toBe("local");
  });
});
