/**
 * Enrichment tier enforcement — the decision half.
 *
 * The vault carries a per-domain enrichment tier (`enrich_policy`, mirrored
 * from the owner's settings bag): `off | device | gateway` — ONE axis, three
 * points, ordered by how far the work is allowed to run. Nothing on the
 * execution path used to read that tier, so a client's on-device promise was
 * copy, not behaviour. This module is the rule; `runFire` is the choke point
 * that applies it, and a host supplies the tier through
 * `RunFireOptions.resolveEnrichPolicy`.
 *
 * THE LINE THIS RUNTIME ACTUALLY DRAWS — and the one it got wrong before.
 *
 * The tier used to be read as "does this leave the device", with the
 * gateway itself folded into "leaves" on the theory that it is the thing
 * that performs egress. That conflated two different facts: WHERE a process
 * runs, and WHETHER it talks to a third party. The gateway is the member's
 * own infrastructure — part of their trust domain, same as their phone —
 * and running *on* it is not by itself egress. What IS egress is a harness
 * that talks to a THIRD-PARTY PROVIDER over the network. `ctx.delegate`
 * dispatches through the harness registry (`HARNESS_KINDS` in app-engine:
 * codex, claude-code, gemini, qwen, opencode, grok, kimi, copilot, cursor,
 * kilo, cline, goose, auggie, vibe, droid, pi, acp) — every harness shipped
 * today happens to be a coding-agent harness that talks to a remote
 * provider, which is why the dispatcher gates each call behind PROVIDER
 * EGRESS consent (#567). That is a fact about today's roster, not a
 * definition: the door stays open for a gateway-hosted local-inference
 * harness (a custom `acp` kind fronting a model that runs inside the
 * gateway's own process, with no network egress) whose model turns would be
 * legitimately inside the trust domain. The lane fact is therefore "does
 * this harness egress to a provider" — a property of the HARNESS, not of
 * "which machine issued the call".
 *
 * The one lane that genuinely never leaves the member's own devices at all
 * — not the gateway either — is the device work-lease lane
 * (`enrich_request.required_capability` +
 * `packages/vault/src/enrich/leases.ts`, docs/decisions.md "Local OCR": iOS
 * Vision / Android ML Kit / a local Tesseract-compatible worker, "No image
 * or recognized text leaves the user's devices"). Deterministic in-process
 * work (phash, clustering, trip grouping) is `gateway`-tier work in the same
 * sense as a future local-inference harness: it runs inside the member's own
 * infrastructure and reaches no provider.
 *
 * So the axis reads: `off` — nothing runs. `device` — the member's phone or
 * laptop may do device-lease work; the gateway may do its own deterministic
 * work; no harness call is allowed. `gateway` — the member's own gateway may
 * additionally do whatever it is already wired to, including a `ctx.delegate`
 * turn through the harness registry — which, for every harness shipped today,
 * reaches a third-party provider. There is no separate `provider` tier:
 * provider egress is enforced per call at the dispatcher (#567) and per
 * capability at the consent gate (decision S9, `enrich_request.capability`)
 * independently of this tier, so raising a domain to `gateway` widens WHERE
 * work may run, never a standing grant to reach any provider for anything.
 *
 * An enricher DECLARES the lane its work needs (`manifest.enrich.lane`); the
 * owner's tier is the furthest point they allow. The gate is one rank
 * comparison: `rank(lane) <= rank(tier)`. A manifest that omits the lane is
 * read as `gateway` — assuming the cheaper lane would be assuming consent.
 *
 * CONSEQUENCE, stated rather than papered over: under `device` every
 * gateway-lane enricher shipped in blueprints (doc-text-extractor,
 * doc-entity-linker, doc-filer, obligation-extractor) stops running — each of
 * them declares
 * `enrich.lane: "gateway"` because each one takes a `ctx.delegate` model turn,
 * and every harness in this build's registry routes that turn to a
 * third-party provider. `gateway` is the seeded default for a freshly
 * bootstrapped vault (`packages/vault/src/bootstrap.ts`); each of those
 * enrichers still starts `enabled: false` in its own manifest, so the tier
 * widens what a member's install COULD run, not what runs unasked.
 */

/** The owner's standing tier for one enrichment domain, on the one axis. */
export const ENRICH_TIERS = ["off", "device", "gateway"] as const;
export type EnrichTier = (typeof ENRICH_TIERS)[number];

/** The domains `enrich_policy` is keyed by. */
export const ENRICH_DOMAINS = ["photos", "docs"] as const;
export type EnrichDomain = (typeof ENRICH_DOMAINS)[number];

/**
 * Which lane an enricher's work runs in — the same two non-`off` points on
 * the tier axis, restated as what the ENRICHER needs rather than what the
 * OWNER allows. `gateway` needs a `ctx.delegate` turn through the harness
 * registry, which every harness shipped today routes to a third-party
 * provider. `device` is deterministic and/or device-lease work that reaches
 * no provider. Manifests that omit it are read as `gateway` — assuming the
 * cheaper lane would be assuming consent.
 */
export const ENRICH_LANES = ["device", "gateway"] as const;
export type EnrichLane = (typeof ENRICH_LANES)[number];

/**
 * Ordinal rank on the `off | device | gateway` axis — the furthest point
 * reachable at each. The whole gate is one comparison against this table:
 * `rank(lane) <= rank(tier)`. `EnrichLane`'s two values are also valid
 * `EnrichTier` values, so the same table ranks both.
 */
const RANK: Record<EnrichTier, number> = { off: 0, device: 1, gateway: 2 };

export interface EnrichGateInput {
  /** `<appId>/<automationId>` being fired — named in every refusal. */
  readonly automationRef: string;
  readonly domain: EnrichDomain;
  /** The enricher's capability id (`faces`, `captions`, …) — named in refusals. */
  readonly capability: string;
  readonly lane: EnrichLane;
  /**
   * The vault's tier for `domain`, or `undefined` when it could not be read.
   * `undefined` is a refusal, never a default — see the fail-closed contract
   * in `packages/vault/src/enrich/policy.ts`.
   */
  readonly tier: EnrichTier | undefined;
}

export type EnrichGateDecision =
  | {
      readonly allowed: true;
      /**
       * True under `device`: the fire may run, but every `ctx.delegate` call
       * must be refused. `runFire` wraps the dispatch surface accordingly.
       */
      readonly sealModelTurns: boolean;
    }
  | { readonly allowed: false; readonly reason: string };

/**
 * Apply the tier to one enrichment fire. Pure — the host reads the tier, this
 * decides, `runFire` refuses or seals. The gate is `rank(lane) <= rank(tier)`;
 * everything below is that comparison plus the reason a refusal names.
 */
export function decideEnrichmentGate(
  input: EnrichGateInput
): EnrichGateDecision {
  const who = `${input.automationRef} (enrichment "${input.capability}", domain "${input.domain}")`;
  if (input.tier === undefined) {
    return {
      allowed: false,
      reason:
        `${who} refused: this vault's enrichment policy for "${input.domain}" could not be read, ` +
        `and an unreadable policy is a refusal, not a default.`,
    };
  }
  if (RANK[input.lane] > RANK[input.tier]) {
    if (input.tier === "off") {
      return {
        allowed: false,
        reason: `${who} refused: enrichment is switched off for "${input.domain}" in this vault's privacy settings.`,
      };
    }
    return {
      allowed: false,
      reason:
        `${who} refused: enrichment for "${input.domain}" is set to "${input.tier}", and this enricher needs the ` +
        `"${input.lane}" lane — a model turn through the harness registry, which every harness in this runtime ` +
        `routes to a third-party provider, so the run would leave this member's trust domain. Set the tier to ` +
        `"gateway" to allow that, or use the device lane.`,
    };
  }
  return { allowed: true, sealModelTurns: input.tier !== "gateway" };
}

/** What a `ctx.delegate` call is told when the `device` tier sealed model turns. */
export function sealedModelTurnReason(
  automationRef: string,
  domain: EnrichDomain
): string {
  return (
    `${automationRef}: ctx.delegate is refused — enrichment for "${domain}" is set to "device" in this vault, ` +
    `and a model turn in this runtime always routes to a third-party provider.`
  );
}
