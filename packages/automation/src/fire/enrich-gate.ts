/**
 * Enrichment tier enforcement — the decision half.
 *
 * The vault carries a per-domain enrichment tier (`enrich_policy`, mirrored
 * from the owner's settings bag): `off | local | model`. Photos states the
 * `local` promise to the member in so many words — "what leaves the device:
 * nothing". Nothing on the execution path used to read that tier, so the
 * promise was copy, not behaviour. This module is the rule; `runFire` is the
 * choke point that applies it, and a host supplies the tier through
 * `RunFireOptions.resolveEnrichPolicy`.
 *
 * WHAT "LOCAL" MEANS IN THIS RUNTIME — the strictest honest reading.
 *
 * There is no local model provider here. `ctx.agent` dispatches through the
 * runner registry (`RUNNER_KINDS` in app-engine: codex, claude-code, gemini,
 * qwen, opencode, grok, kimi, copilot, cursor, kilo, cline, goose, auggie,
 * vibe, droid, pi, acp) — every one of them a coding-agent harness that talks
 * to a remote provider, which is why the dispatcher gates each call behind
 * PROVIDER EGRESS consent (#567). "The gateway's own process" is NOT local
 * for this promise either: the gateway is the thing that performs the egress.
 *
 * The one lane in this runtime that genuinely keeps bytes on the member's
 * devices is the device work-lease lane (`enrich_request.required_capability`
 * + `packages/vault/src/enrich/leases.ts`, docs/decisions.md "Local OCR":
 * iOS Vision / Android ML Kit / a local Tesseract-compatible worker, "No
 * image or recognized text leaves the user's devices"). Deterministic
 * in-process work (phash, clustering, trip grouping) is local in the same
 * sense: it never leaves the gateway host and never reaches a provider.
 *
 * So `local` means: this fire may do deterministic and device-lease work, and
 * may NOT take a model turn. An automation that declares `enrich.lane:
 * "model"` is refused before it starts; one that declares `"device"` runs
 * with `ctx.agent` sealed shut (the backstop in `runFire`), so a handler that
 * quietly reaches for a model turn fails loudly instead of egressing.
 *
 * CONSEQUENCE, stated rather than papered over: under `local` every
 * model-routed enricher shipped in blueprints (photo-captioner,
 * face-proposer, screenshot-extractor, doc-text-extractor, doc-entity-linker,
 * doc-filer, obligation-extractor) stops running. `local` is the seeded
 * default. That is the correct behaviour for the promise as written — a vault
 * that has not opted into egress does not get model enrichment — and the
 * honest fix is a real on-device lane, not a looser gate.
 */

/** The owner's standing tier for one enrichment domain. */
export const ENRICH_TIERS = ["off", "local", "model"] as const;
export type EnrichTier = (typeof ENRICH_TIERS)[number];

/** The domains `enrich_policy` is keyed by. */
export const ENRICH_DOMAINS = ["photos", "docs"] as const;
export type EnrichDomain = (typeof ENRICH_DOMAINS)[number];

/**
 * Which lane an enricher's work runs in. `model` needs a `ctx.agent` turn
 * through the runner registry (= provider egress). `device` is deterministic
 * and/or device-lease work that never reaches a provider. Manifests that omit
 * it are read as `model` — assuming the cheaper lane would be assuming
 * consent.
 */
export const ENRICH_LANES = ["model", "device"] as const;
export type EnrichLane = (typeof ENRICH_LANES)[number];

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
       * True under `local`: the fire may run, but every `ctx.agent` call must
       * be refused. `runFire` wraps the dispatch surface accordingly.
       */
      readonly sealModelTurns: boolean;
    }
  | { readonly allowed: false; readonly reason: string };

/**
 * Apply the tier to one enrichment fire. Pure — the host reads the tier, this
 * decides, `runFire` refuses or seals.
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
  if (input.tier === "off") {
    return {
      allowed: false,
      reason: `${who} refused: enrichment is switched off for "${input.domain}" in this vault's privacy settings.`,
    };
  }
  if (input.tier === "local") {
    if (input.lane === "model") {
      return {
        allowed: false,
        reason:
          `${who} refused: enrichment for "${input.domain}" is set to "local", and this enricher takes a model ` +
          `turn through the runner registry — every runner in this runtime is a remote provider, so the run ` +
          `would send data off this device. Set the tier to "model" to allow that, or use an on-device lane.`,
      };
    }
    return { allowed: true, sealModelTurns: true };
  }
  return { allowed: true, sealModelTurns: false };
}

/** What a `ctx.agent` call is told when the `local` tier sealed model turns. */
export function sealedModelTurnReason(
  automationRef: string,
  domain: EnrichDomain
): string {
  return (
    `${automationRef}: ctx.agent is refused — enrichment for "${domain}" is set to "local" in this vault, ` +
    `and a model turn in this runtime always routes to a remote provider.`
  );
}
