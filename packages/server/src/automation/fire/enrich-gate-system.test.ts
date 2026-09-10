/*
 * Consent is for EGRESS (#1011).
 *
 * A system automation is first-party code the release shipped, running bundled
 * models over the member's own bytes on their own gateway. That work needs no
 * consent, so an unwritten or unreadable policy no longer refuses it. What a
 * system automation does NOT get is wider reach: an explicit `off`, a rule that
 * switches the capability off, and every provider turn are decided exactly as
 * they are for any other automation. These cases pin both halves.
 */
import { describe, expect, it } from "vitest";

import type { EnrichPolicyRule } from "@centraid/vault";

import { decideEnrichmentGate } from "./enrich-gate.js";
import { resolveEnrichmentPolicy } from "./enrich-resolve.js";

const base = {
  automationRef: "faces/faces",
  domain: "photos",
  capability: "faces",
} as const;

describe("system provenance at the enrichment gate", () => {
  it("runs on-device when the vault's policy cannot be read", () => {
    // Same input, two provenances: the refusal is the difference.
    expect(
      decideEnrichmentGate({ ...base, lane: "gateway", tier: undefined })
        .allowed
    ).toBe(false);
    expect(
      decideEnrichmentGate({
        ...base,
        lane: "gateway",
        tier: undefined,
        system: true,
      })
    ).toStrictEqual({ allowed: true, sealModelTurns: true });
  });

  it("runs with model turns sealed under the device tier", () => {
    expect(
      decideEnrichmentGate({
        ...base,
        lane: "gateway",
        tier: "device",
        system: true,
      })
    ).toStrictEqual({ allowed: true, sealModelTurns: true });
  });

  it("still refuses an explicit off — that is the member's own answer", () => {
    const decision = decideEnrichmentGate({
      ...base,
      lane: "gateway",
      tier: "off",
      system: true,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain(
      "switched off"
    );
  });

  it("still refuses a capability the policy switched off", () => {
    const policy = resolveEnrichmentPolicy(
      [
        {
          scope: { type: "vault", ref: "" },
          capability: "faces",
          enabled: false,
          profile: null,
          trigger: null,
          updatedAt: "2026-09-09T00:00:00.000Z",
        } satisfies EnrichPolicyRule,
      ],
      "gateway",
      "faces",
      { system: true }
    );
    expect(policy?.enabled).toBe(false);
    const decision = decideEnrichmentGate({
      ...base,
      lane: "device",
      tier: "gateway",
      system: true,
      ...(policy ? { policy } : {}),
      profileEgress: "on-device",
    });
    expect(decision.allowed).toBe(false);
  });

  it("resolves an unwritten policy to enabled-on-device, and nothing wider", () => {
    expect(resolveEnrichmentPolicy([], undefined, "faces")).toBeUndefined();
    const resolved = resolveEnrichmentPolicy([], undefined, "faces", {
      system: true,
    });
    expect(resolved?.enabled).toBe(true);
    // The ceiling is untouched: on-device, so no provider turn can pass it.
    expect(resolved?.egressCeiling).toBe("on-device");
  });
});
