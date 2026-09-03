import { describe, expect, it } from "vitest";

import { BUILT_IN_PROFILE } from "@centraid/vault";
import type { EnrichPolicyRule, EnrichScopeType } from "@centraid/vault";

import {
  automationScopeChain,
  egressWithinCeiling,
  resolveEnrichmentPolicy,
  tierEgressCeiling,
} from "./enrich-resolve.js";

function rule(
  type: EnrichScopeType,
  ref: string,
  fields: Partial<Pick<EnrichPolicyRule, "enabled" | "profile" | "trigger">>,
  capability = "ocr"
): EnrichPolicyRule {
  return {
    scope: { type, ref },
    capability,
    enabled: fields.enabled ?? null,
    profile: fields.profile ?? null,
    trigger: fields.trigger ?? null,
    updatedAt: "2026-08-16T00:00:00.000Z",
  };
}

describe(resolveEnrichmentPolicy, () => {
  it("inherits everything when no level states anything", () => {
    expect(resolveEnrichmentPolicy([], "gateway", "ocr")).toStrictEqual({
      capability: "ocr",
      enabled: true,
      profileId: BUILT_IN_PROFILE,
      trigger: "on-ingest",
      egressCeiling: "gateway",
    });
  });

  it("lets the most specific level win, per field", () => {
    const resolved = resolveEnrichmentPolicy(
      [
        rule("vault", "", {
          enabled: true,
          profile: "fast-ocr",
          trigger: "on-ingest",
        }),
        rule("domain", "photos", { trigger: "on-view" }),
        rule("collection", "album-1", { profile: "careful-ocr" }),
      ],
      "gateway",
      "ocr"
    );

    expect(resolved).toStrictEqual({
      capability: "ocr",
      enabled: true,
      profileId: "careful-ocr",
      trigger: "on-view",
      egressCeiling: "gateway",
    });
  });

  it("lets a deeper level switch a capability off that the vault left on", () => {
    const resolved = resolveEnrichmentPolicy(
      [
        rule("vault", "", { enabled: true }),
        rule("item", "asset-9", { enabled: false }),
      ],
      "gateway",
      "ocr"
    );

    expect(resolved?.enabled).toBe(false);
  });

  it("ignores rules written for another capability", () => {
    const resolved = resolveEnrichmentPolicy(
      [rule("collection", "album-1", { enabled: false }, "faces")],
      "gateway",
      "ocr"
    );

    expect(resolved?.enabled).toBe(true);
  });

  it.each([
    ["off", "off", false],
    ["device", "on-device", true],
    ["gateway", "gateway", true],
  ] as const)(
    "migrates the legacy %s tier to the %s ceiling",
    (tier, ceiling, enabled) => {
      const resolved = resolveEnrichmentPolicy([], tier, "ocr");
      expect(resolved?.egressCeiling).toBe(ceiling);
      expect(resolved?.enabled).toBe(enabled);
      expect(tierEgressCeiling(tier)).toBe(ceiling);
    }
  );

  it("gives no rule at any depth the power to raise the ceiling", () => {
    const resolved = resolveEnrichmentPolicy(
      [
        rule("item", "asset-9", { enabled: true, profile: "provider-vlm" }),
        rule("collection", "album-1", { enabled: true }),
      ],
      "device",
      "ocr"
    );

    expect(resolved?.egressCeiling).toBe("on-device");
    expect(egressWithinCeiling("provider", resolved!.egressCeiling)).toBe(
      false
    );
    expect(egressWithinCeiling("on-device", resolved!.egressCeiling)).toBe(
      true
    );
  });

  it("fails closed when the vault states no tier and no rules", () => {
    expect(resolveEnrichmentPolicy([], undefined, "ocr")).toBeUndefined();
  });

  it("resolves an unreadable tier that carries rules at the most conservative base", () => {
    const resolved = resolveEnrichmentPolicy(
      [rule("domain", "photos", { enabled: true })],
      undefined,
      "ocr"
    );

    expect(resolved).toStrictEqual({
      capability: "ocr",
      enabled: true,
      profileId: BUILT_IN_PROFILE,
      trigger: "on-ingest",
      egressCeiling: "on-device",
    });
  });

  it("resolves an automation fire against [vault, domain] and nothing deeper", () => {
    expect(automationScopeChain("photos")).toStrictEqual([
      { type: "vault", ref: "" },
      { type: "domain", ref: "photos" },
    ]);
  });
});
