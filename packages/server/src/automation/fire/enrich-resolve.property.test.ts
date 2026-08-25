/*
 * Adversarial properties over the policy cascade's resolver (#839).
 *
 * `enrich-resolve.ts` states four things in prose that nothing checked over
 * arbitrary input: most-specific-wins is per FIELD, a rule may never move the
 * egress ceiling, an unstated policy fails closed, and a mis-keyed chain is
 * ignored rather than trusted. Each of those is a safety claim — the ceiling
 * one is the whole safety argument of #807 Wave 2 — so each gets a property
 * with an INDEPENDENT oracle here rather than an example that re-walks the
 * implementation's own loop.
 *
 * WHAT THE CONTRACT DOES AND DOES NOT PROMISE ABOUT ORDER. The header says
 * `rules` is "the chain for ONE capability, least-specific first". So the fold
 * IS order-sensitive by design (last non-null write wins) and this file pins
 * that direction explicitly — a reversed chain must resolve to the other
 * answer, not to the same one. What it is order-INSENSITIVE about is foreign
 * capabilities: a rule naming another capability changes nothing from any
 * position. Specificity is carried by ARRAY POSITION alone: `rule.scope` is
 * never read by the resolver, so a chain whose scope types disagree with its
 * order still folds by order. That is pinned below too, because it is the
 * sharp edge a caller assembling a chain by hand would cut themselves on.
 */

import { describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";
import {
  BUILT_IN_PROFILE,
  ENRICH_EGRESS_CLASSES,
  ENRICH_SCOPE_TYPES,
  ENRICH_TRIGGERS,
} from "@centraid/vault";
import type {
  EnrichEgressClass,
  EnrichPolicyRule,
  EnrichScope,
  EnrichTrigger,
} from "@centraid/vault";

import { ENRICH_TIERS } from "./enrich-gate.js";
import type { EnrichTier } from "./enrich-gate.js";
import {
  DEFAULT_ENRICH_TRIGGER,
  egressWithinCeiling,
  resolveEnrichmentPolicy,
  tierEgressCeiling,
} from "./enrich-resolve.js";
import type { EnrichEgressCeiling } from "./enrich-resolve.js";

/** Capability ids the chains are keyed on — small so collisions actually happen. */
const CAPABILITIES = ["faces", "captions", "trips"] as const;

/**
 * The ceiling ladder, least to most reaching. Derived here from the vault's own
 * class list rather than from `EGRESS_RANK` (which is module-private): the
 * oracle must not be able to inherit the implementation's mistake.
 */
const CEILING_LADDER: readonly EnrichEgressCeiling[] = [
  "off",
  ...ENRICH_EGRESS_CLASSES,
];

const arbScope: fc.Arbitrary<EnrichScope> = fc.record({
  type: fc.constantFrom(...ENRICH_SCOPE_TYPES),
  ref: fc.string({ maxLength: 12 }),
});

const arbTrigger: fc.Arbitrary<EnrichTrigger> = fc.constantFrom(
  ...ENRICH_TRIGGERS
);

const arbRule = (
  capability: fc.Arbitrary<string> = fc.constantFrom(...CAPABILITIES)
): fc.Arbitrary<EnrichPolicyRule> =>
  fc.record({
    scope: arbScope,
    capability,
    enabled: fc.option(fc.boolean(), { nil: null }),
    profile: fc.option(fc.string({ minLength: 1, maxLength: 16 }), {
      nil: null,
    }),
    trigger: fc.option(arbTrigger, { nil: null }),
    updatedAt: fc.constant("2026-08-21T00:00:00.000Z"),
  });

const arbChain = fc.array(arbRule(), { maxLength: 8 });

const arbTier: fc.Arbitrary<EnrichTier | undefined> = fc.constantFrom<
  (EnrichTier | undefined)[]
>(...ENRICH_TIERS, undefined);

/**
 * The independent oracle: fold the chain the way the module DOC describes,
 * written from the prose rather than from the code — last non-null write per
 * field, foreign capabilities skipped, base from the tier alone.
 */
function expectedFold(
  rules: readonly EnrichPolicyRule[],
  tier: EnrichTier | undefined,
  capability: string
): {
  enabled: boolean;
  profileId: string;
  trigger: EnrichTrigger;
  egressCeiling: EnrichEgressCeiling;
} | null {
  const mine = rules.filter((rule) => rule.capability === capability);
  if (tier === undefined && mine.length === 0) return null;
  const lastOf = <T>(
    pick: (rule: EnrichPolicyRule) => T | null,
    base: T
  ): T => {
    let value = base;
    for (const rule of mine) {
      const written = pick(rule);
      if (written !== null) value = written;
    }
    return value;
  };
  return {
    enabled: lastOf(
      (rule) => rule.enabled,
      tier === undefined ? false : tier !== "off"
    ),
    profileId: lastOf((rule) => rule.profile, BUILT_IN_PROFILE),
    trigger: lastOf((rule) => rule.trigger, DEFAULT_ENRICH_TRIGGER),
    egressCeiling: tier === undefined ? "on-device" : tierEgressCeiling(tier),
  };
}

describe("enrichment policy cascade — resolver properties (#839 G10)", () => {
  describe("(a) most-specific-wins is per field", () => {
    test("every field is the LAST non-null write in least-specific-first order", () => {
      fc.assert(
        fc.property(
          arbChain,
          arbTier,
          fc.constantFrom(...CAPABILITIES),
          (rules, tier, capability) => {
            const resolved = resolveEnrichmentPolicy(rules, tier, capability);
            const oracle = expectedFold(rules, tier, capability);
            expect(resolved).toStrictEqual(
              oracle === null ? undefined : { capability, ...oracle }
            );
          }
        )
      );
    });

    test("a rule that pins ONE field leaves the other two on the level below it", () => {
      // The per-FIELD claim's teeth: a collection that only pins a profile must
      // keep the vault's enabled/trigger answers, not reset them to the base.
      fc.assert(
        fc.property(
          fc.constantFrom(...ENRICH_TRIGGERS),
          fc.string({ minLength: 1, maxLength: 12 }),
          (trigger, profile) => {
            const base = (
              over: Partial<EnrichPolicyRule>
            ): EnrichPolicyRule => ({
              scope: { type: "vault", ref: "" },
              capability: "faces",
              enabled: null,
              profile: null,
              trigger: null,
              updatedAt: "2026-08-21T00:00:00.000Z",
              ...over,
            });
            const resolved = resolveEnrichmentPolicy(
              [
                base({ enabled: false, trigger }),
                base({ scope: { type: "collection", ref: "a" }, profile }),
              ],
              "gateway",
              "faces"
            );
            expect(resolved).toStrictEqual({
              capability: "faces",
              enabled: false,
              profileId: profile,
              trigger,
              egressCeiling: "gateway",
            });
          }
        )
      );
    });

    test("a mis-keyed chain decides nothing for the capability it never mentioned", () => {
      fc.assert(
        fc.property(
          fc.array(arbRule(fc.constant("captions")), {
            minLength: 1,
            maxLength: 6,
          }),
          fc.constantFrom(...ENRICH_TIERS),
          (foreign, tier) => {
            expect(
              resolveEnrichmentPolicy(foreign, tier, "faces")
            ).toStrictEqual({
              capability: "faces",
              enabled: tier !== "off",
              profileId: BUILT_IN_PROFILE,
              trigger: DEFAULT_ENRICH_TRIGGER,
              egressCeiling: tierEgressCeiling(tier),
            });
          }
        )
      );
    });
  });

  describe("(b) no rule combination ever raises the egress ceiling", () => {
    test("the resolved ceiling is the tier's ceiling, whatever the rules say", () => {
      fc.assert(
        fc.property(
          arbChain,
          arbTier,
          fc.constantFrom(...CAPABILITIES),
          (rules, tier, capability) => {
            const resolved = resolveEnrichmentPolicy(rules, tier, capability);
            if (resolved === undefined) return;
            expect(resolved.egressCeiling).toBe(
              tier === undefined ? "on-device" : tierEgressCeiling(tier)
            );
          }
        )
      );
    });

    test("no chain makes `provider` reachable — a standing tier never answers provider egress", () => {
      fc.assert(
        fc.property(
          arbChain,
          arbTier,
          fc.constantFrom(...CAPABILITIES),
          (rules, tier, capability) => {
            const resolved = resolveEnrichmentPolicy(rules, tier, capability);
            if (resolved === undefined) return;
            expect(
              egressWithinCeiling("provider", resolved.egressCeiling)
            ).toBe(false);
          }
        )
      );
    });

    test("a profile-pinning rule cannot widen what the vault's tier allows", () => {
      // The named attack from the module header: a member pins a provider-backed
      // profile onto one album. The profile CHANGES; what it may reach does not.
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 16 }),
          fc.constantFrom(...ENRICH_TIERS),
          fc.constantFrom(...ENRICH_EGRESS_CLASSES),
          (profile, tier, egress) => {
            const pinned = resolveEnrichmentPolicy(
              [
                {
                  scope: { type: "collection", ref: "album-1" },
                  capability: "faces",
                  enabled: true,
                  profile,
                  trigger: null,
                  updatedAt: "2026-08-21T00:00:00.000Z",
                },
              ],
              tier,
              "faces"
            );
            const unpinned = resolveEnrichmentPolicy([], tier, "faces");
            expect(pinned?.profileId).toBe(profile);
            expect(pinned?.egressCeiling).toBe(unpinned?.egressCeiling);
            expect(
              egressWithinCeiling(egress, pinned?.egressCeiling ?? "off")
            ).toBe(
              egressWithinCeiling(egress, unpinned?.egressCeiling ?? "off")
            );
          }
        )
      );
    });

    test("egressWithinCeiling is monotone in both arguments over the ladder", () => {
      // The ceiling is only ever a narrowing: raising the ceiling can only ever
      // admit more, and raising the class can only ever admit less. A rank table
      // that stopped being a total order would break exactly here.
      fc.assert(
        fc.property(
          fc.nat({ max: CEILING_LADDER.length - 1 }),
          fc.nat({ max: CEILING_LADDER.length - 1 }),
          fc.nat({ max: ENRICH_EGRESS_CLASSES.length - 1 }),
          (lowIndex, highIndex, classIndex) => {
            const [lo, hi] = [
              Math.min(lowIndex, highIndex),
              Math.max(lowIndex, highIndex),
            ];
            const egress = ENRICH_EGRESS_CLASSES[
              classIndex
            ] as EnrichEgressClass;
            const lower = CEILING_LADDER[lo] as EnrichEgressCeiling;
            const higher = CEILING_LADDER[hi] as EnrichEgressCeiling;
            // Monotone: admitted under the lower ceiling ⇒ admitted under the
            // higher one. Stated as an implication so the assertion is
            // unconditional and the counterexample prints both ceilings.
            expect(
              !egressWithinCeiling(egress, lower) ||
                egressWithinCeiling(egress, higher),
              `${egress} fits ${lower} but not ${higher}`
            ).toBe(true);
            expect(egressWithinCeiling(egress, "off")).toBe(false);
          }
        )
      );
    });

    test("every legacy tier maps onto the ladder, and `off` admits nothing", () => {
      expect(ENRICH_TIERS.map(tierEgressCeiling)).toStrictEqual([
        "off",
        "on-device",
        "gateway",
      ]);
      for (const egress of ENRICH_EGRESS_CLASSES) {
        expect(egressWithinCeiling(egress, tierEgressCeiling("off"))).toBe(
          false
        );
      }
      expect(
        egressWithinCeiling("on-device", tierEgressCeiling("device"))
      ).toBe(true);
      expect(egressWithinCeiling("gateway", tierEgressCeiling("device"))).toBe(
        false
      );
    });
  });

  describe("(c) fail-closed on an unstated policy", () => {
    test("no tier and no rule for this capability resolves to undefined (a refusal)", () => {
      fc.assert(
        fc.property(
          fc.array(arbRule(fc.constant("captions")), { maxLength: 6 }),
          (foreign) => {
            expect(
              resolveEnrichmentPolicy(foreign, undefined, "faces")
            ).toBeUndefined();
          }
        )
      );
    });

    test("an unreadable tier WITH rules falls back to the most conservative base", () => {
      // Header contract: disabled, `on-device` ceiling. Rules may then enable
      // the capability — never past a device-local engine.
      fc.assert(
        fc.property(
          fc.array(arbRule(fc.constant("faces")), {
            minLength: 1,
            maxLength: 6,
          }),
          (rules) => {
            const resolved = resolveEnrichmentPolicy(rules, undefined, "faces");
            expect(resolved?.egressCeiling).toBe("on-device");
            expect(egressWithinCeiling("gateway", "on-device")).toBe(false);
            // Enabled only if a rule said so; silence never enables.
            const lastEnabled = rules.reduce<boolean | null>(
              (seen, rule) => (rule.enabled === null ? seen : rule.enabled),
              null
            );
            expect(resolved?.enabled).toBe(lastEnabled ?? false);
          }
        )
      );
    });

    test("tier `off` disables regardless of any rule that tries to enable", () => {
      // `off` is the absence of a lane: rules may flip `enabled`, but the
      // ceiling stays `off`, so nothing the gate can run fits inside it.
      fc.assert(
        fc.property(
          fc.array(arbRule(fc.constant("faces")), { maxLength: 6 }),
          (rules) => {
            const resolved = resolveEnrichmentPolicy(
              [
                ...rules,
                {
                  scope: { type: "item", ref: "photo-1" },
                  capability: "faces",
                  enabled: true,
                  profile: null,
                  trigger: null,
                  updatedAt: "2026-08-21T00:00:00.000Z",
                },
              ],
              "off",
              "faces"
            );
            expect(resolved?.enabled).toBe(true);
            expect(resolved?.egressCeiling).toBe("off");
            for (const egress of ENRICH_EGRESS_CLASSES) {
              expect(
                egressWithinCeiling(egress, resolved?.egressCeiling ?? "off")
              ).toBe(false);
            }
          }
        )
      );
    });

    test("an absent field on every rule leaves the documented defaults standing", () => {
      const silent: EnrichPolicyRule = {
        scope: { type: "domain", ref: "photos" },
        capability: "faces",
        enabled: null,
        profile: null,
        trigger: null,
        updatedAt: "2026-08-21T00:00:00.000Z",
      };
      expect(
        resolveEnrichmentPolicy([silent], "gateway", "faces")
      ).toStrictEqual({
        capability: "faces",
        enabled: true,
        profileId: BUILT_IN_PROFILE,
        trigger: DEFAULT_ENRICH_TRIGGER,
        egressCeiling: "gateway",
      });
    });
  });

  describe("(d) order sensitivity is exactly where the contract puts it", () => {
    test("foreign-capability rules change nothing from ANY position", () => {
      fc.assert(
        fc.property(
          fc.array(arbRule(fc.constant("faces")), { maxLength: 5 }),
          fc.array(arbRule(fc.constant("captions")), { maxLength: 5 }),
          fc.constantFrom(...ENRICH_TIERS),
          fc.nat({ max: 32 }),
          (mine, foreign, tier, seed) => {
            const woven = [...mine];
            for (const [index, rule] of foreign.entries()) {
              woven.splice((seed + index) % (woven.length + 1), 0, rule);
            }
            expect(resolveEnrichmentPolicy(woven, tier, "faces")).toStrictEqual(
              resolveEnrichmentPolicy(mine, tier, "faces")
            );
          }
        )
      );
    });

    test("a field written by at most one rule is order-INSENSITIVE", () => {
      fc.assert(
        fc.property(
          fc.array(
            arbRule(fc.constant("faces")).map((rule) => ({
              ...rule,
              profile: null,
            })),
            { maxLength: 5 }
          ),
          fc.string({ minLength: 1, maxLength: 12 }),
          fc.constantFrom(...ENRICH_TIERS),
          fc.nat({ max: 8 }),
          (blanks, profile, tier, at) => {
            const writer: EnrichPolicyRule = {
              scope: { type: "item", ref: "x" },
              capability: "faces",
              enabled: null,
              profile,
              trigger: null,
              updatedAt: "2026-08-21T00:00:00.000Z",
            };
            const chain: EnrichPolicyRule[] = [...blanks];
            chain.splice(at % (chain.length + 1), 0, writer);
            expect(
              resolveEnrichmentPolicy(chain, tier, "faces")?.profileId
            ).toBe(profile);
          }
        )
      );
    });

    test("two writers to one field ARE order-sensitive — reversal flips the answer", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 8 }),
          fc.string({ minLength: 1, maxLength: 8 }),
          fc.constantFrom(...ENRICH_TIERS),
          (first, second, tier) => {
            fc.pre(first !== second);
            const rule = (profile: string, type: EnrichScope["type"]) => ({
              scope: { type, ref: "r" },
              capability: "faces",
              enabled: null,
              profile,
              trigger: null,
              updatedAt: "2026-08-21T00:00:00.000Z",
            });
            const chain = [rule(first, "vault"), rule(second, "item")];
            expect(
              resolveEnrichmentPolicy(chain, tier, "faces")?.profileId
            ).toBe(second);
            expect(
              resolveEnrichmentPolicy(chain.toReversed(), tier, "faces")
                ?.profileId
            ).toBe(first);
          }
        )
      );
    });

    test("specificity is ARRAY POSITION, not `rule.scope` — the resolver never reads the scope", () => {
      // A caller that hands over a chain sorted most-specific-first gets the
      // LEAST specific answer. Pinned deliberately: the store guarantees the
      // order (`readEnrichPolicyRuleChain`), the resolver trusts it, and this is
      // the seam where a hand-assembled chain silently inverts.
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 8 }),
          fc.string({ minLength: 1, maxLength: 8 }),
          (vaultProfile, itemProfile) => {
            fc.pre(vaultProfile !== itemProfile);
            const at = (type: EnrichScope["type"], profile: string) => ({
              scope: { type, ref: type === "vault" ? "" : "ref" },
              capability: "faces",
              enabled: null,
              profile,
              trigger: null,
              updatedAt: "2026-08-21T00:00:00.000Z",
            });
            // Deliberately WRONG order (most specific first).
            expect(
              resolveEnrichmentPolicy(
                [at("item", itemProfile), at("vault", vaultProfile)],
                "gateway",
                "faces"
              )?.profileId
            ).toBe(vaultProfile);
          }
        )
      );
    });
  });
});
