/*
 * The enrichment-tier vocabulary, client side.
 *
 * Deliberately its OWN module with no imports: the settings screen that
 * renders the tier is a pure component, and pulling this vocabulary out of
 * `gateway-client-vault.ts` would drag the whole authenticated transport (and
 * its `window.CentraidApi` requirement) into a render test.
 *
 * These three values are a mirror of the vault's enum
 * (`packages/vault/src/host.ts` `EnrichTier`, CHECK-constrained in
 * `enrich_policy`'s DDL) and of the gate's
 * (`packages/server/src/automation/fire/enrich-gate.ts`). They are restated rather
 * than imported because the client does not depend on either package; the
 * route rejects anything outside the enum with a 400, so a drift here fails
 * loudly at the seam instead of silently widening what the owner may set.
 *
 * Renamed `off | local | model` → `off | device | gateway` by issue #712 C5:
 * one axis, three points, ordered by how far enrichment may run — `device`
 * is the member's own phone/laptop (plus deterministic gateway work),
 * `gateway` is the member's own gateway doing whatever it is already wired
 * to. There is no separate `provider` tier; a third-party provider seeing
 * bytes is gated per call (#567) and per capability (decision S9),
 * independently of this tier.
 */

/** The owner's standing tier for one enrichment domain. */
export type EnrichTier = "off" | "device" | "gateway";

/** Every domain the tier is authored per. Order is the render order. */
export const ENRICH_DOMAINS = ["photos", "docs"] as const;
export type EnrichDomain = (typeof ENRICH_DOMAINS)[number];

export type EnrichPolicy = Record<EnrichDomain, EnrichTier>;

/*
 * The policy CASCADE (issue #807), same restatement discipline as the tier
 * above: mirrors of `packages/vault/src/enrich/policy-rules.ts`, kept here so
 * a settings screen can render a rule without importing the transport. The
 * route 400s anything outside these enums.
 */

/** The cascade levels, least to most specific. Order is the cascade order. */
export const ENRICH_SCOPE_TYPES = [
  "vault",
  "domain",
  "collection",
  "item",
] as const;
export type EnrichScopeType = (typeof ENRICH_SCOPE_TYPES)[number];

/** When a capability's work is offered at a scope. */
export const ENRICH_TRIGGERS = ["on-ingest", "on-view", "on-demand"] as const;
export type EnrichTrigger = (typeof ENRICH_TRIGGERS)[number];

/** One level of the cascade. `ref` is `''` at vault scope. */
export interface EnrichScope {
  type: EnrichScopeType;
  ref: string;
}

/** What one scope decides about one capability; `null` means inherit. */
export interface EnrichPolicyRule {
  scope: EnrichScope;
  capability: string;
  enabled: boolean | null;
  profile: string | null;
  trigger: EnrichTrigger | null;
  updatedAt: string;
}

/** How far work may go — the tier's semantics, as an egress ceiling. */
export type EnrichEgressCeiling = "off" | "on-device" | "gateway" | "provider";

/**
 * How far an engine's work travels — a fact about the ENGINE, never about who
 * asked. Mirrors `packages/vault/src/enrich/egress-consent.ts`.
 */
export const ENRICH_EGRESS_CLASSES = [
  "on-device",
  "gateway",
  "provider",
] as const;
export type EnrichEgressClass = (typeof ENRICH_EGRESS_CLASSES)[number];

/**
 * ONE ANSWERED QUESTION in the egress-consent ledger (issue #807, Wave 3):
 * did the member ever agree that work for this capability may run on an engine
 * that reaches this far. A `declined` row is an ANSWER, kept on purpose — the
 * Privacy audit shows both, because "asked and told no" and "never asked" are
 * different facts and the second is not a grant either.
 */
export interface EnrichConsentRecord {
  capability: string;
  egress: EnrichEgressClass;
  /** `''` when the answer covers the whole vault. */
  scopeRef: string;
  decision: "granted" | "declined";
  decidedAt: string;
  /** The `consent_receipt` this answer was receipted by, when one is linked. */
  receiptId: string | null;
}

/**
 * What the gateway's ONE resolver folds the cascade into. Reported by
 * `GET /_vault/enrich/effective`; it is a report, never permission — the
 * runtime gate decides, and this is what it would see.
 */
export interface ResolvedEnrichPolicy {
  capability: string;
  enabled: boolean;
  profileId: string;
  trigger: EnrichTrigger;
  egressCeiling: EnrichEgressCeiling;
}

/**
 * How a profile computes its capability, as `GET /_enrich/profiles` reports it
 * (mirror of `packages/server/src/enrich/engine-profiles.ts`). `harness` is a
 * gateway-supplied string, never an enum this client closes over.
 */
export type EnrichEngine =
  | { kind: "built-in" }
  | {
      kind: "delegate";
      harness: string;
      model?: string;
      configPins?: Record<string, string>;
      promptRev?: string;
    };

/**
 * One named binding of a capability to an engine. `egress` is COMPUTED by the
 * gateway from the engine, so every surface renders it and none offers to set
 * it — there is no knob that tells the runtime a provider is on-device.
 */
export interface EnrichEngineProfile {
  id: string;
  label: string;
  capability: string;
  engine: EnrichEngine;
  egress: EnrichEgressClass;
  builtIn: boolean;
}

/*
 * The member-facing WORDS for the vocabulary above. Restated from the phone's
 * Settings → Enrichment (apps/mobile/src/screens/settings/EnrichmentSection.tsx)
 * rather than shared, because mobile depends on no client package — the two
 * lists must read identically, and a divergence between them is a bug.
 */

/** Member-facing name of each domain. */
export const ENRICH_DOMAIN_LABELS: Readonly<Record<EnrichDomain, string>> = {
  docs: "Documents",
  photos: "Photos",
};

/** Member-facing name of each capability; registry ids are contract keys. */
export const ENRICH_CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  "doc-entities": "Names, dates and amounts",
  "doc-filing": "Filing suggestions",
  "doc-text": "Text in documents",
  "embed-image": "Photo search",
  "embed-text": "Document search",
  faces: "Faces",
  obligations: "Dates and deadlines",
  ocr: "Text in photos",
  transcript: "Video and audio transcripts",
};

/** Where an engine's work happens, in the member's words. */
export const ENRICH_EGRESS_WORDS: Readonly<Record<EnrichEgressClass, string>> =
  {
    gateway: "on your gateway",
    "on-device": "on this device",
    provider: "sent to a provider",
  };

/** The same axis as a CEILING — a limit, not a fact about where work runs. */
export const ENRICH_CEILING_WORDS: Readonly<
  Record<EnrichEgressCeiling, string>
> = {
  gateway: "no further than your gateway",
  off: "nothing runs",
  "on-device": "no further than this device",
  provider: "may be sent to a provider",
};

/** When the work is offered, in the member's words. */
export const ENRICH_TRIGGER_WORDS: Readonly<Record<EnrichTrigger, string>> = {
  "on-demand": "when you ask",
  "on-ingest": "as items arrive",
  "on-view": "when you open an item",
};

/** The tier axis in the member's words — how far work may go by default. */
export const ENRICH_TIER_WORDS: Readonly<Record<EnrichTier, string>> = {
  device: "On this device",
  gateway: "On your gateway",
  off: "Off",
};

/** Which domain each capability's data shape belongs to. */
export const ENRICH_CAPABILITY_DOMAIN: Readonly<Record<string, EnrichDomain>> =
  {
    "doc-entities": "docs",
    "doc-filing": "docs",
    "doc-text": "docs",
    "embed-image": "photos",
    "embed-text": "docs",
    faces: "photos",
    obligations: "docs",
    ocr: "photos",
    transcript: "photos",
  };
